// Loads a pool's public state from its relay and checks it against the chain before use:
// the Merkle root must be one the pool knows, and the ASP policy must match the registry.
// A dishonest relay can then only withhold data, not invent notes or approvals.
import type { Hex } from 'viem';
import { POOLS, POOL_ABI, REGISTRY_ABI, publicClient, type PoolId } from './pools.js';
import { relayState } from './relay.js';
import type { PublicState } from './sdk.js';

export interface PoolState extends PublicState {
  blockNumber: string; blockTimestamp: string; reserve: string;
  flows: { kind: string; processor: string; publicIn: string; publicOut: string; transactionHash: string; blockNumber: string }[];
  deposits: NonNullable<PublicState['deposits']>;
  exits: { commitment: string; value: string; recipient: string; transactionHash: string }[];
  /** 'chain' when rebuilt from logs because the relay was unreachable (no approved set then). */
  source?: 'relay' | 'chain';
}

export async function loadPoolState(pool: PoolId): Promise<PoolState> {
  const state = await relayState(pool) as PoolState;
  const profile = POOLS[pool].profile;
  if (state.pool?.toLowerCase() !== profile.pool.address.toLowerCase() || state.chainId !== profile.chain.id) throw new Error('Relay returned state for a different pool.');
  const [known, policy] = await Promise.all([
    publicClient.readContract({ address: profile.pool.address as Hex, abi: POOL_ABI, functionName: 'knownRoot', args: [BigInt(state.root)] }) as Promise<boolean>,
    publicClient.readContract({ address: profile.registry.address as Hex, abi: REGISTRY_ABI, functionName: 'latestPolicy' }) as Promise<readonly [bigint, bigint, bigint]>,
  ]);
  if (!known) throw new Error('Relay state root is not known to the pool contract.');
  const [root, epoch, validUntil] = policy;
  // The relay may lag one epoch behind the registry; only accept a policy the chain confirms.
  if (state.asp && (String(root) !== state.asp.root || String(epoch) !== state.asp.epoch || String(validUntil) !== state.asp.validUntil)) {
    state.asp = { ...state.asp, leaves: null, expired: true };
  }
  return state;
}

/** Seconds until the ASP policy expires (negative when expired). */
export const aspSecondsLeft = (state: PoolState) => Number(state.asp?.validUntil ?? 0) - Math.floor(Date.now() / 1000);
