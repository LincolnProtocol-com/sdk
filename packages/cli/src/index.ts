#!/usr/bin/env node
// lincoln: the Lincoln privacy pool from the command line. Every spend is quote → confirm → execute;
// `--json` prints machine-readable results for agents (errors as {"error":{code,message}}, exit 1).
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { Lincoln, LincolnError, supportedChains, type QuoteRecord, type OpStage, type NetworkName } from '@lincolnprotocol/sdk';

const HELP = `lincoln — private balances on Robinhood Chain

Usage
  lincoln init                                  create this agent's wallet and a default policy
  lincoln address                               private address (lincoln3:…) and public wallet
  lincoln balance                               ready and waiting balance per asset
  lincoln pools | fees | policy | activity      pools and swap routes · fee schedule · spending policy · recent spends

  lincoln quote send <amount> <asset> <lincoln3:…>
  lincoln quote swap <amount> <from> <to>
  lincoln quote withdraw <amount> <asset> <0x…> [--to <chain>]
  lincoln quote deposit <amount> <asset>
  lincoln execute <quoteId> [--approve]         run a quote (also: send|swap|withdraw|deposit --quote <id>)

  lincoln send <amount> <asset> <lincoln3:…>    quote, confirm, execute in one step
  lincoln swap <amount> <from> <to>
  lincoln withdraw <amount> <asset> <0x…> [--to <chain>]
  lincoln deposit <amount> <asset>
  lincoln status <jobId>

Options
  --network mainnet|testnet   default $LINCOLN_NETWORK or mainnet
  --home <dir>                wallet directory, default $LINCOLN_HOME or ~/.lincoln
  --json                      machine-readable output
  --yes                       skip the confirmation prompt (spends that need approval still need --approve)
  --approve                   the user approved this spend (above the policy's approval threshold)
  --to <chain>                withdraw to ${supportedChains().join(', ')}

Environment
  LINCOLN_PASSPHRASE          encrypts the agent key at init and unlocks it later
  LINCOLN_RPC, LINCOLN_APP    custom Robinhood Chain RPC, Lincoln app origin`;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    network: { type: 'string' }, home: { type: 'string' }, json: { type: 'boolean' }, yes: { type: 'boolean', short: 'y' },
    approve: { type: 'boolean' }, to: { type: 'string' }, quote: { type: 'string' }, slippage: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  },
});
const json = !!opts.json;
const out = (human: string, data: unknown) => console.log(json ? JSON.stringify(data, null, 2) : human);
const log = (s: string) => { if (!json) process.stderr.write(s + '\n'); };
const STAGE: Partial<Record<OpStage, string>> = { sync: 'syncing pool state…', prepare: 'preparing…', download: 'loading circuit…', prove: 'proving on this machine…', verify: 'checking the proof…', relay: 'relayer submitting…', sign: 'signing…', confirm: 'waiting for confirmation…' };
const onStage = (s: OpStage) => STAGE[s] && log(`  ${STAGE[s]}`);

function showQuote(q: QuoteRecord) {
  const lines = [
    `quote ${q.id} · ${q.action} · expires ${new Date(q.expiresAt).toLocaleTimeString()}`,
    `  amount     ${q.amount} ${q.asset}${q.usd !== null ? `  (~$${q.usd.toFixed(2)})` : ''}`,
    q.action === 'swap' ? `  you get    ≈ ${q.receives} ${q.receivesAsset} (at least ${q.minReceives})` : `  receives   ${q.minReceives ? '≈ ' : ''}${q.receives} ${q.receivesAsset}${q.chain ? ` on ${q.chain}` : ''}`,
    `  fee        ${q.fee} ${q.feeAsset}`,
    ...(q.to ? [`  to         ${q.to.length > 60 ? `${q.to.slice(0, 24)}…${q.to.slice(-8)}` : q.to}`] : []),
    ...q.notes.map(n => `  · ${n}`),
    q.policy.allowed ? (q.policy.needsApproval ? '  ! needs the user’s approval (--approve)' : '  ✓ within policy') : `  ✗ ${q.policy.reason}`,
  ];
  out(lines.join('\n'), q);
}

async function confirm(q: QuoteRecord) {
  if (opts.yes || json) return true;
  if (!process.stdin.isTTY) throw new LincolnError('CONFIRMATION_REQUIRED', 'Not a terminal: pass --yes to execute without a prompt.');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question(q.policy.needsApproval ? `Type "approve" to ${q.action} ${q.amount} ${q.asset}: ` : `Execute ${q.id}? [y/N] `);
  rl.close();
  if (q.policy.needsApproval) { if (answer.trim().toLowerCase() !== 'approve') return false; opts.approve = true; return true; }
  return /^y(es)?$/i.test(answer.trim());
}

async function execute(lincoln: Lincoln, id: string) {
  const r = await lincoln.execute(id, { approved: !!opts.approve, onStage, onSubmitted: ref => ref.jobId && log(`  job ${ref.jobId}`) });
  out(`✓ ${r.message}\n  tx ${r.explorer}${r.jobId ? `\n  job ${r.jobId}` : ''}`, r);
}

async function quote(lincoln: Lincoln, action: string, args: string[]): Promise<QuoteRecord> {
  const [amount, a, b] = args;
  const need = (n: number, usage: string) => { if (args.length < n) throw new LincolnError('USAGE', `Usage: lincoln ${usage}`); };
  switch (action) {
    case 'send': need(3, 'quote send <amount> <asset> <lincoln3:…>'); return lincoln.quoteSend({ amount, asset: a, to: b });
    case 'swap': need(3, 'quote swap <amount> <from> <to>'); return lincoln.quoteSwap({ amount, from: a, to: b, slippageBps: opts.slippage ? Number(opts.slippage) : undefined });
    case 'withdraw': need(3, 'quote withdraw <amount> <asset> <0x…> [--to <chain>]'); return lincoln.quoteWithdraw({ amount, asset: a, to: b, chain: opts.to });
    case 'deposit': need(2, 'quote deposit <amount> <asset>'); return lincoln.quoteDeposit({ amount, asset: a });
    default: throw new LincolnError('USAGE', 'quote what? send, swap, withdraw or deposit.');
  }
}

async function main() {
  const [cmd, ...args] = positionals;
  if (!cmd || opts.help || cmd === 'help') return console.log(HELP);
  const base = { network: opts.network as NetworkName | undefined, home: opts.home };

  if (cmd === 'init') {
    const { lincoln, keyFile, encrypted, policyFile } = await Lincoln.init(base);
    return out([
      `Agent wallet created on ${lincoln.net.label}.`,
      `  private address  ${lincoln.privateAddress}`,
      `  public wallet    ${lincoln.publicAddress}`,
      `  key              ${keyFile}${encrypted ? ' (encrypted)' : ' (NOT encrypted: set LINCOLN_PASSPHRASE before init to encrypt it)'}`,
      `  policy           ${policyFile}`,
      '',
      'Fund it privately: from your own Lincoln balance, send to the private address above.',
    ].join('\n'), { network: lincoln.network, privateAddress: lincoln.privateAddress, publicAddress: lincoln.publicAddress, keyFile, encrypted, policyFile });
  }

  const lincoln = await Lincoln.open(base);
  switch (cmd) {
    case 'address': return out(`private  ${lincoln.privateAddress}\npublic   ${lincoln.publicAddress}`, { privateAddress: lincoln.privateAddress, publicAddress: lincoln.publicAddress, network: lincoln.network });
    case 'balance': {
      const rows = await lincoln.balances();
      return out(rows.map(r => r.error ? `  ${r.asset.padEnd(6)} unavailable: ${r.error}`
        : `  ${r.asset.padEnd(6)} ${r.ready.padStart(14)} ready${r.waiting !== '0' ? `   ${r.waiting} waiting${r.readyAt ? ` (ready ~${new Date(r.readyAt).toLocaleTimeString()})` : ''}` : ''}`).join('\n'), rows);
    }
    case 'pools': { const p = lincoln.pools; return out(p.map(x => `  ${x.asset.padEnd(6)} ${x.kind.padEnd(7)} ${x.address}${x.routes.length ? `  swaps to ${[...new Set(x.routes)].join(', ')}` : ''}`).join('\n'), p); }
    case 'fees': { const f = await lincoln.fees(); return out(f.map(x => `  ${x.asset.padEnd(6)} ${x.label}`).join('\n'), f); }
    case 'policy': { const p = await lincoln.policy(); return out(JSON.stringify(p, null, 2), p); }
    case 'activity': { const a = await lincoln.activity(); return out(a.map(r => `  ${r.at}  ${r.action.padEnd(8)} ${r.amount} ${r.asset}  ${r.status}${r.jobId ? `  job ${r.jobId}` : ''}${r.error ? `  (${r.error})` : ''}`).join('\n') || '  nothing yet', a); }
    case 'status': { if (!args[0]) throw new LincolnError('USAGE', 'Usage: lincoln status <jobId>'); const s = await lincoln.status(args[0]); return out(`  ${s.action} ${s.amount} ${s.asset}: ${s.status}${s.explorer ? `\n  tx ${s.explorer}` : ''}`, s); }
    case 'quote': { const q = await quote(lincoln, args[0], args.slice(1)); return showQuote(q); }
    case 'execute': { if (!args[0]) throw new LincolnError('USAGE', 'Usage: lincoln execute <quoteId>'); return execute(lincoln, args[0]); }
    case 'send': case 'swap': case 'withdraw': case 'deposit': {
      if (opts.quote) return execute(lincoln, opts.quote);
      const q = await quote(lincoln, cmd, args);
      if (!json) showQuote(q);
      if (!q.policy.allowed) throw new LincolnError(q.policy.code ?? 'POLICY', q.policy.reason ?? 'Not allowed by the policy.');
      if (!(await confirm(q))) return log('Cancelled.');
      return execute(lincoln, q.id);
    }
    default: throw new LincolnError('USAGE', `Unknown command "${cmd}". Run lincoln --help.`);
  }
}

main().then(() => process.exit(0), (e: unknown) => {
  const code = e instanceof LincolnError ? e.code : 'FAILED', message = e instanceof Error ? e.message : String(e);
  if (json) console.log(JSON.stringify({ error: { code, message, ...(e instanceof LincolnError && e.details ? e.details : {}) } }, null, 2));
  else process.stderr.write(`✗ ${message}${code !== 'FAILED' ? ` [${code}]` : ''}\n`);
  process.exit(1);
});
