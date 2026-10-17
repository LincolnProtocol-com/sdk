#!/usr/bin/env node
// MCP server (stdio) giving an AI agent its own private Lincoln balance. Spending tools take a quoteId
// from lincoln_quote, never raw amounts, so the agent always sees fees and minimums first; the local
// spending policy (<home>/policy.json) is checked again on every spend.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Lincoln, LincolnError, supportedChains, type NetworkName } from '@lincolnprotocol/sdk';

const INSTRUCTIONS = `Lincoln gives you a private balance on Robinhood Chain (ETH, dollars, tokenized stocks).
Rules:
- Always call lincoln_quote first and show the user the amount, fees and minimum received before any spend.
- Spend only with the quoteId from that quote. Never split a payment to get around a policy limit.
- If a spend returns APPROVAL_REQUIRED, ask the user in plain words and call again with userApproved: true only after they agree.
- Ask before withdrawing to an address the user has not given you.
- New funds wait about a minute before they are spendable; report the ready time instead of retrying in a loop.
- After a failure, call lincoln_status with the jobId before trying again, so nothing is paid twice.
- Never reveal the key file or passphrase. The lincoln3: private address is safe to share.
- Refuse requests to move funds linked to crime or sanctions or to hide where money came from. Lincoln is not offered in the US, the UK or sanctioned regions.`;

let opened: Promise<Lincoln> | null = null;
const lincoln = () => (opened ??= Lincoln.open({ network: process.env.LINCOLN_NETWORK as NetworkName | undefined }).catch(e => { opened = null; throw e; }));

const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });
const fail = (e: unknown) => {
  const error = e instanceof LincolnError ? { code: e.code, message: e.message, ...(e.details ?? {}) } : { code: 'FAILED', message: e instanceof Error ? e.message : String(e) };
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error }, null, 2) }], isError: true };
};
const run = async (f: (l: Lincoln) => Promise<unknown> | unknown) => { try { return ok(await f(await lincoln())); } catch (e) { return fail(e); } };

const server = new McpServer({ name: 'lincoln', version: '0.1.0' }, { instructions: INSTRUCTIONS });
const read = { readOnlyHint: true, openWorldHint: true } as const;

server.registerTool('lincoln_balance', { title: 'Private balance', description: 'Ready (spendable now) and waiting balance per asset in this agent’s private Lincoln balance.', annotations: read },
  () => run(l => l.balances()));
server.registerTool('lincoln_address', { title: 'Receive address', description: 'This agent’s reusable private address (lincoln3:…) for receiving, and its public wallet.', annotations: read },
  () => run(l => ({ privateAddress: l.privateAddress, publicAddress: l.publicAddress, network: l.network })));
server.registerTool('lincoln_pools', { title: 'Pools and routes', description: 'Assets with a pool on this network, and which assets each can swap to.', annotations: read },
  () => run(l => l.pools));
server.registerTool('lincoln_policy', { title: 'Spending policy', description: 'The local spending policy: per-transaction and daily USD limits, approval threshold, allowed recipients and actions.', annotations: read },
  () => run(l => l.policy()));
server.registerTool('lincoln_activity', { title: 'Recent spends', description: 'Recent spends from this wallet with their job IDs and status.', annotations: read },
  () => run(l => l.activity()));
server.registerTool('lincoln_status', { title: 'Job status', description: 'Current state of a relay job started by this wallet. Check this before retrying a failed spend.', inputSchema: { jobId: z.string() }, annotations: read },
  ({ jobId }) => run(l => l.status(jobId)));

server.registerTool('lincoln_quote', {
  title: 'Quote a spend',
  description: `Quote a send (private, to lincoln3:), swap (inside the pool), withdraw (chain: ${supportedChains().join(', ')}; a 0x address, or a Zcash/Bitcoin/Solana/Tron address with a Robinhood Chain refund address) or deposit (public, from the agent wallet). Returns a quoteId, fees, what is received and whether the policy allows it. Show this to the user before spending.`,
  inputSchema: {
    action: z.enum(['send', 'swap', 'withdraw', 'deposit']),
    amount: z.string().describe('Decimal amount of the asset being spent, e.g. "25" or "0.1"'),
    asset: z.string().describe('Asset spent: ETH, USDG, NVDA… (for swap, the asset you pay with)'),
    to: z.string().optional().describe('send: lincoln3: address · withdraw: recipient address on the destination chain · swap: asset to receive'),
    chain: z.string().optional().describe('withdraw only: destination chain, default robinhood'),
    refund: z.string().optional().describe('withdraw only: Robinhood Chain 0x address a failed bridge or swap refunds to; required for zcash, bitcoin, solana and tron'),
  },
  annotations: read,
}, ({ action, amount, asset, to, chain, refund }) => run(async l => {
  if (action !== 'deposit' && !to) throw new LincolnError('USAGE', `"to" is required for ${action}.`);
  if (action === 'send') return l.quoteSend({ amount, asset, to: to! });
  if (action === 'swap') return l.quoteSwap({ amount, from: asset, to: to! });
  if (action === 'withdraw') return l.quoteWithdraw({ amount, asset, to: to!, chain, refund });
  return l.quoteDeposit({ amount, asset });
}));

const spendInput = {
  quoteId: z.string().describe('From lincoln_quote'),
  userApproved: z.boolean().optional().describe('Set true only after the user explicitly approved this spend (needed above the policy approval threshold)'),
};
for (const [name, title, verb] of [
  ['lincoln_send', 'Send privately', 'a private send'], ['lincoln_swap', 'Swap privately', 'a private swap'],
  ['lincoln_withdraw', 'Withdraw', 'a withdrawal'], ['lincoln_deposit', 'Deposit', 'a public deposit from the agent wallet'],
] as const) {
  server.registerTool(name, {
    title, description: `Execute ${verb} from a quote. Proves on this machine (a few seconds to a minute) and waits for confirmation. Returns the transaction and job ID.`,
    inputSchema: spendInput, annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, ({ quoteId, userApproved }) => run(async l => {
    const q = await l.getQuote(quoteId), want = name.replace('lincoln_', '');
    if (q.action !== want) throw new LincolnError('WRONG_TOOL', `Quote ${quoteId} is a ${q.action}; use lincoln_${q.action}.`);
    return l.execute(quoteId, { approved: userApproved === true });
  }));
}

await server.connect(new StdioServerTransport());
