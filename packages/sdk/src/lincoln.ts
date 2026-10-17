// High-level agent API: one object per agent wallet and network. Every spend goes quote → (policy) →
// execute, so an agent always sees the fee and the minimum it receives before committing, and the
// local spending policy is checked in one place for the SDK, the CLI and the MCP server.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createWalletClient, formatUnits, http, isAddress, parseUnits, type Hex } from 'viem';
import { gcm } from '@noble/ciphers/aes.js';
import * as sdk from './core/sdk.js';
import { NET, type NetworkInfo, type NetworkName } from './core/network.js';
import { POOLS, chain, explorerTx, findPool, publicClient, selectNetwork, type PoolInfo } from './core/pools.js';
import { loadPoolState } from './core/state.js';
import { RelayError, getJob, quoteMinOut, quoteOut, relayConfig, relayHealth, type Quote as RelayQuote } from './core/relay.js';
import { exitFee, feePolicy, loadServiceFees, relayFee, transferFee } from './core/fees.js';
import { deposit, getQuote, inspect, spend, swap, type OpStage } from './core/operations.js';
import { setCircuitCache } from './core/prover.js';
import { createKey, readKeyFile, unlockKey, walletKeys, writePrivate } from './core/keystore.js';
import { decodeReceiver, encodeReceivers } from './core/receiver-code.js';
import { checkPolicy, readPolicy, writeDefaultPolicy, type Policy } from './core/policy.js';
import { usdPrice } from './core/prices.js';
import { poolCaps, capError, swapCapCheck, swapCapMessage } from './core/caps.js';
import { BRIDGE_DONE, bridgeLive, bridgeRoute, bridgeStatus, findChain, nudgeBridge, quoteBridge, DEST_CHAINS } from './core/bridge.js';
import type { PrivateKeyAccount } from 'viem/accounts';

export type { OpStage };
export type Action = 'send' | 'swap' | 'withdraw' | 'deposit';

/** Errors with a stable code agents can branch on. */
export class LincolnError extends Error {
  constructor(public code: string, message: string, public details?: Record<string, unknown>) { super(message); }
}

export interface OpenOptions {
  network?: NetworkName;
  /** Wallet directory; default $LINCOLN_HOME or ~/.lincoln. Each network has its own subdirectory. */
  home?: string;
  /** Passphrase for an encrypted agent key; default $LINCOLN_PASSPHRASE. */
  passphrase?: string;
  /** init only: allow an unencrypted key on mainnet (testnet always allows it). */
  allowPlaintextKey?: boolean;
  rpc?: string;
  /** Lincoln app origin serving relays, bridge proxy and circuit files. */
  app?: string;
}

export interface Balance { asset: string; pool: string; decimals: number; ready: string; waiting: string; total: string; readyRaw: string; waitingRaw: string; readyAt?: string; error?: string }

export interface QuoteRecord {
  id: string; action: Action; network: NetworkName; createdAt: string; expiresAt: string;
  asset: string; pool: string; decimals: number; amount: string; amountRaw: string;
  /** What the other side receives (send/withdraw/deposit) or the minimum out (swap). */
  receives: string; receivesAsset: string; minReceives?: string;
  fee: string; feeAsset: string;
  to?: string; chain?: string; toAsset?: string; toPool?: string;
  routeId?: string; relayQuote?: RelayQuote;
  usd: number | null;
  /** The policy verdict at quote time; execute re-checks it. */
  policy: { allowed: boolean; needsApproval: boolean; code?: string; reason?: string };
  notes: string[];
}

export interface ExecResult { quoteId: string; action: Action; jobId?: string; txHash: string; explorer: string; bridge?: { status: string; txHashes?: string[] }; message: string }
interface ActivityRow { at: string; quoteId: string; action: Action; pool: string; asset: string; amount: string; usd: number | null; jobId?: string; txHash?: string; status: 'submitted' | 'confirmed' | 'failed'; error?: string }

const QUOTE_TTL_MS = 10 * 60_000;
const ROUND_TIP = 'Standard amounts (e.g. 0.1 ETH, 100 USDG, 1 NVDA) blend in; an unusual amount can be matched to a deposit. Split into standard amounts with private sends to yourself, and withdraw them at different times.';
const fmt = (v: bigint, decimals: number) => {
  const s = formatUnits(v, decimals);
  const [i, f = ''] = s.split('.');
  return f ? `${i}.${f.slice(0, Math.min(decimals, 8)).replace(/0+$/, '')}`.replace(/\.$/, '') : i;
};
const parseAmount = (amount: string, pool: PoolInfo) => {
  let v: bigint;
  try { v = parseUnits(String(amount).trim(), pool.decimals); } catch { throw new LincolnError('INVALID_AMOUNT', `"${amount}" is not a valid ${pool.symbol} amount.`); }
  if (v <= 0n) throw new LincolnError('INVALID_AMOUNT', 'Amount must be greater than zero.');
  return v;
};

export function paths(home: string, network: NetworkName) {
  const dir = join(home, network);
  return { dir, key: join(dir, 'agent.json'), notes: join(dir, 'notes.json'), quotes: join(dir, 'quotes.json'), activity: join(dir, 'activity.json'), policy: join(home, 'policy.json'), circuits: join(home, 'circuits') };
}
const defaultHome = () => process.env.LINCOLN_HOME?.replace(/^~(?=$|\/)/, homedir()) ?? join(homedir(), '.lincoln');
const readJson = async <T,>(file: string, fallback: T): Promise<T> => { const t = await readFile(file, 'utf8').catch(() => null); return t ? JSON.parse(t) as T : fallback; };
// Quotes and activity name amounts, recipients and job IDs: kept encrypted with the wallet's cache key, like notes.
async function readSealed<T>(file: string, key: Uint8Array, fallback: T): Promise<T> {
  const box = await readJson<{ iv?: string; data?: string } | T>(file, fallback);
  if (!box || typeof box !== 'object' || !('iv' in box) || !('data' in box)) return (box as T) ?? fallback; // legacy plain file
  try { return JSON.parse(new TextDecoder().decode(gcm(key, sdk.fromHex(box.iv!)).decrypt(sdk.fromHex(box.data!)))) as T; } catch { return fallback; }
}
async function writeSealed(file: string, key: Uint8Array, value: unknown) {
  const iv = randomBytes(12);
  await writePrivate(file, JSON.stringify({ iv: sdk.toHex(iv), data: sdk.toHex(gcm(key, iv).encrypt(new TextEncoder().encode(JSON.stringify(value)))) }));
}

export class Lincoln {
  private constructor(
    readonly net: NetworkInfo, readonly home: string, private readonly files: ReturnType<typeof paths>,
    private readonly signer: PrivateKeyAccount, private readonly account: sdk.Account, private readonly cacheKey: Uint8Array,
  ) {}

  /** Creates the agent wallet for a network (and a default policy if there is none). */
  static async init(opts: OpenOptions = {}) {
    const network = opts.network ?? (process.env.LINCOLN_NETWORK as NetworkName | undefined) ?? 'mainnet', home = opts.home ?? defaultHome(), files = paths(home, network);
    const net = selectNetwork(network, opts);
    const passphrase = opts.passphrase ?? process.env.LINCOLN_PASSPHRASE;
    if (!passphrase && !net.testnet && !opts.allowPlaintextKey) throw new LincolnError('PASSPHRASE_REQUIRED', 'Set LINCOLN_PASSPHRASE to encrypt the mainnet agent key (or pass --insecure-plaintext-key for a throwaway test wallet).');
    const kf = await createKey(files.key, net.id, passphrase || undefined);
    if (!(await readFile(files.policy).then(() => true, () => false))) await writeDefaultPolicy(files.policy);
    const lincoln = await Lincoln.open({ ...opts, network, home, passphrase });
    return { lincoln, keyFile: files.key, encrypted: 'sealed' in kf.key, policyFile: files.policy };
  }

  static async open(opts: OpenOptions = {}): Promise<Lincoln> {
    const network = opts.network ?? (process.env.LINCOLN_NETWORK as NetworkName | undefined) ?? 'mainnet';
    const home = opts.home ?? defaultHome(), files = paths(home, network);
    const net = selectNetwork(network, { rpc: opts.rpc ?? process.env.LINCOLN_RPC, app: opts.app ?? process.env.LINCOLN_APP });
    setCircuitCache(files.circuits);
    const kf = await readKeyFile(files.key);
    if (!kf) throw new LincolnError('NO_WALLET', `No agent wallet for ${net.label}. Run \`lincoln init\` first.`);
    if (kf.chainId !== net.id) throw new LincolnError('WRONG_NETWORK', `${files.key} belongs to chain ${kf.chainId}, not ${net.id}.`);
    const signer = await unlockKey(kf, opts.passphrase ?? process.env.LINCOLN_PASSPHRASE);
    const keys = await walletKeys(kf, signer, net);
    const account = sdk.createAccount(keys.seed);
    // Change notes saved before a broadcast, so a crash mid-flight can't lose them.
    const cached = await readJson<{ iv: string; data: string } | null>(files.notes, null);
    if (cached) {
      try { account.notes = JSON.parse(new TextDecoder().decode(gcm(keys.cacheKey, sdk.fromHex(cached.iv)).decrypt(sdk.fromHex(cached.data)))).notes ?? []; }
      catch { /* unreadable cache: notes are recovered from chain state anyway */ }
    }
    return new Lincoln(net, home, files, signer, account, keys.cacheKey);
  }

  get network() { return this.net.name; }
  /** The agent's public wallet: funds deposits and pays their gas. Using it links deposits to it. */
  get publicAddress(): Hex { return this.signer.address; }
  /** The agent's reusable private address. Safe to share: it can receive, never spend. */
  get privateAddress(): string { return encodeReceivers(Object.values(POOLS).map(p => sdk.receiverAddress(this.account, p.profile))); }
  get pools() { return Object.values(POOLS).map(p => ({ id: p.id, asset: p.symbol, kind: p.kind, decimals: p.decimals, address: p.profile.pool.address, routes: p.routes.map(r => POOLS[r.target]?.symbol ?? r.target) })); }
  policy(): Promise<Policy> { return readPolicy(this.files.policy); }

  private async persistNotes(account: sdk.Account) {
    const iv = randomBytes(12);
    const data = gcm(this.cacheKey, iv).encrypt(new TextEncoder().encode(JSON.stringify({ notes: account.notes })));
    await writePrivate(this.files.notes, JSON.stringify({ iv: sdk.toHex(iv), data: sdk.toHex(data) }));
  }

  /** Ready (spendable now) and waiting balances per asset. */
  async balances(): Promise<Balance[]> {
    const health = await relayHealth('eth').catch(() => null);
    // The provider publishes a new set once new deposits exist, at most every interval: if the earliest
    // next round is already past, the next one comes about an interval from now.
    const interval = health?.minPublishIntervalSeconds, now = Date.now() / 1000;
    const next = health?.lastPublicationTimestamp && interval
      ? new Date(Math.max(Number(health.lastPublicationTimestamp) + interval, now + interval) * 1000).toISOString() : undefined;
    return Promise.all(Object.values(POOLS).map(async p => {
      try {
        const h = inspect(this.account, p.id, await loadPoolState(p.id));
        return { asset: p.symbol, pool: p.id, decimals: p.decimals, ready: fmt(h.spendable, p.decimals), waiting: fmt(h.balance - h.spendable, p.decimals), total: fmt(h.balance, p.decimals),
          readyRaw: String(h.spendable), waitingRaw: String(h.balance - h.spendable), ...(h.balance > h.spendable && next ? { readyAt: next } : {}) };
      } catch (e) {
        return { asset: p.symbol, pool: p.id, decimals: p.decimals, ready: '0', waiting: '0', total: '0', readyRaw: '0', waitingRaw: '0', error: (e as Error).message };
      }
    }));
  }

  private async spentTodayUsd() {
    const since = Date.now() - 24 * 3600_000;
    return (await readSealed<ActivityRow[]>(this.files.activity, this.cacheKey, [])).filter(r => r.status !== 'failed' && Date.parse(r.at) > since).reduce((t, r) => t + (r.usd ?? 0), 0);
  }
  private async record(row: ActivityRow) {
    const rows = await readSealed<ActivityRow[]>(this.files.activity, this.cacheKey, []);
    const i = rows.findIndex(r => r.quoteId === row.quoteId);
    if (i >= 0) rows[i] = row; else rows.push(row);
    await writeSealed(this.files.activity, this.cacheKey, rows.slice(-500));
  }
  async activity(limit = 20): Promise<ActivityRow[]> { return (await readSealed<ActivityRow[]>(this.files.activity, this.cacheKey, [])).slice(-limit).reverse(); }

  private async finishQuote(q: Omit<QuoteRecord, 'id' | 'network' | 'createdAt' | 'expiresAt' | 'usd' | 'policy'> & { expiresAt?: number }, pool: PoolInfo, raw: bigint, recipient?: string): Promise<QuoteRecord> {
    const price = await usdPrice(pool.symbol, pool.kind);
    const usd = price === null ? null : Math.round(Number(formatUnits(raw, pool.decimals)) * price * 100) / 100;
    const policy = checkPolicy(await this.policy(), { action: q.action, usd, recipient, spentTodayUsd: await this.spentTodayUsd() });
    const now = Date.now();
    const { expiresAt, ...rest } = q;
    const record: QuoteRecord = { id: `q_${randomBytes(4).toString('hex')}`, network: this.net.name, createdAt: new Date(now).toISOString(),
      expiresAt: new Date(Math.min(expiresAt ?? Infinity, now + QUOTE_TTL_MS)).toISOString(), ...rest, usd, policy };
    const quotes = await readSealed<Record<string, QuoteRecord>>(this.files.quotes, this.cacheKey, {});
    for (const [id, old] of Object.entries(quotes)) if (Date.parse(old.expiresAt) < now - 3600_000) delete quotes[id];
    quotes[record.id] = record;
    await writeSealed(this.files.quotes, this.cacheKey, quotes);
    return record;
  }

  private async ready(pool: PoolInfo, raw: bigint) {
    const h = inspect(this.account, pool.id, await loadPoolState(pool.id));
    if (raw > h.spendable) {
      if (raw <= h.balance) throw new LincolnError('NOT_READY', `Only ${fmt(h.spendable, pool.decimals)} ${pool.symbol} is ready; ${fmt(h.balance - h.spendable, pool.decimals)} is still waiting to become spendable.`);
      throw new LincolnError('INSUFFICIENT_BALANCE', `The private balance has ${fmt(h.balance, pool.decimals)} ${pool.symbol}.`);
    }
  }

  /** Private payment to a lincoln3: address. */
  async quoteSend({ asset, amount, to }: { asset: string; amount: string; to: string }): Promise<QuoteRecord> {
    const pool = findPool(asset), raw = parseAmount(amount, pool);
    try { decodeReceiver(to, pool.id); } catch (e) { throw new LincolnError('INVALID_RECIPIENT', (e as Error).message); }
    await loadServiceFees(pool.id, relayConfig);
    const fee = transferFee(pool.id);
    await this.ready(pool, raw + fee);
    return this.finishQuote({ action: 'send', asset: pool.symbol, pool: pool.id, decimals: pool.decimals, amount: fmt(raw, pool.decimals), amountRaw: String(raw),
      receives: fmt(raw, pool.decimals), receivesAsset: pool.symbol, fee: fmt(fee, pool.decimals), feeAsset: pool.symbol, to: to.trim(),
      notes: ['Amount, sender and recipient stay hidden on chain.', ...(fee > 0n ? [`The fee is paid on top of the amount.`] : [])] }, pool, raw, to);
  }

  /** Withdrawal to a 0x address on Robinhood Chain, or on Base, Arbitrum, Ethereum or Optimism via Relay. */
  async quoteWithdraw({ asset, amount, to, chain: dest }: { asset: string; amount: string; to: string; chain?: string }): Promise<QuoteRecord> {
    const pool = findPool(asset), raw = parseAmount(amount, pool);
    if (!isAddress(to.trim())) throw new LincolnError('INVALID_RECIPIENT', 'Enter a 0x address.');
    await loadServiceFees(pool.id, relayConfig);
    const fee = relayFee(pool.id, raw);
    if (fee >= raw) throw new LincolnError('AMOUNT_TOO_SMALL', 'Amount is too small to cover the relayer fee.');
    await this.ready(pool, raw);
    const base = { action: 'withdraw' as const, asset: pool.symbol, pool: pool.id, decimals: pool.decimals, amount: fmt(raw, pool.decimals), amountRaw: String(raw), fee: fmt(fee, pool.decimals), feeAsset: pool.symbol, to: to.trim() };
    const robinhoodChain = !dest || ['robinhood', 'hood', String(this.net.id)].includes(dest.toLowerCase());
    if (robinhoodChain) {
      return this.finishQuote({ ...base, receives: fmt(raw - fee, pool.decimals), receivesAsset: pool.symbol,
        notes: ['The recipient and amount become public; which deposit paid for it stays hidden.', ROUND_TIP] }, pool, raw, to);
    }
    const target = findChain(dest!);
    if (!target) throw new LincolnError('UNKNOWN_CHAIN', `Unknown chain "${dest}". Use robinhood, ${DEST_CHAINS.map(c => c.name.toLowerCase()).join(', ')}.`);
    const route = bridgeRoute(pool, target);
    if (!route) throw new LincolnError('NOT_BRIDGEABLE', `${pool.symbol} can't be bridged; swap it to ETH or USDG first.`);
    const q = await quoteBridge({ pool, dest: target, amount: raw - fee, recipient: to.trim(), refundTo: to.trim(), live: false });
    return this.finishQuote({ ...base, chain: target.name, receives: q.amountOutFormatted, receivesAsset: route.symbol, minReceives: fmt(BigInt(q.minAmountOut), route.decimals),
      notes: [`Bridged to ${target.name} by Relay in ~${Math.max(1, q.timeEstimate)}s. Refunds, if the bridge can't fill, go to the same address on Robinhood Chain.`,
        ...(bridgeLive() ? [] : ['Testnet: this is a preview with live mainnet prices and cannot be executed.'])] }, pool, raw, to);
  }

  /** Private swap inside the pool: from one asset's balance into another's, best route by output. */
  async quoteSwap({ from, to, amount, slippageBps = 100 }: { from: string; to: string; amount: string; slippageBps?: number }): Promise<QuoteRecord> {
    const pool = findPool(from), target = findPool(to), raw = parseAmount(amount, pool);
    const routes = pool.routes.filter(r => r.target === target.id);
    if (!routes.length) throw new LincolnError('NO_ROUTE', `No swap route from ${pool.symbol} to ${target.symbol}. Routes: ${pool.routes.map(r => POOLS[r.target]?.symbol).join(', ') || 'none'}.`);
    await this.ready(pool, raw);
    // One after another: the relay admits only a few quotes at once per pool.
    const quotes: RelayQuote[] = [];
    for (const r of routes) { const q = await getQuote(pool.id, r.id, raw, slippageBps).catch(() => null); if (q) quotes.push(q); }
    const best = quotes.sort((a, b) => (quoteOut(b) > quoteOut(a) ? 1 : -1))[0];
    if (!best) throw new LincolnError('QUOTE_UNAVAILABLE', 'No quote right now. Try again shortly.');
    const caps = await poolCaps(target.id).catch(() => { throw new LincolnError('CAPS_UNAVAILABLE', `Couldn’t read the ${target.symbol} pool’s deposit limits from the chain (a read error, not a closed pool). Try again shortly.`); });
    // The output enters the target pool like a deposit; its limits are in target tokens. Refuse here, before
    // a proof, and say the largest input that fits (an oversized swap would revert after paying gas).
    const check = swapCapCheck(caps, raw, quoteOut(best));
    if (!check.ok) throw new LincolnError(check.reason === 'paused' ? 'DEPOSITS_PAUSED' : 'CAP_EXCEEDED',
      swapCapMessage(check, target, pool, v => fmt(v, target.decimals), v => fmt(v, pool.decimals)),
      { maxOut: fmt(check.maxOut, target.decimals), maxIn: fmt(check.maxIn, pool.decimals) });
    const feeOut = best.netQuote ? BigInt(best.netQuote.serviceFeeAmount) : 0n;
    return this.finishQuote({ action: 'swap', asset: pool.symbol, pool: pool.id, decimals: pool.decimals, amount: fmt(raw, pool.decimals), amountRaw: String(raw),
      receives: fmt(quoteOut(best), target.decimals), minReceives: fmt(quoteMinOut(best), target.decimals), receivesAsset: target.symbol,
      fee: best.netQuote ? `${(best.netQuote.serviceFeeBps / 100)}% · ${fmt(feeOut, target.decimals)}` : '0', feeAsset: best.netQuote ? target.symbol : pool.symbol, toAsset: target.symbol, toPool: target.id, routeId: best.routeId, relayQuote: best,
      expiresAt: Number(best.deadline) * 1000,
      notes: [`Via ${best.protocol}, ${slippageBps / 100}% max slippage. The DEX trade is public; whose balance paid is not. The output is ready to spend in about a minute.`] }, pool, raw);
  }

  /** Public deposit from the agent's own wallet (visible on chain: funding address and amount). */
  async quoteDeposit({ asset, amount }: { asset: string; amount: string }): Promise<QuoteRecord> {
    const pool = findPool(asset), raw = parseAmount(amount, pool);
    const caps = await poolCaps(pool.id).catch(() => { throw new LincolnError('CAPS_UNAVAILABLE', `Couldn’t read the ${pool.symbol} pool’s deposit limits from the chain (a read error, not a closed pool). Try again shortly.`); });
    const capped = capError(caps, raw, pool.symbol, v => fmt(v, pool.decimals));
    if (capped) throw new LincolnError(caps?.paused ? 'DEPOSITS_PAUSED' : 'CAP_EXCEEDED', capped);
    return this.finishQuote({ action: 'deposit', asset: pool.symbol, pool: pool.id, decimals: pool.decimals, amount: fmt(raw, pool.decimals), amountRaw: String(raw),
      receives: fmt(raw, pool.decimals), receivesAsset: pool.symbol, fee: '0', feeAsset: pool.symbol,
      notes: [`Public: ${this.publicAddress} and the amount appear on chain. Prefer a private send from the owner's Lincoln balance.`, 'Network gas is paid from the agent wallet.'] }, pool, raw);
  }

  async getQuote(id: string): Promise<QuoteRecord> {
    const q = (await readSealed<Record<string, QuoteRecord>>(this.files.quotes, this.cacheKey, {}))[id];
    if (!q) throw new LincolnError('UNKNOWN_QUOTE', `No quote ${id}. Quote again.`);
    return q;
  }

  /** Executes a quote. Re-checks the policy; spends that need approval require `approved: true`, set only after the user agreed. */
  async execute(id: string, { approved = false, onStage, onSubmitted }: { approved?: boolean; onStage?: (s: OpStage) => void; onSubmitted?: (ref: { jobId?: string; hash?: string }) => void } = {}): Promise<ExecResult> {
    const q = await this.getQuote(id);
    if (q.network !== this.net.name) throw new LincolnError('WRONG_NETWORK', `Quote ${id} is for ${q.network}.`);
    if (Date.parse(q.expiresAt) < Date.now()) throw new LincolnError('QUOTE_EXPIRED', `Quote ${id} expired. Quote again.`);
    const used = (await readSealed<ActivityRow[]>(this.files.activity, this.cacheKey, [])).find(r => r.quoteId === id && r.status !== 'failed');
    if (used) throw new LincolnError('QUOTE_USED', `Quote ${id} was already executed${used.jobId ? ` (job ${used.jobId})` : ''}. Check its status instead of executing again.`);
    const check = checkPolicy(await this.policy(), { action: q.action, usd: q.usd, recipient: q.to, spentTodayUsd: await this.spentTodayUsd() });
    if (!check.allowed) throw new LincolnError(check.code!, check.reason!);
    if (check.needsApproval && !approved) throw new LincolnError('APPROVAL_REQUIRED', q.usd === null
      ? 'This asset has no USD price, so the spend needs the user’s approval.'
      : `$${q.usd.toFixed(2)} is above the approval threshold. Ask the user, then execute with approval.`, { quoteId: id, usd: q.usd });

    const pool = POOLS[q.pool], raw = BigInt(q.amountRaw);
    const row: ActivityRow = { at: new Date().toISOString(), quoteId: id, action: q.action, pool: q.pool, asset: q.asset, amount: q.amount, usd: q.usd, status: 'submitted' };
    const persist = (a: sdk.Account) => this.persistNotes(a);
    const submitted = (ref: { jobId?: string; hash?: string }) => { Object.assign(row, ref.jobId ? { jobId: ref.jobId } : {}, ref.hash ? { txHash: ref.hash } : {}); void this.record(row); onSubmitted?.(ref); };
    try {
      let result: { hash: Hex; jobId?: string }, bridge: ExecResult['bridge'], message: string;
      if (q.action === 'send') {
        const receiver = decodeReceiver(q.to!, q.pool);
        result = await spend({ account: this.account, pool: q.pool, amount: raw, receiver, onStage, persist, onSubmitted: submitted });
        message = `Sent ${q.amount} ${q.asset} privately.`;
      } else if (q.action === 'withdraw' && !q.chain) {
        result = await spend({ account: this.account, pool: q.pool, amount: raw, recipient: q.to, onStage, persist, onSubmitted: submitted });
        message = `Withdrew ${q.receives} ${q.asset} to ${q.to}.`;
      } else if (q.action === 'withdraw') {
        if (!bridgeLive()) throw new LincolnError('BRIDGE_TESTNET', 'Bridging works on Robinhood Chain mainnet only.');
        const target = findChain(q.chain!)!;
        // The bridge must be quoted for exactly what the withdrawal delivers: load the relay's schedule first.
        await loadServiceFees(q.pool, relayConfig);
        const fee = relayFee(q.pool, raw);
        if (fmt(fee, pool.decimals) !== q.fee) throw new LincolnError('QUOTE_MOVED', `The relay fee changed (${fmt(fee, pool.decimals)} ${q.asset}). Quote again.`);
        const live = await quoteBridge({ pool, dest: target, amount: raw - fee, recipient: q.to!, refundTo: q.to!, live: true });
        if (!live.depositAddress || !live.requestId) throw new LincolnError('BRIDGE_UNAVAILABLE', 'The bridge did not return a deposit address.');
        if (q.minReceives && Number(live.amountOutFormatted) < Number(q.minReceives)) throw new LincolnError('QUOTE_MOVED', `The bridge now pays ${live.amountOutFormatted}, below the quoted minimum. Quote again.`);
        result = await spend({ account: this.account, pool: q.pool, amount: raw, recipient: live.depositAddress, onStage, persist, onSubmitted: submitted });
        void nudgeBridge(live.depositAddress);
        let status = 'waiting', hashes: string[] | undefined;
        for (const until = Date.now() + 5 * 60_000; !BRIDGE_DONE.has(status) && Date.now() < until; await new Promise(r => setTimeout(r, 4000))) {
          try { const s = await bridgeStatus(live.requestId); status = s.status; hashes = s.txHashes; } catch { /* keep polling */ }
        }
        bridge = { status, txHashes: hashes };
        message = status === 'success' ? `Delivered ${live.amountOutFormatted} on ${target.name}.` : `Withdrawn to the bridge; bridge status: ${status}.`;
      } else if (q.action === 'swap') {
        const fresh = await getQuote(q.pool, q.routeId!, raw, q.relayQuote!.slippageBPS);
        if (quoteOut(fresh) < quoteMinOut(q.relayQuote!)) throw new LincolnError('QUOTE_MOVED', 'The price moved below the quoted minimum. Quote again.');
        result = await swap({ account: this.account, pool: q.pool, routeId: q.routeId!, quote: fresh, onStage, persist, onSubmitted: submitted });
        message = `Swapped ${q.amount} ${q.asset} for at least ${q.minReceives} ${q.receivesAsset}, privately. It is ready to spend in about a minute.`;
      } else {
        const wallet = createWalletClient({ account: this.signer, chain, transport: http(this.net.rpc) });
        result = await deposit({ account: this.account, pool: q.pool, amount: raw, wallet, onStage, onSubmitted: submitted });
        message = `Deposited ${q.amount} ${q.asset}. It is ready to spend privately in about a minute.`;
      }
      Object.assign(row, { status: 'confirmed', txHash: result.hash, ...(result.jobId ? { jobId: result.jobId } : {}) });
      await this.record(row);
      return { quoteId: id, action: q.action, jobId: result.jobId, txHash: result.hash, explorer: explorerTx(result.hash), bridge, message };
    } catch (e) {
      // A job that may still run is not a failure: keep it as submitted so its status can be followed.
      const mayRun = e instanceof RelayError ? e.mayHaveRun : /Still pending/.test((e as Error).message);
      Object.assign(row, { status: mayRun && row.jobId ? 'submitted' : 'failed', error: (e as Error).message });
      await this.record(row);
      if (e instanceof LincolnError) throw e;
      if (e instanceof RelayError) throw new LincolnError(e.code, e.message, { jobId: row.jobId });
      throw new LincolnError('FAILED', (e as Error).message, { jobId: row.jobId });
    }
  }

  /** Current state of a relay job started by this wallet. */
  async status(jobId: string) {
    const row = (await readSealed<ActivityRow[]>(this.files.activity, this.cacheKey, [])).find(r => r.jobId === jobId);
    if (!row) throw new LincolnError('UNKNOWN_JOB', `No job ${jobId} in this wallet's activity.`);
    const job = await getJob(row.pool, jobId);
    return { jobId, action: row.action, asset: row.asset, amount: row.amount, status: job.status, txHash: job.hash, explorer: job.hash ? explorerTx(job.hash) : undefined };
  }

  /** Public chain view of the agent wallet: native ETH for gas and deposits. */
  async publicBalance() {
    const wei = await publicClient.getBalance({ address: this.publicAddress });
    return { address: this.publicAddress, eth: fmt(wei, 18) };
  }

  /** Fee schedule in effect per pool (from each relay). */
  async fees() {
    return Promise.all(Object.values(POOLS).map(async p => { await loadServiceFees(p.id, relayConfig).catch(() => undefined); const f = feePolicy(p.id); return { asset: p.symbol, label: f.label, withdrawalBps: f.withdrawal.bps, swapBps: f.swapBps }; }));
  }
}

export { NET };
export const supportedChains = () => ['robinhood', ...DEST_CHAINS.map(c => c.name.toLowerCase())];
export { exitFee };
