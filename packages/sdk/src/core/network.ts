// Which Robinhood Chain a process talks to. Unlike the web app (one network per build), the SDK picks
// it at runtime: selectNetwork() fills POOLS, the chain client and the service URLs, and must run
// before any other call (Lincoln.open does this). Pool profiles, swap routes and circuit pins ship
// with the package and are never taken from a relay, so a relay cannot redirect funds.
import ethProfile from '../networks/testnet/profile.eth.json' with { type: 'json' };
import tokenBProfile from '../networks/testnet/profile.tokenB.json' with { type: 'json' };
import ethRoutes from '../networks/testnet/routes.eth.json' with { type: 'json' };
import tokenBRoutes from '../networks/testnet/routes.tokenB.json' with { type: 'json' };
import testnetCircuits from '../networks/testnet/circuits.json' with { type: 'json' };
import m_ethProfile from '../networks/mainnet/profile.eth.json' with { type: 'json' };
import m_ethRoutes from '../networks/mainnet/routes.eth.json' with { type: 'json' };
import m_usdgProfile from '../networks/mainnet/profile.usdg.json' with { type: 'json' };
import m_usdgRoutes from '../networks/mainnet/routes.usdg.json' with { type: 'json' };
import m_nvdaProfile from '../networks/mainnet/profile.nvda.json' with { type: 'json' };
import m_nvdaRoutes from '../networks/mainnet/routes.nvda.json' with { type: 'json' };
import m_spyProfile from '../networks/mainnet/profile.spy.json' with { type: 'json' };
import m_spyRoutes from '../networks/mainnet/routes.spy.json' with { type: 'json' };
import m_metaProfile from '../networks/mainnet/profile.meta.json' with { type: 'json' };
import m_metaRoutes from '../networks/mainnet/routes.meta.json' with { type: 'json' };
import m_tslaProfile from '../networks/mainnet/profile.tsla.json' with { type: 'json' };
import m_tslaRoutes from '../networks/mainnet/routes.tsla.json' with { type: 'json' };
import m_googlProfile from '../networks/mainnet/profile.googl.json' with { type: 'json' };
import m_googlRoutes from '../networks/mainnet/routes.googl.json' with { type: 'json' };
import m_qqqProfile from '../networks/mainnet/profile.qqq.json' with { type: 'json' };
import m_qqqRoutes from '../networks/mainnet/routes.qqq.json' with { type: 'json' };
import m_mstrProfile from '../networks/mainnet/profile.mstr.json' with { type: 'json' };
import m_mstrRoutes from '../networks/mainnet/routes.mstr.json' with { type: 'json' };
import m_aaplProfile from '../networks/mainnet/profile.aapl.json' with { type: 'json' };
import m_aaplRoutes from '../networks/mainnet/routes.aapl.json' with { type: 'json' };
import m_usdeProfile from '../networks/mainnet/profile.usde.json' with { type: 'json' };
import m_usdeRoutes from '../networks/mainnet/routes.usde.json' with { type: 'json' };
import m_ponsProfile from '../networks/mainnet/profile.pons.json' with { type: 'json' };
import m_ponsRoutes from '../networks/mainnet/routes.pons.json' with { type: 'json' };
import m_cashcatProfile from '../networks/mainnet/profile.cashcat.json' with { type: 'json' };
import m_cashcatRoutes from '../networks/mainnet/routes.cashcat.json' with { type: 'json' };
import mainnetCircuits from '../networks/mainnet/circuits.json' with { type: 'json' };
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
  // Core release RC.3 (privacy-frontend scripts/sync-asp-mainnet.mjs copies it; this package mirrors those files).
  mainnet: {
    name: 'mainnet', id: 4663, label: 'Robinhood Chain', rpc: 'https://rpc.mainnet.chain.robinhood.com/',
    explorer: 'https://robinhoodchain.blockscout.com', testnet: false, app: 'https://app.lincolnprotocol.com',
    profiles: { eth: m_ethProfile as any, usdg: m_usdgProfile as any, nvda: m_nvdaProfile as any, spy: m_spyProfile as any, meta: m_metaProfile as any, tsla: m_tslaProfile as any, googl: m_googlProfile as any, qqq: m_qqqProfile as any, mstr: m_mstrProfile as any, aapl: m_aaplProfile as any, usde: m_usdeProfile as any, pons: m_ponsProfile as any, cashcat: m_cashcatProfile as any },
    routes: { eth: m_ethRoutes as any[], usdg: m_usdgRoutes as any[], nvda: m_nvdaRoutes as any[], spy: m_spyRoutes as any[], meta: m_metaRoutes as any[], tsla: m_tslaRoutes as any[], googl: m_googlRoutes as any[], qqq: m_qqqRoutes as any[], mstr: m_mstrRoutes as any[], aapl: m_aaplRoutes as any[], usde: m_usdeRoutes as any[], pons: m_ponsRoutes as any[], cashcat: m_cashcatRoutes as any[] },
    circuits: mainnetCircuits as Circuits,
    assets: [
      { symbol: 'ETH', name: 'Ether', decimals: 18, kind: 'native', address: NATIVE },
      { symbol: 'USDG', name: 'Global Dollar', decimals: 6, kind: 'stable', address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168' },
      { symbol: 'NVDA', name: 'NVIDIA', decimals: 18, kind: 'stock', address: '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec' },
      { symbol: 'SPY', name: 'SPDR S&P 500 ETF', decimals: 18, kind: 'stock', address: '0x117cc2133c37b721f49de2a7a74833232b3b4c0c' },
      { symbol: 'META', name: 'Meta Platforms', decimals: 18, kind: 'stock', address: '0xc0d6457c16cc70d6790dd43521c899c87ce02f35' },
      { symbol: 'TSLA', name: 'Tesla', decimals: 18, kind: 'stock', address: '0x322f0929c4625ed5bad873c95208d54e1c003b2d' },
      { symbol: 'GOOGL', name: 'Alphabet', decimals: 18, kind: 'stock', address: '0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3' },
      { symbol: 'QQQ', name: 'Invesco QQQ', decimals: 18, kind: 'stock', address: '0xd5f3879160bc7c32ebb4dc785f8a4f505888de68' },
      { symbol: 'MSTR', name: 'Strategy', decimals: 18, kind: 'stock', address: '0xec262a75e413fafd0df80480274532c79d42da09' },
      { symbol: 'AAPL', name: 'Apple', decimals: 18, kind: 'stock', address: '0xaf3d76f1834a1d425780943c99ea8a608f8a93f9' },
      { symbol: 'USDe', name: 'Ethena USDe', decimals: 18, kind: 'stable', address: '0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34' },
      { symbol: 'PONS', name: 'Pons', decimals: 18, kind: 'token', address: '0x39dbed3a2bd333467115de45665cc57f813c4571' },
      { symbol: 'CASHCAT', name: 'Cash Cat', decimals: 18, kind: 'token', address: '0x020bfc650a365f8bb26819deaabf3e21291018b4' },
    ],
  },
};

/** The selected network; set by selectNetwork(). */
export let NET: NetworkInfo = NETWORKS.testnet;
export function setNet(net: NetworkInfo) { NET = net; }
