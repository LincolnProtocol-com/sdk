import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';

// The relay, pool state and prover are stubbed; the transaction builder is the real SDK, so output counts, note
// selection and change are the ones a live spend would have. These tests drive how a spend prices, binds and
// re-quotes its fee, and when it may prove again.
const MODEL = vi.hoisted(() => ['700000', '1300000', '1800000']);
const relay = vi.hoisted(() => ({
  config: null as any, quotes: [] as any[], submits: [] as any[], reject: [] as any[], ids: 0,
  /** Total fee a quote returns, like the backend: buffered raw gas (the shape's model, or a larger gasUnits) × gas price. */
  price: (r: any) => ((BigInt(r.gasUnits ?? MODEL[r.outputCount]) * 12n + 9n) / 10n) * 30_000_000n,
  ttlMs: 120_000, now: () => Date.now(), stateNotes: [] as bigint[],
}));
vi.mock('./relay.js', async orig => {
  const real = await orig<typeof import('./relay.js')>();
  return {
    ...real,
    relayConfig: async () => relay.config,
    requestFeeQuote: async (_pool: string, r: any) => {
      if (!relay.config.feeQuotes) throw new real.RelayError('UNEXPECTED_FIELDS');
      const n = relay.quotes.length, model = MODEL[r.outputCount];
      const q = { schema: 'lincoln-service-fee-quote/v3', quoteId: String(n).padStart(64, 'a'), kind: r.kind, grossAmount: String(r.grossAmount), outputCount: r.outputCount,
        totalFee: String(relay.price(r)), rawGasUnits: r.gasUnits ? String(r.gasUnits) : model, gasPriceWei: '30000000', expiresAt: new Date(relay.now() + relay.ttlMs).toISOString(), request: r };
      relay.quotes.push(q); return q;
    },
    submitJob: async (_pool: string, job: any) => { relay.submits.push(job); const e = relay.reject.shift(); if (e) throw e; return { id: job.id, status: 'pending' }; },
    waitForJob: async (_pool: string, id: string) => ({ id, status: 'confirmed', hash: '0xabc' }),
    newJobId: () => `job-${++relay.ids}-xxxxxxxx`,
  };
});
vi.mock('./state.js', () => ({ loadPoolState: async () => fixtures.state(relay.stateNotes) }));
vi.mock('./prover.js', () => ({ prove: async () => ({ pi_a: ['1', '1', '1'], pi_b: [['1', '1'], ['1', '1'], ['1', '1']], pi_c: ['1', '1', '1'] }) }));

const sdk = await import('./sdk.js');
const { POOLS, selectNetwork } = await import('./pools.js');
// An unreachable RPC: no chain gas price until a quote supplies one, so first estimates use the policy cap.
selectNetwork('mainnet', { rpc: 'http://127.0.0.1:9' });
const { outputCount, recoveryOf, spend, exitNote } = await import('./operations.js');
const { FEE_POLICY, billingGasPrice, estimateFee, feeBreakdown, forgetServiceFees, gasEstimateUnavailable, loadServiceFees, parseGasPricing, parseServiceFees, priceFee, rememberQuotePrice } = await import('./fees.js');
const { RelayError } = await import('./relay.js');

const pool = 'eth', info = POOLS[pool], profile = info.profile, account = sdk.createAccount('a1'.repeat(32)), self = sdk.receiverAddress(account, profile);
const other = sdk.receiverAddress(sdk.createAccount('5c'.repeat(32)), profile);
const RECIPIENT = '0x2222222222222222222222222222222222222222';
/** A pool holding only this account's notes of the given values, all approved. */
const fixtures = {
  state(values: bigint[]) {
    const notes = values.map((value, i) => sdk.createNote({ value, receiver: self, blinding: BigInt(i + 7) }, profile));
    const commitments = notes.map(n => String(n.commitment)), leaves = commitments.map(c => String(sdk.associationLeaf(BigInt(c), profile)));
    return { root: String(sdk.buildMerkleTree(commitments.map(BigInt)).root), commitments, nullifiers: [], blockTimestamp: '1000',
      asp: { root: String(sdk.buildMerkleTree(leaves.map(BigInt)).root), epoch: '2', validUntil: '9999999999', leaves, expired: false },
      receipts: notes.map((n, index) => ({ commitment: commitments[index], index, encryptedOutput: sdk.encryptReceipt(self, n, profile) })), deposits: [] };
  },
};
const V2 = { schema: 'lincoln-service-fees/v2', id: 'v2', gasFeeUnits: '20000000000000', withdrawal: { bps: 30, includesGas: true }, holderExit: { bps: 30, includesGas: true },
  ragequit: { bps: 0, includesGas: false }, privateTransfer: { fixedUnits: '0', includesGas: true }, swap: { bps: 30 } };
const PRICING = { enabled: true, available: true, unavailableReason: null, gasBufferBps: 2000, maxGasPriceWei: '100000000',
  gasModels: { withdrawal: { 0: '700000', 1: '1300000', 2: '1800000' }, 'private-transfer': { 0: '700000', 1: '1300000', 2: '1800000' }, 'holder-exit': '700000', swap: '2500000' }, assetPrices: [] };
const ETH = 10n ** 18n, onStage = () => undefined;
const fresh = async (feeQuotes: unknown, notes: bigint[]) => {
  relay.config = { serviceFees: V2, feeQuotes }; relay.quotes = []; relay.submits = []; relay.reject = []; relay.ttlMs = 120_000; relay.now = () => Date.now();
  relay.price = r => ((BigInt(r.gasUnits ?? MODEL[r.outputCount]) * 12n + 9n) / 10n) * 30_000_000n;
  relay.stateNotes = notes;
  forgetServiceFees(pool); await loadServiceFees(pool);
};
const fee = (i = 0) => BigInt(relay.submits[i].transaction.extData.fee), outputs = (i = 0) => relay.submits[i].transaction.pubSignals.slice(7, 9).filter((v: string) => BigInt(v) !== 0n).length;
const quoteOf = (i = 0) => relay.quotes.find(q => q.quoteId === relay.submits[i].feeQuoteId);
const withdraw = (amount: bigint, extra: Record<string, unknown> = {}) => spend({ account: structuredClone(account), pool, amount, recipient: RECIPIENT, onStage, ...extra } as any);
const send = (amount: bigint, extra: Record<string, unknown> = {}) => spend({ account: structuredClone(account), pool, amount, receiver: other, onStage, ...extra } as any);

describe('fee estimate from the public gas model', () => {
  it('buffered units × gas price, in the pool asset; no ERC20 price means no estimate', () => {
    const d = parseGasPricing(PRICING, info.asset)!;
    expect(d.price).toEqual({ num: 1n, den: 1n });
    expect(parseGasPricing(PRICING, '0x1111111111111111111111111111111111111111')!.price).toBeNull();
    expect(parseGasPricing(null, info.asset)).toBeUndefined();
    FEE_POLICY.eth = { ...parseServiceFees(V2), dynamic: d };
    const b = feeBreakdown(pool, ETH);
    expect(b.gas).toBe(2_160_000n * 100_000_000n); // 1.8M × 1.2 at the 0.1 gwei cap (no chain read yet)
    expect(b.service).toBe(3n * 10n ** 15n);
    expect(estimateFee(pool, 'withdrawal', ETH, 0)).toBe(3n * 10n ** 15n + 840_000n * 100_000_000n);
    forgetServiceFees(pool);
  });
});

describe('withdrawals: the quote matches the real output count', () => {
  it('exact spend of one note: 0 outputs', async () => {
    await fresh(PRICING, [ETH]);
    await withdraw(ETH);
    expect(outputs()).toBe(0); expect(quoteOf().outputCount).toBe(0); expect(fee()).toBe(BigInt(quoteOf().totalFee));
    expect(relay.quotes).toHaveLength(1); // the dry run on the local estimate found the shape first time
  });
  it('small change below the split minimum: 1 output', async () => {
    await fresh(PRICING, [ETH + 10n ** 15n]);
    await withdraw(ETH);
    expect(outputs()).toBe(1); expect(quoteOf().outputCount).toBe(1);
  });
  it('large change is split: 2 outputs', async () => {
    await fresh(PRICING, [5n * ETH]);
    await withdraw(ETH);
    expect(outputs()).toBe(2); expect(quoteOf().outputCount).toBe(2);
  });
  it('a holder exit quotes shape 0 and pays from the revealed note', async () => {
    await fresh(PRICING, [ETH]);
    const note = sdk.recoverAccount(structuredClone(account), profile, fixtures.state([ETH]) as any).notes[0];
    await exitNote({ account: structuredClone(account), pool, note, recipient: RECIPIENT, onStage });
    expect(relay.submits[0].kind).toBe('holderExit'); expect(quoteOf().outputCount).toBe(0); expect(quoteOf().kind).toBe('holder-exit');
    expect(BigInt(relay.submits[0].transaction.data.fee)).toBe(BigInt(quoteOf().totalFee));
  });
});

describe('private payments: fee changes move the change note', () => {
  it('payment with change: 2 outputs, quoted as gross 0', async () => {
    await fresh(PRICING, [5n * ETH]);
    await send(ETH);
    expect(outputs()).toBe(2); expect(quoteOf()).toMatchObject({ kind: 'private-transfer', grossAmount: '0', outputCount: 2 });
    expect(BigInt(relay.submits[0].transaction.extData.publicOut)).toBe(fee());
  });
  it('one note worth exactly payment + shape-2 fee: settles without proving a mismatched shape', async () => {
    await fresh(PRICING, [ETH + relay.price({ outputCount: 2 })]);
    await send(ETH);
    // Shape 1 (the estimate's shape) leaves change (2 outputs); shape 2 spends the note exactly (1 output): a cycle.
    // The third quote keeps shape 2's gas for shape 1, so the fee holds, the spend stays exact, and proof and quote agree.
    expect(outputs()).toBe(1); expect(quoteOf().outputCount).toBe(1);
    expect(fee()).toBe(BigInt(quoteOf().totalFee)); expect(fee()).toBe(relay.price({ outputCount: 2 }));
    expect(relay.quotes).toHaveLength(3); expect(relay.submits).toHaveLength(1);
  });
  it('spending every ready note to one recipient: 1 output', async () => {
    const feeOne = relay.price({ outputCount: 1 });
    await fresh(PRICING, [ETH + feeOne]);
    await send(ETH, { fee: await priceFee(pool, 'private-transfer', 0n, { outputCount: 1 }) });
    expect(outputs()).toBe(1); expect(quoteOf().outputCount).toBe(1);
  });
});

describe('fee hints and limits', () => {
  it('a hinted fee of the wrong shape is replaced, within the approved ceiling', async () => {
    await fresh(PRICING, [ETH]); // exact: shape 0
    const hint = await priceFee(pool, 'withdrawal', ETH); // shape 2 estimate, the larger fee
    await withdraw(ETH, { fee: hint, maxFee: hint.fee });
    expect(outputs()).toBe(0); expect(fee()).toBeLessThan(hint.fee); expect(quoteOf().outputCount).toBe(0);
  });
  it('a fee above the approved ceiling stops before proving', async () => {
    await fresh(PRICING, [5n * ETH]);
    await expect(withdraw(ETH, { maxFee: 1n })).rejects.toThrow(/above what was approved/);
    expect(relay.submits).toHaveLength(0);
  });
});

describe('bridge orders are placed from the final fee', () => {
  it('deposit amount == gross − proved fee, for each shape', async () => {
    for (const [notes, shape] of [[[ETH], 0], [[ETH + 10n ** 15n], 1], [[5n * ETH], 2]] as [bigint[], number][]) {
      await fresh(PRICING, notes);
      const orders: bigint[] = [];
      await withdraw(ETH, { recipient: async (f: bigint) => { orders.push(ETH - f); return '0x3333333333333333333333333333333333333333'; } });
      expect(orders).toHaveLength(1);
      expect(orders[0]).toBe(ETH - fee());
      expect(outputs()).toBe(shape);
      expect(relay.submits[0].transaction.extData.recipient.toLowerCase()).toBe('0x3333333333333333333333333333333333333333');
    }
  });
  it('after the order is placed the fee is fixed: a changed re-quote stops instead of re-pricing', async () => {
    await fresh(PRICING, [5n * ETH]);
    relay.ttlMs = 1_000; // the quote expires while proving
    let placed = 0;
    const base = relay.price; relay.price = r => base(r) + BigInt(relay.quotes.length) * 7n; // every quote differs
    await expect(withdraw(ETH, { recipient: async () => { placed++; return RECIPIENT; } })).rejects.toThrow(/fee changed/);
    expect(placed).toBe(1); expect(relay.submits).toHaveLength(0);
  });
});

describe('quote expiry during proving', () => {
  it('identical fee: the proof is kept and submitted with the new quote', async () => {
    await fresh(PRICING, [5n * ETH]);
    relay.ttlMs = 1_000;
    await withdraw(ETH);
    expect(relay.quotes.length).toBeGreaterThanOrEqual(2);
    expect(relay.submits).toHaveLength(1); expect(relay.submits[0].feeQuoteId).toBe(relay.quotes.at(-1).quoteId);
  });
  it('changed fee: a new proof with the new fee', async () => {
    await fresh(PRICING, [5n * ETH]);
    let rounds = 0;
    const base = relay.price; relay.ttlMs = 1_000; relay.price = r => base(r) + (rounds++ < 2 ? 0n : 9n);
    relay.now = () => Date.now() + (rounds >= 3 ? 10 ** 9 : 0); // the third quote lives long enough to be proved
    await withdraw(ETH);
    expect(relay.submits).toHaveLength(1); expect(fee()).toBe(BigInt(quoteOf().totalFee));
  });
});

describe('what a refused submit allows', () => {
  const err = (code: string, info: Record<string, unknown>) => new RelayError(code, info as any);
  it('classifies the relay recovery fields, failing closed on anything partial', () => {
    expect(recoveryOf(err('FEE_QUOTE_COST_EXCEEDED', { jobPersisted: false, jobMayContinue: false, retrySameId: true, jobStatus: 'not-created' }))).toBe('unused');
    expect(recoveryOf(err('FEE_QUOTE_EXPIRED', { jobPersisted: true, jobMayContinue: false, retrySameId: false, jobStatus: 'cancelled' }))).toBe('terminal');
    expect(recoveryOf(err('PENDING_NONCE', { jobPersisted: true, jobMayContinue: false, retrySameId: true, recovery: 'RETRY_IDENTICAL_REQUEST_WITH_ORIGINAL_ID' }))).toBe('identical');
    expect(recoveryOf(err('FEE_QUOTE_COST_EXCEEDED', {}))).toBe('uncertain'); // no fields at all
    expect(recoveryOf(err('FEE_QUOTE_COST_EXCEEDED', { retrySameId: true }))).toBe('uncertain'); // partial
    expect(recoveryOf(err('FEE_QUOTE_COST_EXCEEDED', { jobPersisted: null, jobMayContinue: false, retrySameId: true }))).toBe('uncertain');
    expect(recoveryOf(err('FEE_QUOTE_COST_EXCEEDED', { jobPersisted: false, jobMayContinue: true, retrySameId: false }))).toBe('uncertain');
    expect(recoveryOf(err('STALE_ASP_PROOF', { jobPersisted: true, jobMayContinue: false, retrySameId: false, jobStatus: 'pending' }))).toBe('uncertain');
    expect(recoveryOf(err('HTTP_504', { jobPersisted: false, jobMayContinue: false, retrySameId: true }))).toBe('uncertain'); // the answer was lost
  });
  it('cost exceeded before any job: re-quotes on the relay estimate with the same, unused ID', async () => {
    await fresh(PRICING, [5n * ETH]);
    relay.reject.push(err('FEE_QUOTE_COST_EXCEEDED', { jobPersisted: false, jobMayContinue: false, retrySameId: true, jobStatus: 'not-created', feeRequote: { rawGasUnits: '2500000', gasPriceWei: '40000000' } }));
    await withdraw(ETH);
    expect(relay.submits).toHaveLength(2);
    expect(relay.submits[1].id).toBe(relay.submits[0].id);
    expect(quoteOf(1).request.gasUnits).toBe(2_500_000n); expect(fee(1)).toBe(BigInt(quoteOf(1).totalFee)); expect(fee(1)).toBeGreaterThan(fee(0));
  });
  it('a stored job the relay cancelled: the new transaction gets a new ID', async () => {
    await fresh(PRICING, [5n * ETH]);
    relay.reject.push(err('FEE_QUOTE_EXPIRED', { jobPersisted: true, jobMayContinue: false, retrySameId: false, jobStatus: 'cancelled' }));
    await withdraw(ETH);
    expect(relay.submits).toHaveLength(2); expect(relay.submits[1].id).not.toBe(relay.submits[0].id);
  });
  it('a pending or unknown job is followed under its ID, never re-proved', async () => {
    for (const info of [{ jobPersisted: true, jobMayContinue: true, retrySameId: false, jobStatus: 'pending' }, { jobPersisted: null, jobMayContinue: false, retrySameId: true }, {}]) {
      await fresh(PRICING, [5n * ETH]);
      relay.reject.push(err('FEE_QUOTE_COST_EXCEEDED', info));
      // mayHaveRun → wait on the job (confirmed by the stub); otherwise the error surfaces. Either way: one submit only.
      await withdraw(ETH).catch(() => undefined);
      expect(relay.submits).toHaveLength(1);
    }
  });
  it('a lost answer (504) waits on the job and never sends a second payment', async () => {
    await fresh(PRICING, [5n * ETH]);
    relay.reject.push(err('HTTP_504', {}));
    await withdraw(ETH);
    expect(relay.submits).toHaveLength(1);
  });
});

describe('pricing mode changes', () => {
  it('fixed → dynamic after the schedule was read: FEE_QUOTE_REQUIRED reloads it and proves with a quote', async () => {
    await fresh(null, [5n * ETH]);
    relay.config = { serviceFees: V2, feeQuotes: PRICING };
    relay.reject.push(new RelayError('FEE_QUOTE_REQUIRED', { jobPersisted: false, jobMayContinue: false, retrySameId: true, jobStatus: 'not-created' }));
    await withdraw(ETH);
    expect(relay.submits[0].feeQuoteId).toBeUndefined(); expect(relay.submits[1].feeQuoteId).toBe(relay.quotes[0].quoteId);
  });
  it('dynamic → fixed before the quote: the quote request fails, the schedule is re-read once and the fixed fee is proved', async () => {
    await fresh(PRICING, [5n * ETH]);
    relay.config = { serviceFees: V2, feeQuotes: null };
    await withdraw(ETH);
    expect(relay.quotes).toHaveLength(0); expect(relay.submits[0].feeQuoteId).toBeUndefined();
    expect(fee()).toBe(ETH * 30n / 10_000n + 20_000_000_000_000n);
  });
  it('dynamic → fixed after the quote: FEE_QUOTE_DISABLED on submit re-proves without a quote', async () => {
    await fresh(PRICING, [5n * ETH]);
    relay.reject.push(new RelayError('FEE_QUOTE_DISABLED', { jobPersisted: false, jobMayContinue: false, retrySameId: true, jobStatus: 'not-created' }));
    relay.config = { serviceFees: V2, feeQuotes: null };
    await withdraw(ETH);
    expect(relay.submits).toHaveLength(2); expect(relay.submits[1].feeQuoteId).toBeUndefined();
  });
  it('no fresh price for the asset: spends pause instead of guessing', async () => {
    await fresh({ ...PRICING, available: false, unavailableReason: 'GAS_ASSET_PRICE_STALE' }, [5n * ETH]);
    await expect(withdraw(ETH)).rejects.toThrow(/out of date/);
    expect(relay.submits).toHaveLength(0);
  });
  it('fixed schedules keep the old flow: no quote, no quote ID', async () => {
    await fresh(null, [5n * ETH]);
    await withdraw(ETH);
    expect(relay.quotes).toHaveLength(0); expect(relay.submits[0].feeQuoteId).toBeUndefined();
  });
});

describe('outputCount', () => {
  it('counts non-zero commitments only', () => {
    expect(outputCount('joinsplit', { inputSignals: {}, publicSignals: ['1', '0', '1', '1', '1', '1', '1', '0', '0'] })).toBe(0);
    expect(outputCount('joinsplit', { inputSignals: {}, publicSignals: ['1', '0', '1', '1', '1', '1', '1', '5', '0'] })).toBe(1);
    expect(outputCount('holder-exit', { inputSignals: {}, publicSignals: ['1', '1', '1', '1', '1'] })).toBe(0);
  });
});

describe('base-fee billing (lincoln-base-fee-billing/v1)', () => {
  it('price = max(ceil(base × multiplier), base + addition) capped; billed units carry only the billing buffer; no estimate above the cap', () => {
    const BILLING = { ...PRICING, gasBufferBps: 0, executionGasBufferBps: 2000, billingGasPrice: { schema: 'lincoln-base-fee-billing/v1', multiplierBps: 11000, minimumAdditionWei: '0' },
      gasModels: { ...PRICING.gasModels, withdrawal: { 0: '600000', 1: '1200000', 2: '1720000' } } };
    const d = parseGasPricing(BILLING, info.asset)!;
    expect(d.billing).toEqual({ multiplierBps: 11000, minAdditionWei: 0n }); expect(d.bufferBps).toBe(0);
    expect(billingGasPrice(d, 20_000_000n)).toBe(22_000_000n);
    expect(billingGasPrice(d, 95_000_000n)).toBe(100_000_000n); // the relay's cap
    expect(billingGasPrice({ ...d, billing: { multiplierBps: 10_000, minAdditionWei: 5_000_000n } }, 20_000_000n)).toBe(25_000_000n);
    expect(billingGasPrice(parseGasPricing(PRICING, info.asset)!, 20_000_000n)).toBe(40_000_000n); // no billing policy: the signing price
    expect(billingGasPrice(d, null)).toBeNull();
    FEE_POLICY.eth = { ...parseServiceFees(V2), dynamic: d };
    rememberQuotePrice({ baseFeePerGas: '20000000', gasPriceWei: '22000000' });
    // The handoff's example: one-output withdrawal of 0.001 ETH at a 0.02 gwei base fee costs 0.000003 + 0.0000264 ETH.
    expect(estimateFee(pool, 'withdrawal', 10n ** 15n, 1)).toBe(3n * 10n ** 12n + 26_400_000_000_000n);
    expect(gasEstimateUnavailable(d)).toBeNull();
    rememberQuotePrice({ baseFeePerGas: '150000000' });
    expect(gasEstimateUnavailable(d)).toBe('FEE_QUOTES_UNAVAILABLE');
    expect(gasEstimateUnavailable({ ...d, available: false, unavailableReason: 'GAS_ASSET_PRICE_STALE' })).toBe('GAS_ASSET_PRICE_STALE');
    forgetServiceFees(pool);
  });
});
