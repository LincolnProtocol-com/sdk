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

// Chain checks shared by every refresh: the registry's accepted policy for an epoch (one registry for all pools, so
// one call per epoch, not one per pool) and whether a pool knows a root. Only positive answers are kept, for a minute:
// an RPC node a block behind the relay may not know a new root or epoch yet, and that must be asked again.
const CHECK_TTL_MS = 60_000;
const checks = new Map<string, { at: number; value: Promise<unknown> }>();
function cached<T>(key: string, load: () => Promise<T>, keep: (v: T) => boolean): Promise<T> {
  const hit = checks.get(key);
  if (hit && Date.now() - hit.at < CHECK_TTL_MS) return hit.value as Promise<T>;
  const value = load();
  checks.set(key, { at: Date.now(), value });
  value.then(v => { if (!keep(v)) checks.delete(key); }, () => checks.delete(key));
  return value;
}

export async function loadPoolState(pool: PoolId): Promise<PoolState> {
  const state = await relayState(pool) as PoolState;
  const profile = POOLS[pool].profile;
  if (state.pool?.toLowerCase() !== profile.pool.address.toLowerCase() || state.chainId !== profile.chain.id) throw new Error('Relay returned state for a different pool.');
  const epoch = state.asp?.epoch ? BigInt(state.asp.epoch) : 0n;
  const [known, accepted] = await Promise.all([
    cached(`root:${profile.pool.address}:${state.root}`, () =>
      publicClient.readContract({ address: profile.pool.address as Hex, abi: POOL_ABI, functionName: 'knownRoot', args: [BigInt(state.root)] }) as Promise<boolean>, v => v),
    epoch > 0n
      ? cached(`policy:${profile.registry.address}:${epoch}`, () =>
          publicClient.readContract({ address: profile.registry.address as Hex, abi: REGISTRY_ABI, functionName: 'acceptedPolicy', args: [epoch] }) as Promise<readonly [bigint, bigint]>, v => v[0] !== 0n)
      : Promise.resolve([0n, 0n] as const),
  ]);
  if (!known) throw new Error('Relay state root is not known to the pool contract.');
  // Sets publish every few seconds, so the relay's epoch is often a round behind the registry's latest. The registry
  // (and the pool, when it verifies a proof) still accepts recent epochs: the last 16, a superseded one for an hour.
  // Use the relay's set only if the chain accepts exactly that epoch, root and expiry.
  const [root, validUntil] = accepted;
  if (state.asp && (root === 0n || String(root) !== state.asp.root || String(validUntil) !== state.asp.validUntil)) {
    state.asp = { ...state.asp, leaves: null, expired: true };
  }
  return state;
}

/** Seconds until the ASP policy expires (negative when expired). */
export const aspSecondsLeft = (state: PoolState) => Number(state.asp?.validUntil ?? 0) - Math.floor(Date.now() / 1000);
