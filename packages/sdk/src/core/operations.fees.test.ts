import { beforeEach, describe, expect, it, vi } from 'vitest';

// Relay, state, prover and the SDK builder are stubbed: these tests drive only how a spend prices, binds and re-quotes its fee.
const relay = vi.hoisted(() => ({ config: null as any, quotes: [] as any[], submits: [] as any[], reject: [] as any[], ids: 0 }));
vi.mock('./relay.js', async orig => {
  const real = await orig<typeof import('./relay.js')>();
  return {
    ...real,
    relayConfig: async () => relay.config,
    requestFeeQuote: async (_pool: string, r: any) => {
      const n = relay.quotes.length, total = 1000n + BigInt(n) * (r.gasUnits ? 500n : 0n);
      const q = { schema: 'lincoln-service-fee-quote/v3', quoteId: String(n).padStart(64, 'a'), kind: r.kind, grossAmount: String(r.grossAmount), outputCount: r.outputCount,
        totalFee: String(total), gasPriceWei: '30000000', expiresAt: new Date(Date.now() + 120_000).toISOString(), request: r };
      relay.quotes.push(q); return q;
    },
    submitJob: async (_pool: string, job: any) => { relay.submits.push(job); const e = relay.reject.shift(); if (e) throw e; return { id: job.id, status: 'pending' }; },
    waitForJob: async (_pool: string, id: string) => ({ id, status: 'confirmed', hash: '0xabc' }),
    newJobId: () => `job-${++relay.ids}-xxxxxxxx`,
  };
});
vi.mock('./state.js', () => ({ loadPoolState: async () => ({ asp: { leaves: ['1'], expired: false } }) }));
vi.mock('./prover.js', () => ({ prove: async () => ({}) }));
vi.mock('./sdk.js', async orig => ({
  ...(await orig<typeof import('./sdk.js')>()),
  prepareJoinSplit: ({ externalData }: any) => ({ inputSignals: {}, publicSignals: ['1', '0', String(externalData.publicOut), '1', '1', '1', '1', '5', '6'], extData: externalData }),
  publicTransaction: (p: any) => ({ extData: p.extData }),
  rememberOutputs: () => undefined,
}));

const { selectNetwork } = await import('./pools.js');
// An unreachable RPC: no chain gas price, so estimates use the policy cap.
selectNetwork('mainnet', { rpc: 'http://127.0.0.1:9' });
const { spend } = await import('./operations.js');
const { FEE_POLICY, feeBreakdown, forgetServiceFees, loadServiceFees, parseGasPricing, parseServiceFees } = await import('./fees.js');
const { RelayError } = await import('./relay.js');
const { POOLS } = await import('./pools.js');

const V2 = { schema: 'lincoln-service-fees/v2', id: 'v2', gasFeeUnits: '20000000000000', withdrawal: { bps: 30, includesGas: true }, holderExit: { bps: 30, includesGas: true },
  ragequit: { bps: 0, includesGas: false }, privateTransfer: { fixedUnits: '0', includesGas: true }, swap: { bps: 30 } };
const PRICING = { enabled: true, available: true, unavailableReason: null, gasBufferBps: 2000, maxGasPriceWei: '100000000',
  gasModels: { withdrawal: { 0: '700000', 1: '1300000', 2: '1800000' }, 'private-transfer': { 0: '700000', 1: '1300000', 2: '1800000' }, 'holder-exit': '700000', swap: '2500000' }, assetPrices: [] };
const pool = 'eth', amount = 10n ** 16n, account = {} as any, onStage = () => undefined;
const fresh = async (feeQuotes: unknown) => {
  relay.config = { serviceFees: V2, feeQuotes }; relay.quotes = []; relay.submits = []; relay.reject = [];
  forgetServiceFees(pool);
};

describe('dynamic relay fees', () => {
  beforeEach(() => vi.useRealTimers());

  it('estimates gas from the public model: buffered units × price, in the pool asset', () => {
    const d = parseGasPricing(PRICING, POOLS.eth.asset)!;
    expect(d.price).toEqual({ num: 1n, den: 1n }); // ETH pays gas 1:1 in wei
    expect(parseGasPricing(PRICING, '0x1111111111111111111111111111111111111111')!.price).toBeNull(); // no ERC20 price: no estimate
    expect(parseGasPricing(null, POOLS.eth.asset)).toBeUndefined();
    FEE_POLICY.eth = { ...parseServiceFees(V2), dynamic: d };
    const b = feeBreakdown('eth', 10n ** 18n);
    // 1.8M × 1.2 = 2.16M gas at the 0.1 gwei cap (no chain read yet) = 216e12 wei.
    expect(b.gas).toBe(2_160_000n * 100_000_000n);
    expect(b.service).toBe(3n * 10n ** 15n);
    expect(b.estimated).toBe(true);
  });

  it('a withdrawal proves the quoted fee and submits the quote ID', async () => {
    await fresh(PRICING); await loadServiceFees(pool, async () => relay.config);
    await spend({ account, pool, amount, recipient: '0x2222222222222222222222222222222222222222', onStage });
    expect(relay.quotes).toHaveLength(1);
    expect(relay.quotes[0].request).toMatchObject({ kind: 'withdrawal', grossAmount: amount, outputCount: 2 });
    expect(relay.submits[0].feeQuoteId).toBe(relay.quotes[0].quoteId);
    expect(relay.submits[0].transaction.extData.fee).toBe(1000n);
  });

  it('a private send is quoted with gross 0 and pays the fee as its only public output', async () => {
    await fresh(PRICING); await loadServiceFees(pool, async () => relay.config);
    await spend({ account, pool, amount, receiver: { ownerPublicKey: 1n, encryptionKey: '0x' } as any, onStage });
    expect(relay.quotes[0].request).toMatchObject({ kind: 'private-transfer', grossAmount: 0n });
    expect(relay.submits[0].transaction.extData).toMatchObject({ fee: 1000n, publicOut: 1000n });
  });

  it('cost exceeded: re-quotes with the relay estimate and re-proves; a cancelled job gets a new ID', async () => {
    await fresh(PRICING); await loadServiceFees(pool, async () => relay.config);
    relay.reject.push(new RelayError('FEE_QUOTE_COST_EXCEEDED', { retrySameId: false, jobMayContinue: false, feeRequote: { rawGasUnits: '2500000', gasPriceWei: '40000000' } }));
    await spend({ account, pool, amount, recipient: '0x2222222222222222222222222222222222222222', onStage });
    expect(relay.quotes).toHaveLength(2);
    expect(relay.quotes[1].request.gasUnits).toBe(2_500_000n);
    expect(relay.submits).toHaveLength(2);
    expect(relay.submits[1].feeQuoteId).toBe(relay.quotes[1].quoteId);
    expect(relay.submits[1].transaction.extData.fee).toBe(1500n);
    expect(relay.submits[1].id).not.toBe(relay.submits[0].id);
  });

  it('a pre-priced bridge withdrawal never proves a different fee', async () => {
    await fresh(PRICING); await loadServiceFees(pool, async () => relay.config);
    relay.reject.push(new RelayError('FEE_QUOTE_COST_EXCEEDED', { retrySameId: true, feeRequote: { rawGasUnits: '2500000', gasPriceWei: '40000000' } }));
    const { priceFee } = await import('./fees.js');
    const fee = await priceFee(pool, 'withdrawal', amount);
    await expect(spend({ account, pool, amount, fee, recipient: '0x2222222222222222222222222222222222222222', onStage })).rejects.toThrow(/fee changed/);
    expect(relay.submits).toHaveLength(1);
  });

  it('fixed schedules keep the old flow: no quote, no quote ID', async () => {
    await fresh(null); await loadServiceFees(pool, async () => relay.config);
    await spend({ account, pool, amount, recipient: '0x2222222222222222222222222222222222222222', onStage });
    expect(relay.quotes).toHaveLength(0);
    expect(relay.submits[0].feeQuoteId).toBeUndefined();
    expect(relay.submits[0].transaction.extData.fee).toBe(amount * 30n / 10_000n + 20_000_000_000_000n);
  });

  it('a relay that turned on quotes after the page loaded: reloads its schedule and re-proves with a quote', async () => {
    await fresh(null); await loadServiceFees(pool, async () => relay.config);
    relay.config = { serviceFees: V2, feeQuotes: PRICING };
    relay.reject.push(new RelayError('FEE_QUOTE_REQUIRED', { retrySameId: true }));
    await spend({ account, pool, amount, recipient: '0x2222222222222222222222222222222222222222', onStage });
    expect(relay.submits[0].feeQuoteId).toBeUndefined();
    expect(relay.submits[1].feeQuoteId).toBe(relay.quotes[0].quoteId);
  });

  it('a relay without a price for the asset pauses spends instead of guessing', async () => {
    await fresh({ ...PRICING, available: false, unavailableReason: 'GAS_ASSET_PRICE_STALE' }); await loadServiceFees(pool, async () => relay.config);
    await expect(spend({ account, pool, amount, recipient: '0x2222222222222222222222222222222222222222', onStage })).rejects.toThrow(/out of date/);
    expect(relay.submits).toHaveLength(0);
  });
});
