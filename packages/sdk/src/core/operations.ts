// Pool operations for Node, mirroring the web app (privacy-frontend src/protocol/asp/operations.ts).
// Every spend is proved on this machine and submitted by the relay, so the agent's wallet never
// appears in it. Deposits are public and signed by the agent's own wallet.
import { erc20Abi, type Hex, type WalletClient } from 'viem';
import * as sdk from './sdk.js';
import { POOLS, POOL_ABI, chain, publicClient, type PoolId } from './pools.js';
import { loadPoolState, type PoolState } from './state.js';
import { RETRYABLE, RelayError, newJobId, relayQuote, submitJob, waitForJob, type FeeQuoteKind, type JobKind, type Quote } from './relay.js';
import { prove, type Circuit, type ProofStage } from './prover.js';
import { forgetServiceFees, priceFee, quoteLive, type PricedFee } from './fees.js';
import { minChangeFor } from './denominations.js';

export type OpStage = 'sync' | 'prepare' | ProofStage | 'save' | 'sign' | 'relay' | 'confirm' | 'done';
const ZERO = sdk.NATIVE_ASSET;

export interface OpResult { hash: Hex; jobId?: string }
interface Common {
  account: sdk.Account; pool: PoolId; onStage?: (stage: OpStage) => void;
  /** Runs after change notes are added to `account`, before anything is broadcast. Must persist it. */
  persist?: (account: sdk.Account) => void | Promise<void>;
  /** The job ID, as soon as the relay has it: follow it with `status` if this process stops. */
  onSubmitted?: (ref: { hash?: Hex; jobId?: string }) => void;
}

/** Public deposit from `wallet` with an amount-independent invoice that only `account` can decrypt. */
export async function deposit({ account, pool, amount, wallet, onStage, onSubmitted }: Common & { amount: bigint; wallet: WalletClient }): Promise<OpResult> {
  const info = POOLS[pool], address = info.profile.pool.address as Hex, native = info.profile.pool.asset === ZERO;
  const owner = wallet.account!.address;
  onStage?.('prepare');
  const invoice = sdk.createDynamicReceive(account, info.profile);
  onStage?.('sign');
  if (!native) {
    const token = info.profile.pool.asset as Hex;
    const allowance = await publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, address] });
    if (allowance < amount) {
      const approval = await wallet.writeContract({ account: wallet.account!, chain, address: token, abi: erc20Abi, functionName: 'approve', args: [address, amount] });
      await publicClient.waitForTransactionReceipt({ hash: approval });
    }
  }
  const hash = await wallet.writeContract({
    account: wallet.account!, chain, address, abi: POOL_ABI, functionName: 'depositDynamic', value: native ? amount : 0n,
    args: [amount, invoice.precommitment, invoice.encryptedTemplate],
  });
  onSubmitted?.({ hash });
  onStage?.('confirm');
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error('Deposit reverted on chain.');
  onStage?.('done');
  return { hash };
}

const MAX_REPROVE = 3;
/** What a relayed spend pays: its quote kind and gross amount. `preset` is a fee the caller already priced and
 *  built on (a bridge quoted for exactly what arrives): a fresh quote must then charge the same, or nothing is sent. */
interface Pricing { kind: FeeQuoteKind; gross: bigint; preset?: PricedFee }
type Built = { prepared: { inputSignals: Record<string, unknown>; publicSignals: string[] }; transaction: (proof: unknown) => unknown; beforeSubmit?: () => void | Promise<void>; routeId?: string };
/** Outputs the relay counts for a fee quote: non-zero JoinSplit output commitments; a holder exit has none. */
const outputCount = (circuit: Circuit, prepared: Built['prepared']) => circuit === 'holder-exit' ? 0 : prepared.publicSignals.slice(7, 9).filter(v => BigInt(v) !== 0n).length;
const FEE_REQUOTE = new Set(['FEE_QUOTE_EXPIRED', 'FEE_QUOTE_COST_EXCEEDED', 'FEE_QUOTE_UNKNOWN', 'FEE_QUOTE_REPLAY']);
/** The relay switched between fixed and per-transaction gas pricing since its schedule was read. */
const FEE_MODE_CHANGED = new Set(['FEE_QUOTE_REQUIRED', 'FEE_QUOTE_DISABLED', 'FEE_QUOTE_NOT_APPLICABLE']);

async function relayed(pool: PoolId, kind: JobKind, circuit: Circuit, onStage: Common['onStage'], onSubmitted: Common['onSubmitted'],
  build: (state: PoolState, fee: bigint) => Built, pricing?: Pricing,
): Promise<OpResult> {
  // A pool whose relay is not configured yet (relayer null in its profile) takes deposits only.
  if (!POOLS[pool].relayer) throw new RelayError('RELAY_NOT_LIVE');
  // One ID for the whole operation: a retry after a clear "not created" reuses it (retrySameId), never a new one.
  let id = newJobId();
  let priced: PricedFee | null = pricing?.preset ?? null, gasUnits: bigint | undefined;
  // Dynamic quotes are single use and short lived: a fresh one whenever the last is near expiry or was refused.
  const quote = async (outputs?: number) => {
    const next = await priceFee(pool, pricing!.kind, pricing!.gross, { outputCount: outputs, gasUnits });
    if (pricing!.preset && next.fee !== pricing!.preset.fee) throw new RelayError('FEE_CHANGED');
    return next;
  };
  for (let attempt = 0; ; attempt++) {
    onStage?.('sync');
    const state = await loadPoolState(pool);
    onStage?.('prepare');
    if (pricing && !quoteLive(priced, 30_000)) priced = await quote();
    let built = build(state, priced?.fee ?? 0n);
    if (priced?.quote && outputCount(circuit, built.prepared) !== priced.quote.outputCount) {
      priced = await quote(outputCount(circuit, built.prepared));
      built = build(state, priced.fee);
    }
    const { prepared, transaction, beforeSubmit, routeId } = built;
    const proof = await prove(circuit, prepared, s => onStage?.(s));
    // Proving can outlast a quote; a new one with the same fee keeps this proof, a different fee needs a new proof.
    if (priced?.quote && !quoteLive(priced, 5_000)) {
      const next = await quote(priced.quote.outputCount);
      const same = next.fee === priced.fee; priced = next;
      if (!same) { if (attempt < MAX_REPROVE) continue; throw new RelayError('FEE_CHANGED'); }
    }
    onStage?.('save');
    await beforeSubmit?.();
    onStage?.('relay');
    let unsure = false;
    try {
      await submitJob(pool, { id, kind, ...(routeId ? { routeId } : {}), ...(priced?.quote ? { feeQuoteId: priced.quote.quoteId } : {}), transaction: transaction(proof) });
    } catch (e) {
      // The answer was lost (slow relay, dropped connection, unconfirmed write), not necessarily the job:
      // never resubmit a different payment; follow this job ID until the relay says what happened.
      if (e instanceof RelayError && e.mayHaveRun) unsure = true;
      else if (attempt < MAX_REPROVE && e instanceof RelayError && RETRYABLE.has(e.code) && e.info.retrySameId !== false) continue;
      else if (attempt < MAX_REPROVE && e instanceof RelayError && FEE_REQUOTE.has(e.code) && pricing) {
        // Refused before anything was signed: quote again (with the relay's own gas estimate, if it sent one) and re-prove.
        // A job the relay recorded and then cancelled keeps its ID; the new transaction needs its own.
        if (e.info.retrySameId === false) { if (e.info.jobMayContinue !== false || e.info.transactionHash) throw e; id = newJobId(); }
        if (e.info.feeRequote?.rawGasUnits) gasUnits = BigInt(e.info.feeRequote.rawGasUnits);
        priced = null;
        continue;
      }
      else if (attempt < MAX_REPROVE && e instanceof RelayError && FEE_MODE_CHANGED.has(e.code) && pricing && e.info.retrySameId !== false) {
        forgetServiceFees(pool); priced = null;
        continue;
      }
      else throw e;
    }
    onSubmitted?.({ jobId: id });
    onStage?.('confirm');
    const job = await waitForJob(pool, id, { unsure });
    onStage?.('done');
    return { hash: job.hash as Hex, jobId: id };
  }
}

function requireApprovedSet(state: PoolState) {
  if (state.asp?.expired || !Array.isArray(state.asp?.leaves) || (state.asp as { spendable?: boolean }).spendable === false)
    throw new RelayError('ASP_POLICY_UNAVAILABLE');
}

/** Withdrawal to a public address, or a private send to a Lincoln receiver. Needs approved inputs. */
export async function spend({ account, pool, amount, recipient, receiver, fee: preset, onStage, persist, onSubmitted }: Common & { amount: bigint; recipient?: string; receiver?: sdk.Receiver; fee?: PricedFee }) {
  const info = POOLS[pool];
  // The relay checks the fee to the unit: prove exactly its schedule's fee, or the quote it just gave.
  const pricing: Pricing = receiver ? { kind: 'private-transfer', gross: 0n, preset } : { kind: 'withdrawal', gross: amount, preset };
  return relayed(pool, 'transact', 'joinsplit', onStage, onSubmitted, (state, fee) => {
    requireApprovedSet(state);
    if (fee >= amount && !receiver) throw new Error('Amount is too small to cover the relayer fee.');
    const prepared = sdk.prepareJoinSplit({
      account, profile: info.profile, state,
      outputs: receiver ? [{ receiver, value: amount }] : [],
      // Prefer inputs that leave change; a withdrawal splits larger change into two notes (an exact spend
      // creates no change note, which observers can see).
      change: { minChange: minChangeFor(info), split: !receiver },
      // A private send's fee is its only public output and pays the relayer, so nothing goes to a
      // recipient; the relay still requires a non-zero one whenever there is a public output, so a
      // fee-paying send names the relayer (the same for every send: nothing to link).
      externalData: { recipient: receiver ? (fee > 0n ? info.relayer : ZERO) : recipient ?? ZERO, feeRecipient: fee > 0n ? info.relayer : ZERO, processor: info.relayer, publicIn: 0n, publicOut: receiver ? fee : amount, fee },
    });
    return {
      prepared, transaction: proof => sdk.publicTransaction(prepared, proof),
      beforeSubmit: async () => { sdk.rememberOutputs(account, info.profile, prepared); await persist?.(account); },
    };
  }, pricing);
}

/** Public exit of one whole note (holder exit, or ragequit back to the depositing address). */
export async function exitNote({ account, pool, note, recipient, ragequit = false, onStage, onSubmitted }: Common & { note: sdk.Note; recipient?: string; ragequit?: boolean }) {
  const info = POOLS[pool];
  // Ragequit is free and unpriced; a holder exit pays from the note it reveals.
  return relayed(pool, ragequit ? 'ragequit' : 'holderExit', 'holder-exit', onStage, onSubmitted, (state, fee) => {
    const prepared = ragequit
      ? sdk.prepareRagequit({ account, profile: info.profile, note, state, processor: info.relayer })
      : sdk.prepareHolderExit({ account, profile: info.profile, note, state, externalData: { processor: info.relayer, recipient: recipient!, feeRecipient: fee > 0n ? info.relayer : ZERO, fee } });
    return { prepared, transaction: proof => sdk.publicHolderExitTransaction(prepared, proof) };
  }, ragequit ? undefined : { kind: 'holder-exit', gross: note.value });
}

export const getQuote = (pool: PoolId, routeId: string, amountIn: bigint, slippageBPS = 100): Promise<Quote> => relayQuote(pool, routeId, amountIn, slippageBPS);

/** Private swap: spends notes in `pool`, routes through the DEX adapter and re-enters the target pool as a new note. */
export function swap({ account, pool, routeId, quote, onStage, persist, onSubmitted }: Common & { routeId: string; quote: Quote }) {
  const info = POOLS[pool], entry = info.routes.find(r => r.id === routeId);
  if (!entry) throw new Error('Unknown route.');
  return relayed(pool, 'swap', 'joinsplit', onStage, onSubmitted, state => {
    requireApprovedSet(state);
    if (BigInt(quote.deadline) <= BigInt(state.blockTimestamp)) throw new RelayError('EXPIRED_SWAP');
    const common = { account, sourceProfile: info.profile, targetProfile: POOLS[entry.target].profile, sourceState: state, route: entry.route, minChange: minChangeFor(info) };
    // Paid routes bind the NET minimum and an absolute fee cap (from the quote's netQuote); legacy routes the gross minimum.
    const prepared = sdk.isFeeRoute(entry.route)
      ? (() => {
        if (!quote.netQuote) throw new Error('This route needs a net quote. Get a new quote.');
        return sdk.prepareFeeSwap({ ...common, action: { processor: info.relayer, amountIn: BigInt(quote.amountIn), minAmountOut: BigInt(quote.netQuote.minNetOut), deadline: BigInt(quote.deadline), maxServiceFee: BigInt(quote.netQuote.maxServiceFee) } });
      })()
      : sdk.prepareSwap({ ...common, action: { processor: info.relayer, amountIn: BigInt(quote.amountIn), minAmountOut: BigInt(quote.minAmountOut), deadline: BigInt(quote.deadline) } });
    const action = Object.fromEntries(Object.entries(prepared.action).map(([k, v]) => [k, typeof v === 'bigint' ? String(v) : v]));
    return {
      prepared, routeId, transaction: proof => ({ ...sdk.publicTransaction(prepared, proof), action }),
      beforeSubmit: async () => { sdk.rememberOutputs(account, info.profile, prepared); await persist?.(account); },
    };
  });
}

export type NoteState = 'approved' | 'pending' | 'unknown';
export interface OwnedNote { note: sdk.Note; status: NoteState; originalDeposit: boolean }
export interface Holdings { pool: PoolId; balance: bigint; spendable: bigint; pending: bigint; notes: OwnedNote[] }
/** What `account` owns in one pool right now, split by association-set approval. Does not mutate `account`. */
export function inspect(account: sdk.Account, pool: PoolId, state: PoolState): Holdings {
  const probe = structuredClone(account), profile = POOLS[pool].profile, recovered = sdk.recoverAccount(probe, profile, state);
  const setKnown = !state.asp?.expired && Array.isArray(state.asp?.leaves);
  const deposits = new Set((state.deposits ?? []).map(d => String(d.commitment)));
  const notes = recovered.notes.map(note => ({
    note, originalDeposit: deposits.has(String(note.commitment)),
    status: (setKnown ? (sdk.isApproved(note, profile, state.asp) ? 'approved' : 'pending') : 'unknown') as NoteState,
  }));
  const sum = (s: NoteState) => notes.filter(n => n.status === s).reduce((t, n) => t + n.note.value, 0n);
  return { pool, balance: recovered.balance, spendable: sum('approved'), pending: sum('pending'), notes };
}
