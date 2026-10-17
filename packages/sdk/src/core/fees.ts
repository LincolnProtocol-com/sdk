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
import type { PoolId } from './pools.js';

interface Part { bps: number; gas: boolean; fixed: bigint }
export interface FeePolicy { id: string | null; gas: bigint; withdrawal: Part; holderExit: Part; privateTransfer: Part; swapBps: number; label: string }

const FREE: Part = { bps: 0, gas: false, fixed: 0n };
const SPONSORED: FeePolicy = { id: null, gas: 0n, withdrawal: FREE, holderExit: FREE, privateTransfer: FREE, swapBps: 0, label: 'Sponsored' };
const units = (v: unknown) => { try { return v === undefined || v === null ? 0n : BigInt(v as string); } catch { return 0n; } };
const bps = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 10_000 ? v : 0);
const part = (p: any): Part => ({ bps: bps(p?.bps), gas: p?.includesGas === true, fixed: units(p?.fixedUnits) });

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

/** Per-pool policies as loaded from the relays (see loadServiceFees); missing pools are sponsored. */
export const FEE_POLICY: Record<PoolId, FeePolicy> = {};
export const feePolicy = (pool: PoolId) => FEE_POLICY[pool] ?? SPONSORED;

const charge = (p: FeePolicy, x: Part, gross: bigint) => gross * BigInt(x.bps) / 10_000n + (x.gas ? p.gas : 0n) + x.fixed;

/** Fee the relayer takes from a public withdrawal of `amount` (paid out of it). */
export const relayFee = (pool: PoolId, amount: bigint) => charge(feePolicy(pool), feePolicy(pool).withdrawal, amount);
/** Fee for a relayed holder exit of a note worth `value`. */
export const exitFee = (pool: PoolId, value: bigint) => charge(feePolicy(pool), feePolicy(pool).holderExit, value);
/** Fee for a private transfer (paid from the sender's notes on top of the amount). */
export const transferFee = (pool: PoolId) => charge(feePolicy(pool), feePolicy(pool).privateTransfer, 0n);

export interface FeeBreakdown { amount: bigint; fee: bigint; receives: bigint; policy: FeePolicy }
export function feeBreakdown(pool: PoolId, amount: bigint): FeeBreakdown {
  const fee = relayFee(pool, amount);
  return { amount, fee, receives: amount > fee ? amount - fee : 0n, policy: feePolicy(pool) };
}

const loading = new Map<PoolId, Promise<FeePolicy>>();
/** Loads (once per pool, retried after a failure) the relay's fee schedule into FEE_POLICY. */
export function loadServiceFees(pool: PoolId, fetchConfig: (pool: PoolId) => Promise<{ serviceFees?: unknown }>): Promise<FeePolicy> {
  if (!loading.has(pool)) {
    loading.set(pool, fetchConfig(pool).then(c => (FEE_POLICY[pool] = parseServiceFees(c.serviceFees)), e => { loading.delete(pool); throw e; }));
  }
  return loading.get(pool)!;
}
