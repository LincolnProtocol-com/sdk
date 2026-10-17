// Rough USD values for spending limits only (never for proofs or amounts). Dollar stablecoins count
// as $1, ETH comes from Coinbase's public spot price, tokenized stocks from Robinhood's public stock
// token prices (already adjusted for corporate actions). Unknown assets have no price.
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
    else if (key === 'ETH' || key === 'WETH') usd = Number((await fetchJson('https://api.coinbase.com/v2/prices/ETH-USD/spot')).data.amount);
    else if (kind === 'stock') usd = Number((await fetchJson(`https://api.robinhood.com/rhj/prices/${encodeURIComponent(key)}`)).quotes[0].tokenAsk);
  } catch { usd = null; }
  if (usd !== null && !(usd > 0)) usd = null;
  cache.set(key, { at: Date.now(), usd });
  return usd;
}
