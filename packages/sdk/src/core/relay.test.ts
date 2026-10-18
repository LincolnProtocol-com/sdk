import { afterEach, describe, expect, it, vi } from 'vitest';
const { selectNetwork } = await import('./pools.js');
selectNetwork('mainnet', { rpc: 'http://127.0.0.1:9' });
const { RelayError, waitForJob } = await import('./relay.js');

const reply = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
afterEach(() => vi.unstubAllGlobals());

describe('waitForJob after a lost submit answer', () => {
  it('rides out JOB_NOT_FOUND and dropped connections until the job confirms', async () => {
    const answers = [() => reply({ error: 'JOB_NOT_FOUND' }, 400), () => Promise.reject(new TypeError('fetch failed')), () => reply({ error: 'RELAY_UNREACHABLE' }, 502), () => reply({ id: 'x', status: 'pending' }), () => reply({ id: 'x', status: 'confirmed', hash: '0xabc' })];
    vi.stubGlobal('fetch', vi.fn(() => answers.shift()!()));
    expect((await waitForJob('eth', 'job-123456', { unsure: true, pollMs: 1 })).hash).toBe('0xabc');
  });
  it('a sure submit followed by JOB_NOT_FOUND is the relay’s answer', async () => {
    vi.stubGlobal('fetch', vi.fn(() => reply({ error: 'JOB_NOT_FOUND' }, 400)));
    await expect(waitForJob('eth', 'job-123456', { unsure: false, pollMs: 1 })).rejects.toBeInstanceOf(RelayError);
  });
  it('surfaces a revert and stops on a cancelled job', async () => {
    vi.stubGlobal('fetch', vi.fn(() => reply({ id: 'x', status: 'reverted', hash: '0xdef' })));
    await expect(waitForJob('eth', 'job-123456', { pollMs: 1 })).rejects.toThrow(/reverted/);
    vi.stubGlobal('fetch', vi.fn(() => reply({ id: 'x', status: 'cancelled', recovery: 'QUERY_JOB_WITH_ORIGINAL_ID' })));
    await expect(waitForJob('eth', 'job-123456', { pollMs: 1 })).rejects.toThrow(/before sending anything/);
  });
});

describe('waitForJob after a lost submit answer: fast status reads (relay generation 6)', () => {
  const processing = { error: 'JOB_NOT_FOUND', jobPersisted: false, jobStatus: 'processing', jobMayContinue: true, retrySameId: false, useNewId: false, recovery: 'QUERY_JOB_WITH_ORIGINAL_ID' };
  const never = { error: 'JOB_NOT_FOUND', jobPersisted: false, jobStatus: 'not-created', jobMayContinue: false, retrySameId: true, useNewId: false, recovery: 'FIX_CAUSE_AND_RETRY_SAME_ID' };
  it('a 404 while our request is still being processed keeps following the original ID', async () => {
    const answers = [() => reply(processing, 404), () => reply(processing, 404), () => reply({ id: 'x', status: 'pending' }), () => reply({ id: 'x', status: 'confirmed', hash: '0xaa' })];
    vi.stubGlobal('fetch', vi.fn(() => answers.shift()!()));
    expect((await waitForJob('eth', 'job-123456', { unsure: true, pollMs: 1 })).hash).toBe('0xaa');
  });
  it('an explicit "not created" verdict counts only once the request can no longer be in flight, and only twice in a row', async () => {
    const answers = [() => reply(never, 404), () => reply(never, 404), () => reply(processing, 404), () => reply(never, 404), () => reply({ id: 'x', status: 'confirmed', hash: '0xbb' })];
    vi.stubGlobal('fetch', vi.fn(() => answers.shift()!()));
    // Within the in-flight window two verdicts in a row are not final; a processing answer resets the count.
    expect((await waitForJob('eth', 'job-123456', { unsure: true, pollMs: 1, inFlightMs: 60_000 })).hash).toBe('0xbb');
    const fetch2 = vi.fn(() => reply(never, 404)); vi.stubGlobal('fetch', fetch2);
    await expect(waitForJob('eth', 'job-123456', { unsure: true, pollMs: 1, inFlightMs: 0 })).rejects.toThrow(/did not receive/);
    expect(fetch2).toHaveBeenCalledTimes(2);
  });
  it('missing or contradictory recovery fields never end in "nothing was sent": the outcome stays unknown and the ID is kept', async () => {
    for (const body of [{ error: 'JOB_NOT_FOUND' }, { ...never, useNewId: true }, { ...never, jobMayContinue: true }, { ...never, jobStatus: undefined }, { ...never, transactionHash: '0x1' }]) {
      vi.stubGlobal('fetch', vi.fn(() => reply(body, 404)));
      await expect(waitForJob('eth', 'job-123456', { unsure: true, pollMs: 1, inFlightMs: 0, timeoutMs: 20 })).rejects.toThrow(/outcome is unknown.*job-123456|job job-123456.*unknown/s);
    }
  });
  it('a job that was seen and then vanishes is the relay’s answer, not a hiccup', async () => {
    const answers = [() => reply({ id: 'x', status: 'pending' }), () => reply({ error: 'JOB_NOT_FOUND' }, 404)];
    vi.stubGlobal('fetch', vi.fn(() => answers.shift()!()));
    await expect(waitForJob('eth', 'job-123456', { unsure: true, pollMs: 1 })).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });
  });
});
