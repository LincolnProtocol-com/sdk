// Standard amounts for withdrawals and swaps. The pool accepts any amount, but an unusual amount
// can be matched across a deposit and a withdrawal; round, common amounts blend into a crowd.
// Amounts are in the asset's own units (stock tokens, not dollars).
import { parseUnits } from 'viem';
import { NET } from './network.js';
import type { PoolInfo } from './pools.js';
import { transferFee } from './fees.js';

const LADDER: Record<string, string[]> = {
  native: NET.testnet ? ['0.0001', '0.0005', '0.001', '0.005', '0.01', '0.05'] : ['0.01', '0.05', '0.1', '0.5', '1', '5'],
  stable: ['10', '50', '100', '500', '1000', '5000'],
  stock: ['0.5', '1', '2', '5', '10'],
  token: ['10', '100', '1000', '10000'],
};

/** Standard amounts for this pool's asset, smallest first, in raw units. */
export const presetsFor = (pool: PoolInfo): bigint[] => (LADDER[pool.kind] ?? LADDER.token).map(v => parseUnits(v, pool.decimals));

/** Round: a whole number (up to 10) of one of the standard amounts, e.g. 0.3 ETH or 2 NVDA, not 0.37 ETH. */
export function isRound(amount: bigint, pool: PoolInfo): boolean {
  return amount > 0n && presetsFor(pool).some(p => amount % p === 0n && amount / p <= 10n);
}

/** The largest standard amount below `max`, if any: the default choice. Strictly below, so the default
 *  leaves change instead of spending the whole balance (an exact spend has no change note). */
export const defaultPreset = (pool: PoolInfo, max: bigint): bigint | null => presetsFor(pool).filter(p => p < max).at(-1) ?? null;

/** Smallest change worth leaving: enough to be spent later (10× a private send's fee) and not dust
 *  next to the standard amounts (a tenth of the smallest one). */
export function minChangeFor(pool: PoolInfo): bigint {
  const fee = transferFee(pool.id) * 10n, floor = presetsFor(pool)[0] / 10n;
  return fee > floor ? fee : floor;
}
