// Withdraw to another EVM chain through Relay (relay.link) deposit addresses, the route Privacy Cash
// also uses from Robinhood Chain. The private balance is withdrawn by our relay to a single-use
// ("strict") Relay deposit address on Robinhood Chain, so the user's wallet never appears; Relay's
// solvers pay out on the destination chain. Requests go through the Lincoln app's /bridge proxy, so
// Relay never sees this machine's IP. Relay lists Robinhood Chain mainnet only; on testnet this is
// a quote-only preview.
import { NET } from './network.js';
import type { PoolInfo } from './pools.js';

const NATIVE = '0x0000000000000000000000000000000000000000';
/** Robinhood Chain mainnet: quotes always use it, so testnet can preview live prices. */
const ORIGIN_CHAIN = 4663;
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
/** Destination chain by id or name ("base", "arbitrum", "ethereum", "optimism", "bsc"/"bnb"). */
export const findChain = (name: string | number) => {
  const key = String(name).toLowerCase().replace(/\s+/g, '');
  return DEST_CHAINS.find(c => c.id === Number(name) || c.name.toLowerCase() === key || c.aliases?.includes(key));
};
export const bridgeLive = () => !NET.testnet;

/** What arrives on a destination chain: `native` is what ETH becomes, `stable` what USDG becomes. */
export interface DestCurrency { address: string; symbol: string; decimals: number }
export interface DestChain { id: number; name: string; explorer: string; native: DestCurrency; stable: DestCurrency; aliases?: string[] }
const ETH: DestCurrency = { address: NATIVE, symbol: 'ETH', decimals: 18 };
const usdc = (address: string): DestCurrency => ({ address, symbol: 'USDC', decimals: 6 });
export const DEST_CHAINS: DestChain[] = [
  { id: 8453, name: 'Base', explorer: 'https://basescan.org', native: ETH, stable: usdc('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913') },
  { id: 42161, name: 'Arbitrum', explorer: 'https://arbiscan.io', native: ETH, stable: usdc('0xaf88d065e77c8cC2239327C5EDb3A432268e5831') },
  { id: 1, name: 'Ethereum', explorer: 'https://etherscan.io', native: ETH, stable: usdc('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48') },
  { id: 10, name: 'Optimism', explorer: 'https://optimistic.etherscan.io', native: ETH, stable: usdc('0x0b2C639c533813f4Aa9D7837Caf62653d097Ff85') },
  // BNB Smart Chain has no native ETH: ETH arrives as BNB and USDG as USDT (18 decimals on BSC).
  { id: 56, name: 'BSC', explorer: 'https://bscscan.com', aliases: ['bnb', 'bnbchain', 'bnbsmartchain', 'binance'],
    native: { address: NATIVE, symbol: 'BNB', decimals: 18 }, stable: { address: '0x55d398326f99059fF775485246999027B3197955', symbol: 'USDT', decimals: 18 } },
];

/** What a pool's asset becomes on the destination chain (ETH → the chain's `native`, USDG → its `stable`). Stocks can't bridge. */
export function bridgeRoute(pool: PoolInfo, dest: DestChain): { originCurrency: string; destinationCurrency: string; symbol: string; decimals: number } | null {
  const to = pool.kind === 'native' ? dest.native : pool.asset === USDG ? dest.stable : null;
  return to && { originCurrency: pool.kind === 'native' ? NATIVE : USDG, destinationCurrency: to.address, symbol: to.symbol, decimals: to.decimals };
}
export const bridgeable = (pool: PoolInfo) => bridgeRoute(pool, DEST_CHAINS[0]) !== null;

export interface BridgeQuote {
  amountOut: string; amountOutFormatted: string; minAmountOut: string; amountOutUsd?: string; timeEstimate: number;
  depositAddress?: string; requestId?: string;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try { res = await fetch(`${NET.app}/bridge${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } }); }
  catch { throw new Error('The bridge is unreachable right now. Try again shortly.'); }
  const body = await res.json().catch(() => null);
  if (!res.ok || !body) throw new Error(typeof body?.message === 'string' ? `Bridge: ${body.message}` : `Bridge error (${res.status}).`);
  return body as T;
}

/** Quote an exact input (raw units on Robinhood Chain). `live` reserves a single-use deposit address that refunds to `refundTo` on Robinhood Chain if the fill fails. */
export async function quoteBridge({ pool, dest, amount, recipient, refundTo, live }: { pool: PoolInfo; dest: DestChain; amount: bigint; recipient: string; refundTo: string; live: boolean }): Promise<BridgeQuote> {
  const route = bridgeRoute(pool, dest);
  if (!route) throw new Error(`${pool.symbol} can’t be bridged yet.`);
  const body = await call<any>('/quote', { method: 'POST', body: JSON.stringify({
    user: refundTo, recipient, originChainId: ORIGIN_CHAIN, destinationChainId: dest.id,
    originCurrency: route.originCurrency, destinationCurrency: route.destinationCurrency, amount: amount.toString(), tradeType: 'EXACT_INPUT',
    ...(live ? { useDepositAddress: true, strict: true, refundTo } : {}),
  }) });
  const out = body?.details?.currencyOut, step = body?.steps?.[0];
  if (!out?.amount) throw new Error('The bridge returned no quote for this route.');
  return {
    amountOut: out.amount, amountOutFormatted: out.amountFormatted, minAmountOut: out.minimumAmount ?? out.amount, amountOutUsd: out.amountUsd,
    timeEstimate: Number(body.details.timeEstimate ?? 0), depositAddress: step?.depositAddress, requestId: step?.requestId,
  };
}

/** Asks Relay to look at the deposit address now instead of waiting to notice the withdrawal. */
export const nudgeBridge = (depositAddress: string) =>
  call('/deposit-address/reindex', { method: 'POST', body: JSON.stringify({ chainId: ORIGIN_CHAIN, depositAddress }) }).catch(() => undefined);

export type BridgeStatus = 'waiting' | 'pending' | 'submitted' | 'success' | 'delayed' | 'refund' | 'refunded' | 'failure';
export const BRIDGE_DONE = new Set<string>(['success', 'refund', 'refunded', 'failure']);
export const bridgeStatus = (requestId: string) =>
  call<{ status: BridgeStatus; txHashes?: string[] }>(`/status?requestId=${encodeURIComponent(requestId)}`);
