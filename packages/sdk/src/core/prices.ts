// Rough USD values for spending limits only (never for proofs or amounts). Dollar stablecoins count
// as $1; ETH and tokenized stocks come through the Lincoln app's /prices proxy (Coinbase spot, Robinhood
// stock-token prices), so neither price source sees this machine's IP or what it is about to trade.
// Unknown assets have no price.
import { NET } from './network.js';
const cache = new Map<string, { at: number; usd: number | null }>();
const TTL = 60_000;

async function fetchJson(url: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(String(res.status));
  return res.json() as Promise<any>;
}

export async function usdPrice(symbol: string, kind: string): Promise<number | null> {
  const key = symbol.toUpperCase(), hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.usd;
  let usd: number | null = null;
  try {
    if (kind === 'stable' || ['USDG', 'USDC', 'USDT'].includes(key)) usd = 1;
    else if (key === 'ETH' || key === 'WETH' || kind === 'stock') usd = Number((await fetchJson(`${NET.app}/prices/${key === 'WETH' ? 'ETH' : encodeURIComponent(key)}`)).usd);
  } catch { usd = null; }
  if (usd !== null && !(usd > 0)) usd = null;
  cache.set(key, { at: Date.now(), usd });
  return usd;
}
