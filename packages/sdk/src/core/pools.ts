// Pinned pools of the selected network, their relays and swap routes (see network.ts).
import { createPublicClient, defineChain, fallback, http, type Abi, type Chain, type Hex, type PublicClient } from 'viem';
import poolAbi from '../abi/Phase2ASPPool.json' with { type: 'json' };
import registryAbi from '../abi/Phase2ASPRegistry.json' with { type: 'json' };
import { NETWORKS, setNet, type AssetKind, type NetworkInfo, type NetworkName } from './network.js';
import type { Profile, SwapRoute } from './sdk.js';

export type PoolId = string;
export interface PoolInfo {
  id: PoolId; symbol: string; name: string; decimals: number; kind: AssetKind; asset: string;
  profile: Profile; relay: string; relayer: string;
  routes: { id: string; protocol: string; target: PoolId; route: SwapRoute; tokens: string[] }[];
}

export const POOL_ABI = poolAbi as Abi;
export const REGISTRY_ABI = registryAbi as Abi;

/** Filled by selectNetwork(). Mutated in place so every module sees the same pools. */
export const POOLS: Record<PoolId, PoolInfo> = {};
export let chain: Chain;
export let publicClient: PublicClient;
export let explorerTx = (hash: string) => hash;

const ORDER: Record<AssetKind, number> = { native: 0, stable: 1, stock: 2, token: 3 };

export interface NetworkOptions { rpc?: string; app?: string }
/** Selects the network for this process: pools, chain client and service URLs. */
export function selectNetwork(name: NetworkName, { rpc, app }: NetworkOptions = {}): NetworkInfo {
  const base = NETWORKS[name];
  if (!base) throw new Error(`Unknown network "${name}". Use testnet or mainnet.`);
  const net: NetworkInfo = { ...base, rpc: rpc ?? base.rpc, app: (app ?? base.app).replace(/\/$/, '') };
  if (!net.profiles.eth) throw new Error(`Lincoln is not live on ${net.label} yet.`);
  setNet(net);
  chain = defineChain({
    id: net.id, name: net.label, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [net.rpc] } }, blockExplorers: { default: { name: 'Explorer', url: net.explorer } }, testnet: net.testnet,
  });
  // Mainnet reads default to the Lincoln app's /rpc proxy (a dedicated node, this machine's IP hidden
  // from the provider), with the public endpoint as fallback. A custom rpc is used as is.
  const transport = !rpc && !net.testnet ? fallback([http(`${net.app}/rpc`), http(base.rpc)]) : http(net.rpc);
  publicClient = createPublicClient({ chain, transport }) as PublicClient;
  explorerTx = (hash: string) => `${net.explorer}/tx/${hash}`;

  for (const k of Object.keys(POOLS)) delete POOLS[k];
  const pools = Object.entries(net.profiles).map(([id, profile]) => {
    const asset = profile.pool.asset.toLowerCase(), meta = net.assets.find(a => a.address === asset);
    const routes = (net.routes[id] ?? []).map((r: any) => ({
      id: r.id as string, protocol: (['Uniswap V3', 'UP Slipstream'][r.route.protocol] ?? String(r.route.protocol)) as string, target: r.route.target as PoolId, route: r.route as SwapRoute,
      tokens: [r.route.hops[0].tokenIn, ...r.route.hops.map((h: any) => h.tokenOut)] as string[],
    }));
    const info: PoolInfo = {
      id, asset, symbol: meta?.symbol ?? id.toUpperCase(), name: meta?.name ?? 'Unlisted token', decimals: meta?.decimals ?? 18, kind: meta?.kind ?? 'token',
      profile, relay: `${net.app}/relay/${id}`, relayer: profile.relayer, routes,
    };
    return info;
  }).sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.symbol.localeCompare(b.symbol));
  for (const p of pools) POOLS[p.id] = p;
  return net;
}

export const poolAddress = (id: PoolId) => POOLS[id].profile.pool.address as Hex;
/** Pool by id or asset symbol (case-insensitive): "eth", "ETH", "usdg". */
export function findPool(name: string): PoolInfo {
  const n = name.trim().toLowerCase();
  const pool = POOLS[name] ?? Object.values(POOLS).find(p => p.id.toLowerCase() === n || p.symbol.toLowerCase() === n);
  if (!pool) throw new Error(`No ${name} pool on this network. Pools: ${Object.values(POOLS).map(p => p.symbol).join(', ')}.`);
  return pool;
}
