// On-chain deposit limits of the mainnet pools: a per-deposit maximum, a pool-wide maximum over the
// pool's own accounting, and a guardian switch that pauses new deposits only (withdrawals and exits
// never stop). Raises wait out a delay (pendingCaps.eta; 12 h planned); cuts apply at once. Names follow core
// v0.1.0-rc.2. Testnet pools predate the limits and have none; on mainnet every pool has them, so a
// failed read fails closed (deposits wait) instead of reading as "no limits".
import { parseAbi, type Hex } from 'viem';
import { POOLS, publicClient, type PoolId } from './pools.js';
import { NET } from './network.js';

const CAPS_ABI = parseAbi([
  'function maxDeposit() view returns (uint128)', 'function maxTotal() view returns (uint128)',
  'function accountedBalance() view returns (uint256)', 'function depositsPaused() view returns (bool)',
  'function pendingCaps() view returns (uint128 maxDeposit, uint128 maxTotal, uint64 eta)',
]);

export interface PoolCaps { maxDeposit: bigint; maxTotal: bigint; accounted: bigint; room: bigint; paused: boolean; pending: { maxDeposit: bigint; maxTotal: bigint; eta: number } | null }

const cache = new Map<PoolId, { at: number; value: Promise<PoolCaps | null> }>();

/** The pool's limits, or null when it has none on chain. Cached for 30 s. */
export function poolCaps(pool: PoolId): Promise<PoolCaps | null> {
  const hit = cache.get(pool);
  if (hit && Date.now() - hit.at < 30_000) return hit.value;
  const address = POOLS[pool].profile.pool.address as Hex;
  const read = <T,>(functionName: 'maxDeposit' | 'maxTotal' | 'accountedBalance' | 'depositsPaused' | 'pendingCaps') =>
    publicClient.readContract({ address, abi: CAPS_ABI, functionName }) as Promise<T>;
  const value = (async () => {
    // Only a testnet (pre-limit) pool may lack maxDeposit; anywhere else a failed read is an error.
    let maxDeposit: bigint;
    try { maxDeposit = await read<bigint>('maxDeposit'); } catch (e) { if (NET.testnet) return null; throw e; }
    const [maxTotal, accounted, paused, pending] = await Promise.all([
      read<bigint>('maxTotal'), read<bigint>('accountedBalance'),
      read<boolean>('depositsPaused'), read<readonly [bigint, bigint, bigint]>('pendingCaps'),
    ]);
    return {
      maxDeposit, maxTotal, accounted, paused, room: maxTotal > accounted ? maxTotal - accounted : 0n,
      pending: pending && pending[2] > 0n ? { maxDeposit: pending[0], maxTotal: pending[1], eta: Number(pending[2]) } : null,
    };
  })();
  cache.set(pool, { at: Date.now(), value });
  value.catch(() => cache.delete(pool));
  return value;
}

/** Why a deposit of `amount` would be refused by the contract, or null if it fits. */
export function capError(caps: PoolCaps | null, amount: bigint, symbol: string, format: (v: bigint) => string): string | null {
  if (!caps) return null;
  if (caps.paused) return `New ${symbol} deposits are paused for now. Withdrawals and exits still work.`;
  if (amount > caps.maxDeposit) return `The most one deposit can be is ${format(caps.maxDeposit)} ${symbol} for now.`;
  if (amount > caps.room) return caps.room === 0n ? `The ${symbol} pool is full for now.` : `Only ${format(caps.room)} ${symbol} more fits in the pool for now.`;
  return null;
}
