// Relayer service fees, read from each pool's relay (/v3/config → serviceFees) so the app proves
// exactly the fee the relay checks (it requires extData.fee === its own total, in the pool asset's
// raw units, rounded down). Two schemas exist:
//   v1 {serviceFeeBps (default 20), gasFeeUnits, transferServiceFeeUnits}, also when the schema is
//      omitted: withdrawal = bps + gas, private transfer = transfer + gas, holder exit = gas, ragequit = 0.
//   v2 {gasFeeUnits, withdrawal, holderExit, ragequit, privateTransfer, swap}: each part is
//      floor(gross × bps / 10000) + (includesGas ? gasFeeUnits : 0) + fixedUnits.
// No serviceFees (null, the testnet today) means everything is sponsored. Ragequit proofs carry no
// fee, so it stays free whatever the schedule says. Swap fees are taken by the route adapter and
// shown from the quote.
//
// Dynamic gas (/v3/config → feeQuotes, lincoln-relay-gas-pricing/v1): the gas part is no longer the
// fixed gasFeeUnits but priced per operation. Every new spend gets a fresh quote from POST /v3/fees
// before proving, proves its totalFee and submits its quoteId (priceFee). Displayed fees are estimated
// locally from the same public model (gas models, buffer, asset price) and the chain's current base fee.
import { POOLS, publicClient, type PoolId } from './pools.js';
import { RelayError, relayConfig, requestFeeQuote, type FeeQuote, type FeeQuoteKind } from './relay.js';

interface Part { bps: number; gas: boolean; fixed: bigint }
type PartKey = 'withdrawal' | 'holderExit' | 'privateTransfer';
/** The relay's public gas pricing model, for local estimates. Binding fees always come from a quote. */
export interface GasPricing {
  available: boolean; unavailableReason: string | null; bufferBps: number; maxGasPrice: bigint;
  models: { withdrawal: bigint[]; privateTransfer: bigint[]; holderExit: bigint };
  /** ETH wei per base unit of the pool asset; null when the relay has no fresh price for it. */
  price: { num: bigint; den: bigint } | null;
  /** Base-fee billing (lincoln-base-fee-billing/v1): the user's gas price is max(base × multiplier, base + addition).
   *  Null when the relay bills its signing price, max(2 × base, base + 0.02 gwei). */
  billing: { multiplierBps: number; minAdditionWei: bigint } | null;
}
export interface FeePolicy { id: string | null; gas: bigint; withdrawal: Part; holderExit: Part; privateTransfer: Part; swapBps: number; label: string; known?: false; dynamic?: GasPricing }

const FREE: Part = { bps: 0, gas: false, fixed: 0n };
const SPONSORED: FeePolicy = { id: null, gas: 0n, withdrawal: FREE, holderExit: FREE, privateTransfer: FREE, swapBps: 0, label: 'Sponsored' };
const units = (v: unknown) => { try { return v === undefined || v === null ? 0n : BigInt(v as string); } catch { return 0n; } };
const bps = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 10_000 ? v : 0);
const part = (p: any): Part => ({ bps: bps(p?.bps), gas: p?.includesGas === true, fixed: units(p?.fixedUnits) });
const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;

/** Parses a relay's serviceFees object (v1 or v2). Anything unrecognised is treated as sponsored. */
export function parseServiceFees(raw: unknown): FeePolicy {
  const f = raw as any;
  if (!f || typeof f !== 'object') return SPONSORED;
  const gas = units(f.gasFeeUnits);
  // No schema keeps the v1 meaning, including its 20 bps default (backend normalizeServiceFeePolicy).
  if (f.schema === 'lincoln-service-fees/v1' || f.schema === undefined) {
    const b = f.serviceFeeBps === undefined ? 20 : bps(f.serviceFeeBps);
    return { id: f.id ?? null, gas, withdrawal: { bps: b, gas: true, fixed: 0n }, holderExit: { bps: 0, gas: true, fixed: 0n },
      privateTransfer: { bps: 0, gas: true, fixed: units(f.transferServiceFeeUnits) }, swapBps: b, label: label(b) };
  }
  if (f.schema === 'lincoln-service-fees/v2') {
    const withdrawal = part(f.withdrawal);
    return { id: f.id ?? null, gas, withdrawal, holderExit: part(f.holderExit), privateTransfer: part(f.privateTransfer), swapBps: bps(f.swap?.bps), label: label(withdrawal.bps) };
  }
  return SPONSORED;
}
const label = (b: number) => (b === 0 ? 'Sponsored' : `${(b / 100).toFixed(2).replace(/0$/, '')}% service fee`);

/** Parses /v3/config.feeQuotes. Null (or absent) is the fixed-fee relay. */
export function parseGasPricing(raw: unknown, asset: string): GasPricing | undefined {
  const q = raw as any;
  if (!q || typeof q !== 'object' || q.enabled !== true) return undefined;
  const m = q.gasModels ?? {}, shape = (v: any) => [0, 1, 2].map(i => units(v?.[String(i)]));
  const p = Array.isArray(q.assetPrices) ? q.assetPrices.find((x: any) => String(x?.asset).toLowerCase() === asset.toLowerCase()) : undefined;
  const native = /^0x0{40}$/i.test(asset);
  const fresh = p && Date.parse(p.expiresAt) > Date.now() && units(p.weiPerBaseUnitNumerator) > 0n && units(p.weiPerBaseUnitDenominator) > 0n;
  const b = q.billingGasPrice;
  return {
    available: q.available !== false, unavailableReason: q.unavailableReason ?? null,
    bufferBps: Number.isInteger(q.gasBufferBps) ? q.gasBufferBps : 2000, maxGasPrice: units(q.maxGasPriceWei),
    models: { withdrawal: shape(m.withdrawal), privateTransfer: shape(m['private-transfer']), holderExit: units(m['holder-exit']) },
    price: native ? { num: 1n, den: 1n } : fresh ? { num: units(p.weiPerBaseUnitNumerator), den: units(p.weiPerBaseUnitDenominator) } : null,
    billing: b && typeof b === 'object' && Number.isInteger(b.multiplierBps) && b.multiplierBps > 0 ? { multiplierBps: b.multiplierBps, minAdditionWei: units(b.minimumAdditionWei) } : null,
  };
}

/** Per-pool policies as loaded from the relays (see loadServiceFees); missing pools are sponsored. */
export const FEE_POLICY: Record<PoolId, FeePolicy> = {};
export const feePolicy = (pool: PoolId) => FEE_POLICY[pool] ?? SPONSORED;

const max = (a: bigint, b: bigint) => (a > b ? a : b);
/** The gas price the relay bills for one unit at this base fee: under base-fee billing max(ceil(base × multiplier),
 *  base + addition), otherwise its signing price max(2 × base, base + 0.02 gwei); both capped by maxGasPriceWei
 *  (backend quoteMainnetGasPrice). Null when the base fee is unknown. */
export function billingGasPrice(d: GasPricing, base: bigint | null): bigint | null {
  if (base === null) return null;
  const raw = d.billing ? max(ceil(base * BigInt(d.billing.multiplierBps), 10_000n), base + d.billing.minAdditionWei) : max(base * 2n, base + 20_000_000n);
  return d.maxGasPrice > 0n && raw > d.maxGasPrice ? d.maxGasPrice : raw;
}

/** The chain's latest base fee, the input of every local estimate. Kept per chain; refreshed by loadServiceFees (at most
 *  every 30 s) and by every quote that reports the base fee it was priced on. Null until first read: a block without a
 *  base fee gives no estimate rather than a guessed price. */
let baseFeeWei: bigint | null = null, baseFeeAt = 0;
/** A quote's gas price when it reports no base fee (relays billing their signing price): used only while no base fee is known. */
let quotedPriceWei: bigint | null = null;
async function refreshGasPrice() {
  if (Date.now() - baseFeeAt < 30_000) return;
  baseFeeAt = Date.now();
  try { baseFeeWei = (await publicClient.getBlock({ blockTag: 'latest' })).baseFeePerGas ?? null; } catch { baseFeeAt = 0; }
}
/** Records what a binding quote was priced on, so the next estimates agree with it. */
export function rememberQuotePrice(q: { baseFeePerGas?: string; gasPriceWei?: string }) {
  if (units(q.baseFeePerGas) > 0n) { baseFeeWei = units(q.baseFeePerGas); baseFeeAt = Date.now(); }
  else if (units(q.gasPriceWei) > 0n) quotedPriceWei = units(q.gasPriceWei);
}
/** Why no gas estimate can be shown now, or null: the relay's own reason, or a base fee above its cap (the relay then
 *  refuses to quote; an estimate at the cap would hide that). An unread base fee estimates at the cap, the relay's ceiling. */
export function gasEstimateUnavailable(d: GasPricing): string | null {
  if (!d.available) return d.unavailableReason ?? 'FEE_QUOTES_UNAVAILABLE';
  return baseFeeWei !== null && d.maxGasPrice > 0n && baseFeeWei > d.maxGasPrice ? 'FEE_QUOTES_UNAVAILABLE' : null;
}
/** Output count the shown estimates assume: the largest JoinSplit shape. A zero-value output has commitment 0 and is
 *  not counted, so a real spend has 0, 1 or 2 outputs; spends quote their actual count (operations.ts settles it). */
export const ESTIMATE_OUTPUTS = 2;

/** Estimated gas part, in the pool asset, of one operation under dynamic pricing (what a quote would say now). */
function dynamicGas(d: GasPricing, key: PartKey, outputs = ESTIMATE_OUTPUTS): bigint {
  if (!d.price) return 0n;
  const raw = key === 'holderExit' ? d.models.holderExit : d.models[key][outputs] ?? 0n;
  const gas = ceil(raw * BigInt(10_000 + d.bufferBps), 10_000n);
  const price = billingGasPrice(d, baseFeeWei) ?? (quotedPriceWei !== null && quotedPriceWei <= d.maxGasPrice ? quotedPriceWei : d.maxGasPrice);
  return ceil(gas * price * d.price.den, d.price.num);
}
const gasPart = (p: FeePolicy, key: PartKey, outputs?: number) => (!p[key].gas ? 0n : p.dynamic ? dynamicGas(p.dynamic, key, outputs) : p.gas);
const charge = (p: FeePolicy, key: PartKey, gross: bigint, outputs?: number) => gross * BigInt(p[key].bps) / 10_000n + gasPart(p, key, outputs) + p[key].fixed;

/** Fee the relayer takes from a public withdrawal of `amount` (paid out of it). An estimate under dynamic gas. */
export const relayFee = (pool: PoolId, amount: bigint) => charge(feePolicy(pool), 'withdrawal', amount);
/** Fee for a relayed holder exit of a note worth `value`. */
export const exitFee = (pool: PoolId, value: bigint) => charge(feePolicy(pool), 'holderExit', value);
/** Fee for a private transfer (paid from the sender's notes on top of the amount). */
export const transferFee = (pool: PoolId) => charge(feePolicy(pool), 'privateTransfer', 0n);

export interface FeeBreakdown { amount: bigint; fee: bigint; service: bigint; gas: bigint; receives: bigint; policy: FeePolicy; estimated: boolean }
export function feeBreakdown(pool: PoolId, amount: bigint): FeeBreakdown {
  const policy = feePolicy(pool), fee = relayFee(pool, amount), gas = gasPart(policy, 'withdrawal');
  return { amount, fee, service: fee - gas, gas, receives: amount > fee ? amount - fee : 0n, policy, estimated: !!policy.dynamic };
}

const loading = new Map<PoolId, { at: number; promise: Promise<FeePolicy> }>();
/** Loads the relay's fee schedule into FEE_POLICY: once per pool (for a minute under dynamic pricing, whose
 *  asset prices and availability change), retried after a failure. */
export function loadServiceFees(pool: PoolId, fetchConfig: (pool: PoolId) => Promise<{ serviceFees?: unknown; feeQuotes?: unknown }> = relayConfig): Promise<FeePolicy> {
  const cached = loading.get(pool);
  if (!cached || (FEE_POLICY[pool]?.dynamic && Date.now() - cached.at > 60_000)) {
    const promise = fetchConfig(pool).then(async c => {
      const policy = parseServiceFees(c.serviceFees), dynamic = parseGasPricing(c.feeQuotes, POOLS[pool]?.asset ?? '');
      if (dynamic) { policy.dynamic = dynamic; await refreshGasPrice(); }
      return (FEE_POLICY[pool] = policy);
    }, e => { loading.delete(pool); throw e; });
    loading.set(pool, { at: Date.now(), promise });
  }
  return loading.get(pool)!.promise;
}

/** Drops a pool's loaded schedule, so the next read asks the relay again (it switched pricing modes under us). */
export function forgetServiceFees(pool: PoolId) { loading.delete(pool); delete FEE_POLICY[pool]; }

const PART: Record<FeeQuoteKind, PartKey> = { withdrawal: 'withdrawal', 'private-transfer': 'privateTransfer', 'holder-exit': 'holderExit' };
/** Local estimate of one spend's fee with `outputs` output commitments (exact under a fixed schedule). */
export const estimateFee = (pool: PoolId, kind: FeeQuoteKind, gross: bigint, outputs?: number) =>
  charge(feePolicy(pool), PART[kind], kind === 'private-transfer' ? 0n : gross, outputs);
/** Raw (unbuffered) gas units of the model for one shape: the floor a quote request may raise but never lower. */
export function modelGas(pool: PoolId, kind: FeeQuoteKind, outputs: number): bigint {
  const d = feePolicy(pool).dynamic;
  return !d ? 0n : kind === 'holder-exit' ? d.models.holderExit : d.models[PART[kind] as 'withdrawal'][outputs] ?? 0n;
}

/** A fee ready to prove: the quote it came from (dynamic pricing), or null under a fixed schedule. */
export interface PricedFee { fee: bigint; quote: FeeQuote | null }

/** Codes a quote request gets when the relay left per-transaction pricing since its schedule was read
 *  (a fixed-fee /v3/fees takes only kind and grossAmount). */
const LEFT_DYNAMIC = new Set(['UNEXPECTED_FIELDS', 'FEE_QUOTE_DISABLED', 'INVALID_SERVICE_FEE_KIND']);

/** The exact fee for one new spend with `outputCount` output commitments (0 for a holder exit). Under dynamic pricing
 *  this asks the relay for a fresh, single-use quote (it expires in about two minutes and binds to one job); otherwise
 *  it is the fixed schedule's fee. A schedule that no longer matches the relay's mode is re-read once, never looped. */
export async function priceFee(pool: PoolId, kind: FeeQuoteKind, gross: bigint, { outputCount, gasUnits }: { outputCount?: number; gasUnits?: bigint } = {}): Promise<PricedFee> {
  const outputs = kind === 'holder-exit' ? 0 : outputCount ?? ESTIMATE_OUTPUTS;
  let policy = await loadServiceFees(pool);
  // A price that went stale may have been refreshed since the schedule was read: look once more before pausing.
  if (policy.dynamic && !policy.dynamic.available && Date.now() - (loading.get(pool)?.at ?? 0) > 10_000) { forgetServiceFees(pool); policy = await loadServiceFees(pool); }
  if (!policy.dynamic) return { fee: estimateFee(pool, kind, gross, outputs), quote: null };
  if (!policy.dynamic.available) throw new RelayError(policy.dynamic.unavailableReason ?? 'FEE_QUOTES_UNAVAILABLE');
  const grossAmount = kind === 'private-transfer' ? 0n : gross;
  // A larger raw estimate (after FEE_QUOTE_COST_EXCEEDED, or a shape settled upwards) never goes below the shape's model.
  const model = modelGas(pool, kind, outputs);
  let q: FeeQuote;
  try { q = await requestFeeQuote(pool, { kind, grossAmount, outputCount: outputs, ...(gasUnits !== undefined && gasUnits > model ? { gasUnits } : {}) }); }
  catch (e) {
    if (!(e instanceof RelayError && LEFT_DYNAMIC.has(e.code))) throw e;
    forgetServiceFees(pool);
    if ((await loadServiceFees(pool)).dynamic) throw e;
    return { fee: estimateFee(pool, kind, gross, outputs), quote: null };
  }
  const info = POOLS[pool], fee = units(q.totalFee);
  // The quote binds pool, processor and shape; a mismatching answer is never proved.
  if (q.kind !== kind || q.outputCount !== outputs || q.grossAmount !== String(grossAmount) || !/^[0-9a-f]{64}$/.test(q.quoteId)
    || (q.pool && q.pool.toLowerCase() !== info.profile.pool.address.toLowerCase()) || (q.processor && q.processor.toLowerCase() !== info.relayer.toLowerCase())
    ) throw new RelayError('FEE_QUOTE_BINDING_MISMATCH');
  if (kind !== 'private-transfer' && fee >= gross) throw new RelayError('SERVICE_FEE_EXCEEDS_OUTPUT');
  rememberQuotePrice(q);
  return { fee, quote: q };
}
/** Raw gas units a quote was priced on (its model or a raised estimate). */
export const quotedRawGas = (q: FeeQuote) => units(q.rawGasUnits ?? '0');
/** Whether a quote still has `marginMs` left before it expires. */
export const quoteLive = (p: PricedFee | null, marginMs = 10_000) => !!p && (!p.quote || Date.parse(p.quote.expiresAt) - Date.now() > marginMs);
