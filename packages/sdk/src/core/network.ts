// Which Robinhood Chain a process talks to. Unlike the web app (one network per build), the SDK picks
// it at runtime: selectNetwork() fills POOLS, the chain client and the service URLs, and must run
// before any other call (Lincoln.open does this). Pool profiles, swap routes and circuit pins ship
// with the package and are never taken from a relay, so a relay cannot redirect funds.
import ethProfile from '../networks/testnet/profile.eth.json' with { type: 'json' };
import tokenBProfile from '../networks/testnet/profile.tokenB.json' with { type: 'json' };
import ethRoutes from '../networks/testnet/routes.eth.json' with { type: 'json' };
import tokenBRoutes from '../networks/testnet/routes.tokenB.json' with { type: 'json' };
import testnetCircuits from '../networks/testnet/circuits.json' with { type: 'json' };
import type { Profile } from './sdk.js';

export type NetworkName = 'testnet' | 'mainnet';
export type AssetKind = 'native' | 'stable' | 'token' | 'stock';
export interface AssetMeta { symbol: string; name: string; decimals: number; kind: AssetKind; address: string }
export interface CircuitFile { path: string; bytes: number; sha256: string }
export type Circuits = Record<'joinsplit' | 'holder-exit', { wasm: CircuitFile; zkey: CircuitFile; vkey: CircuitFile }>;

export interface NetworkInfo {
  name: NetworkName; id: number; label: string; rpc: string; explorer: string; testnet: boolean;
  /** The Lincoln web app: relays (/relay/<pool>), bridge proxy (/bridge) and circuit files are served from it. */
  app: string;
  profiles: Record<string, Profile & { relayer: string }>;
  routes: Record<string, any[]>;
  circuits: Circuits | null;
  assets: AssetMeta[];
}

const NATIVE = '0x0000000000000000000000000000000000000000';

export const NETWORKS: Record<NetworkName, NetworkInfo> = {
  testnet: {
    name: 'testnet', id: 46630, label: 'Robinhood Chain testnet', rpc: 'https://rpc.testnet.chain.robinhood.com/',
    explorer: 'https://explorer.testnet.chain.robinhood.com', testnet: true, app: 'https://app.lincolnprotocol.com',
    profiles: { eth: ethProfile as any, tokenB: tokenBProfile as any },
    routes: { eth: ethRoutes as any[], tokenB: tokenBRoutes as any[] },
    circuits: testnetCircuits as Circuits,
    assets: [
      { symbol: 'ETH', name: 'Ether', decimals: 18, kind: 'native', address: NATIVE },
      { symbol: 'UP', name: 'UP test token', decimals: 18, kind: 'token', address: '0x93d079cd29edf4b25a94e153366e20c8e331558e' },
      { symbol: 'USDG', name: 'Global Dollar · testnet', decimals: 6, kind: 'stable', address: '0x7e955252e15c84f5768b83c41a71f9eba181802f' },
      { symbol: 'TSLA', name: 'Tesla · test stock token', decimals: 18, kind: 'stock', address: '0xc9f9c86933092bbbfff3ccb4b105a4a94bf3bd4e' },
    ],
  },
  // Mainnet pools are added here when Lincoln deploys them (profiles, routes and circuits from the core release).
  mainnet: {
    name: 'mainnet', id: 4663, label: 'Robinhood Chain', rpc: 'https://rpc.mainnet.chain.robinhood.com/',
    explorer: 'https://robinhoodchain.blockscout.com', testnet: false, app: 'https://app.lincolnprotocol.com',
    profiles: {}, routes: {}, circuits: null,
    assets: [
      { symbol: 'ETH', name: 'Ether', decimals: 18, kind: 'native', address: NATIVE },
      { symbol: 'USDG', name: 'Global Dollar', decimals: 6, kind: 'stable', address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168' },
      { symbol: 'NVDA', name: 'NVIDIA', decimals: 18, kind: 'stock', address: '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec' },
    ],
  },
};

/** The selected network; set by selectNetwork(). */
export let NET: NetworkInfo = NETWORKS.testnet;
export function setNet(net: NetworkInfo) { NET = net; }
