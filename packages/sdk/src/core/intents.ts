// Withdraw to non-EVM chains (Zcash, Bitcoin, Tron) through NEAR Intents (1Click API), the same routes
// as the web app's Bridge tab (privacy-frontend src/protocol/intents.ts). The private balance is withdrawn by
// our relay to a one-time 1Click deposit address on Robinhood Chain, so the agent's wallet never appears; a
// solver pays out on the destination chain. Requests go through the Lincoln app's /intents proxy, so 1Click
// never sees this machine's IP. 1Click lists Robinhood Chain mainnet only.
import { NET } from './network.js';
import type { PoolInfo } from './pools.js';

const ORIGIN_ETH = 'nep141:hood.omft.near';
const ORIGIN_USDG = 'nep141:hood-0x5fc5360d0400a0fd4f2af552add042d716f1d168.omft.near';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const BASE58 = '1-9A-HJ-NP-Za-km-z';

export interface IntentAsset { assetId: string; symbol: string; decimals: number }
/** A non-EVM destination: `native` is what ETH becomes, `stable` what USDG becomes. `looksValid` checks the
 *  address shape only; 1Click does the real check. */
export interface IntentChain { name: string; aliases: string[]; native: IntentAsset; stable: IntentAsset; hint: string; looksValid: (a: string) => boolean }
const ZEC: IntentAsset = { assetId: 'nep141:zec.omft.near', symbol: 'ZEC', decimals: 8 };
const BTC: IntentAsset = { assetId: 'nep141:btc.omft.near', symbol: 'BTC', decimals: 8 };
export const INTENT_CHAINS: IntentChain[] = [
  { name: 'Zcash', aliases: ['zec'], native: ZEC, stable: ZEC, hint: 't1…, t3… or u1…',
    looksValid: a => new RegExp(`^t[13][${BASE58}]{33}$`).test(a) || /^u1[02-9ac-hj-np-z]{100,}$/.test(a) },
  { name: 'Bitcoin', aliases: ['btc'], native: BTC, stable: BTC, hint: 'bc1…, 1… or 3…',
    looksValid: a => /^bc1[02-9ac-hj-np-z]{11,71}$/.test(a) || new RegExp(`^[13][${BASE58}]{25,34}$`).test(a) },
  { name: 'Tron', aliases: ['trx'], native: { assetId: 'nep141:tron.omft.near', symbol: 'TRX', decimals: 6 },
    stable: { assetId: 'nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near', symbol: 'USDT', decimals: 6 },
    hint: 'T…', looksValid: a => new RegExp(`^T[${BASE58}]{33}$`).test(a) },
];
export const findIntentChain = (name: string) => {
  const key = name.toLowerCase();
  return INTENT_CHAINS.find(c => c.name.toLowerCase() === key || c.aliases.includes(key));
};

/** What a pool's asset becomes on an intents chain, with the 1Click asset it leaves Robinhood Chain as. Stocks can't go. */
export function intentRoute(pool: PoolInfo, chain: IntentChain): (IntentAsset & { origin: string }) | null {
  if (pool.kind === 'native') return { origin: ORIGIN_ETH, ...chain.native };
  if (pool.asset === USDG) return { origin: ORIGIN_USDG, ...chain.stable };
  return null;
}

export interface IntentQuote { amountOut: string; amountOutFormatted: string; minAmountOut: string; timeEstimate: number; depositAddress?: string }

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try { res = await fetch(`${NET.app}/intents/v0${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } }); }
  catch { throw new Error('NEAR Intents is unreachable right now. Try again shortly.'); }
  const body = await res.json().catch(() => null);
  if (!res.ok || !body) throw new Error(typeof body?.message === 'string' ? `NEAR Intents: ${body.message}` : `NEAR Intents error (${res.status}).`);
  return body as T;
}

/** Quote an exact input (raw units on Robinhood Chain). `dry` returns a price only; a live quote reserves a
 *  one-time deposit address that refunds to `refundTo` on Robinhood Chain if the swap fails. */
export async function quoteIntent({ route, amount, recipient, refundTo, dry }: { route: { origin: string; assetId: string }; amount: bigint; recipient: string; refundTo: string; dry: boolean }): Promise<IntentQuote> {
  const body = await call<{ quote: IntentQuote }>('/quote', { method: 'POST', body: JSON.stringify({
    dry, swapType: 'EXACT_INPUT', slippageTolerance: 100,
    originAsset: route.origin, depositType: 'ORIGIN_CHAIN', destinationAsset: route.assetId, amount: amount.toString(),
    refundTo, refundType: 'ORIGIN_CHAIN', recipient, recipientType: 'DESTINATION_CHAIN', deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
  }) });
  return body.quote;
}

/** Tells 1Click about the deposit transaction so it starts without waiting to notice it. */
export const submitIntentDeposit = (txHash: string, depositAddress: string) =>
  call('/deposit/submit', { method: 'POST', body: JSON.stringify({ txHash, depositAddress }) }).catch(() => undefined);

export const INTENT_DONE = new Set(['SUCCESS', 'REFUNDED', 'FAILED']);
export const intentStatus = (depositAddress: string) =>
  call<{ status: string; swapDetails?: { destinationChainTxHashes?: { hash: string }[] } }>(`/status?depositAddress=${encodeURIComponent(depositAddress)}`);
