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
/** Destination chain by id or name ("base", "arbitrum", "ethereum", "optimism", "bsc"/"bnb", "solana"). */
export const findChain = (name: string | number) => {
  const key = String(name).toLowerCase().replace(/\s+/g, '');
  return DEST_CHAINS.find(c => c.id === Number(name) || c.name.toLowerCase() === key || c.aliases?.includes(key));
};
export const bridgeLive = () => !NET.testnet;

/** What arrives on a destination chain: `native` is what ETH becomes, `stable` what USDG becomes. */
export interface DestCurrency { address: string; symbol: string; decimals: number }
/** How a non-EVM chain's addresses look (`hint`, shape check); EVM chains take a 0x address. */
export interface ForeignAddress { hint: string; looksValid: (a: string) => boolean }
export interface DestChain { id: number; name: string; explorer: string; native: DestCurrency; stable: DestCurrency; extra?: DestCurrency[]; aliases?: string[]; address?: ForeignAddress }
const cur = (symbol: string, address: string, decimals: number): DestCurrency => ({ address, symbol, decimals });
const ETH = cur('ETH', NATIVE, 18);
/** Same table as the web app's Bridge tab (privacy-frontend src/protocol/bridge.ts). `native` is the default for ETH,
 *  `stable` for USDG; `extra` are other tokens Relay can pay out there (`receive`). */
export const DEST_CHAINS: DestChain[] = [
  { id: 8453, name: 'Base', explorer: 'https://basescan.org', native: ETH, stable: cur('USDC', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 6),
    extra: [cur('cbBTC', '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', 8)] },
  { id: 42161, name: 'Arbitrum', explorer: 'https://arbiscan.io', native: ETH, stable: cur('USDC', '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 6),
    extra: [cur('WBTC', '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', 8)] },
  // Paxos issues USDG on Ethereum and Solana too, so there it stays USDG by default.
  { id: 1, name: 'Ethereum', explorer: 'https://etherscan.io', native: ETH, stable: cur('USDG', '0xe343167631d89B6Ffc58B88d6b7fB0228795491D', 6),
    extra: [cur('USDC', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 6), cur('WBTC', '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', 8)] },
  { id: 10, name: 'Optimism', explorer: 'https://optimistic.etherscan.io', native: ETH, stable: cur('USDC', '0x0b2C639c533813f4Aa9D7837Caf62653d097Ff85', 6),
    extra: [cur('WBTC', '0x68f180fcCe6836688e9084f035309E29Bf0A2095', 8)] },
  // BNB Smart Chain has no native ETH: ETH arrives as BNB by default and USDG as USDT (18 decimals on BSC).
  { id: 56, name: 'BSC', explorer: 'https://bscscan.com', aliases: ['bnb', 'bnbchain', 'bnbsmartchain', 'binance'],
    native: cur('BNB', NATIVE, 18), stable: cur('USDT', '0x55d398326f99059fF775485246999027B3197955', 18),
    extra: [cur('ETH', '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', 18), cur('BTCB', '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c', 18)] },
  // Relay's id for Solana. ETH arrives as SOL by default; needs a Robinhood Chain refund address, since the recipient isn't 0x.
  { id: 792703809, name: 'Solana', explorer: 'https://solscan.io', aliases: ['sol'],
    native: cur('SOL', '11111111111111111111111111111111', 9), stable: cur('USDG', '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH', 6),
    extra: [cur('USDC', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 6), cur('cbBTC', 'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij', 8)],
    address: { hint: 'a Solana address', looksValid: a => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a) } },
];

/** Every token that can arrive on `dest`, defaults first. */
export const receivable = (dest: DestChain): DestCurrency[] =>
  [dest.native, dest.stable, ...(dest.extra ?? [])].filter((c, i, all) => all.findIndex(x => x.symbol === c.symbol) === i);

/** What a pool's asset becomes on the destination chain: `receive` (a symbol, any case), else `native` for ETH and
 *  `stable` for USDG. Stocks can't bridge. */
export function bridgeRoute(pool: PoolInfo, dest: DestChain, receive?: string): { originCurrency: string; destinationCurrency: string; symbol: string; decimals: number } | null {
  const origin = pool.kind === 'native' ? NATIVE : pool.asset === USDG ? USDG : null;
  if (!origin) return null;
  const to = (receive && receivable(dest).find(c => c.symbol.toLowerCase() === receive.toLowerCase())) || (pool.kind === 'native' ? dest.native : dest.stable);
  return { originCurrency: origin, destinationCurrency: to.address, symbol: to.symbol, decimals: to.decimals };
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
export async function quoteBridge({ pool, dest, receive, amount, recipient, refundTo, live }: { pool: PoolInfo; dest: DestChain; receive?: string; amount: bigint; recipient: string; refundTo: string; live: boolean }): Promise<BridgeQuote> {
  const route = bridgeRoute(pool, dest, receive);
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
