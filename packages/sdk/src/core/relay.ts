// Client for the ASP relay (/v3). The relay only submits canonical proof transactions it can
// verify; it never sees notes, keys or witnesses.
import { POOLS, type PoolId } from './pools.js';

export type JobKind = 'transact' | 'holderExit' | 'ragequit' | 'swap';
export type JobStatus = 'preparing' | 'signed' | 'pending' | 'confirmed' | 'reverted' | 'cancelled';
export interface RelayJob { id: string; kind: JobKind; routeId: string | null; status: JobStatus; nonce: number; hash?: string; blockNumber?: string; feeWei?: string; feeCeilingWei: string }
export type PublisherStatus = 'running' | 'paused' | 'blocked' | 'unknown';
export interface RelayHealth {
  ok: boolean; blockNumber: string; relaySigning: boolean; normalSpendingReady: boolean; publicExitsReady: boolean;
  asp: { root: string; epoch: string; validUntil: string; expired: boolean; setAvailable: boolean; spendable?: boolean; suspended?: boolean; providerRotated?: boolean };
  /** ASP publishing cadence: the next round can come no earlier than last + interval. */
  lastPublicationTimestamp?: string; minPublishIntervalSeconds?: number;
  publisher?: { status: PublisherStatus; reason: string; checkedAt: string; freshness?: { status: 'fresh' | 'stale'; ageSeconds: number } };
}
export interface NetQuote { grossAmountOut: string; serviceFeeBps: number; serviceFeeAmount: string; netAmountOut: string; minNetOut: string; minGrossOut: string; maxServiceFee: string; slippageBPS: number }
/** amountOut/minAmountOut are gross DEX output. Paid routes add netQuote: what reaches the target pool after the adapter fee. */
export interface Quote { routeId: string; protocol: string; amountIn: string; amountOut: string; minAmountOut: string; slippageBPS: number; deadline: string; blockNumber: string; gasEstimate?: string;
  adapterType?: string; serviceFeeBps?: number; netQuote?: NetQuote }
export const quoteOut = (q: Quote) => BigInt(q.netQuote?.netAmountOut ?? q.amountOut);
export const quoteMinOut = (q: Quote) => BigInt(q.netQuote?.minNetOut ?? q.minAmountOut);

const MESSAGES: Record<string, string> = {
  RELAY_DISABLED: 'The relay is not signing transactions right now.',
  ASP_POLICY_UNAVAILABLE: 'No association set is usable right now (expired or paused), so private sends and withdrawals pause. Public exit still works.',
  STALE_ASP_PROOF: 'The association set updated while proving. Try again to prove against the new one.',
  ASP_POLICY_ENDING: 'The association set is about to update. Try again to prove against the new one.',
  RAGEQUIT_TO_ROUTE_ADAPTER: 'This note came from a swap, so “return to depositor” would pay the swap contract. Use a public exit to an address instead.',
  QUOTE_BUSY: 'The quote service is busy. Retrying shortly…',
  ASP_ARTIFACT_ABI_OUTDATED: 'The relay is misconfigured (outdated contract interface). Please report this to the Lincoln team.',
  NULLIFIER_SPENT: 'This note was already spent.',
  NULLIFIER_RESERVED: 'This note is already being spent by another relay job.',
  UNKNOWN_PROOF_ROOT: 'The pool moved on while proving. Try again.',
  RELAY_UNRESOLVED_TRANSACTION: 'The relay is finishing another transaction. Try again in a few seconds.',
  PENDING_NONCE: 'The relay is finishing another transaction. Try again in a few seconds.',
  RELAY_GAS_BUDGET: 'The relay’s gas budget is used up for now. Try again later.',
  RELAY_REQUEST_QUEUE_FULL: 'The relay is busy. Try again shortly.',
  EXPIRED_SWAP: 'The quote expired. Get a new quote.',
  QUOTE_UNAVAILABLE: 'Quotes are unavailable for this route.',
  ID_CONFLICT: 'A different request already used this ID.',
  HOST_OR_ORIGIN_DENIED: 'The relay rejected this site’s origin.',
  RELAY_OFFLINE: 'The relay is offline right now. Your funds are safe: balances are read from the chain, and any note can still exit publicly from your own wallet. Private sends, withdrawals and swaps resume when it is back.',
  RELAY_UNREACHABLE: 'The relay is offline right now. Your funds are safe: balances are read from the chain, and any note can still exit publicly from your own wallet. Private sends, withdrawals and swaps resume when it is back.',
  RPC_UNAVAILABLE: 'The relay lost its connection to the chain for a moment. Try again shortly.',
  REQUEST_REJECTED: 'The relay could not complete that right now. Try again in a moment.',
  RATE_LIMITED: 'Too many requests from this network. Wait a minute and try again.',
  RELAY_NOT_LIVE: 'Private sends, withdrawals and swaps open as soon as the relay goes live. Deposits work now, and a deposit can always be returned to the address that made it.',
};
/** Recovery fields the relay attaches to errors (docs/FRONTEND_FEEDBACK_20261016.md in the backend). */
export interface RelayErrorInfo { errorId?: string; jobPersisted?: boolean | null; jobMayContinue?: boolean; retrySameId?: boolean; transactionHash?: string }
export class RelayError extends Error {
  constructor(public code: string, public info: RelayErrorInfo = {}) {
    super((MESSAGES[code] ?? (/^HTTP_5/.test(code) ? MESSAGES.RELAY_UNREACHABLE : `Relay rejected the request (${code}).`)) + (info.errorId ? ` (ref ${info.errorId})` : ''));
  }
  /** The job may exist or still be running: follow it by its original ID instead of resubmitting. */
  get mayHaveRun() { return UNKNOWN_OUTCOME.has(this.code) || this.info.jobPersisted === null || this.info.jobMayContinue === true || !!this.info.transactionHash; }
}
/** Submit outcomes that are unknown, not failed: the relay may still be signing and sending. Follow the job by ID. */
export const UNKNOWN_OUTCOME = new Set(['RELAY_UNREACHABLE', 'RELAY_OFFLINE', 'HTTP_500', 'HTTP_502', 'HTTP_503', 'HTTP_504']);
/** Errors that a fresh proof against the latest state can fix. */
export const RETRYABLE = new Set(['STALE_ASP_PROOF', 'ASP_POLICY_ENDING', 'UNKNOWN_PROOF_ROOT', 'PENDING_NONCE']);

/** Reads have no side effects, so a relay that briefly lost its chain RPC (503 RPC_UNAVAILABLE, answered fast) is asked again quietly. */
async function call<T>(pool: PoolId, path: string, body?: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await callOnce<T>(pool, path, body); }
    catch (e) { if (body !== undefined || !(e instanceof RelayError && e.code === 'RPC_UNAVAILABLE') || attempt >= 2) throw e; await new Promise(r => setTimeout(r, 500 * 3 ** attempt)); }
  }
}

async function callOnce<T>(pool: PoolId, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${POOLS[pool].relay}${path}`, body === undefined ? {}
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch { throw new RelayError('RELAY_UNREACHABLE'); }
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.error) {
    const code = typeof json?.error === 'string' ? json.error : json?.error?.code ?? `HTTP_${res.status}`;
    const { errorId, jobPersisted, jobMayContinue, retrySameId, transactionHash } = json ?? {};
    throw new RelayError(code, { errorId, jobPersisted, jobMayContinue, retrySameId, transactionHash });
  }
  return json as T;
}

export const relayHealth = (pool: PoolId) => call<RelayHealth>(pool, '/readyz');
export const relayState = (pool: PoolId) => call<any>(pool, '/v3/state');
export const relayConfig = (pool: PoolId) => call<{ processor: string | null; relaySigning: boolean; serviceFees?: unknown }>(pool, '/v3/config');
/** Quotes back off and retry while the relay's quote slots are full (QUOTE_BUSY, at most 4 in flight). */
export async function relayQuote(pool: PoolId, routeId: string, amountIn: bigint, slippageBPS: number): Promise<Quote> {
  for (let attempt = 0; ; attempt++) {
    try { return await call<Quote>(pool, '/v3/quote', { routeId, amountIn: String(amountIn), slippageBPS }); }
    catch (e) { if (!(e instanceof RelayError && e.code === 'QUOTE_BUSY') || attempt >= 3) throw e; await new Promise(r => setTimeout(r, 600 * 2 ** attempt)); }
  }
}

export const newJobId = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18)))).replace(/\+/g, '-').replace(/\//g, '_');
export const submitJob = (pool: PoolId, job: { id: string; kind: JobKind; routeId?: string; transaction: unknown }) => call<RelayJob>(pool, '/v3/jobs', job);
export const getJob = (pool: PoolId, id: string) => call<RelayJob>(pool, `/v3/jobs/${id}`);

/** Polls a submitted job until it settles. Network hiccups keep polling: the job ID is the source of truth.
 *  `unsure` (the submit call's answer was lost) also tolerates JOB_NOT_FOUND for a while, since the relay
 *  records the job before it answers but our request may still be in flight. */
export async function waitForJob(pool: PoolId, id: string, { timeoutMs = 180_000, unsure = false, pollMs = 2500 } = {}): Promise<RelayJob> {
  const started = Date.now(), until = started + timeoutMs;
  for (;;) {
    try {
      const job = await getJob(pool, id);
      if (job.status === 'confirmed') return job;
      if (job.status === 'reverted' && job.hash) throw new Error('The transaction reverted on chain.');
      // Cancelled, or reverted before any transaction: final, nothing was sent (backend keeps suggesting a re-query; don't loop).
      if (job.status === 'cancelled' || job.status === 'reverted') throw new Error('The relay stopped this request before sending anything. You can try again.');
    } catch (e) {
      // Once a job exists, a failed status read (RPC hiccup, receipt not readable yet) says nothing about
      // the job itself: keep asking until it settles or we time out. Only "no such job" is an answer.
      const transient = e instanceof RelayError && (e.code !== 'JOB_NOT_FOUND' || (unsure && e.info.jobPersisted !== false && Date.now() - started < 90_000));
      // getJob turns network failures into RelayErrors, so anything else is a verdict thrown above.
      if (!transient) {
        if (unsure && e instanceof RelayError && e.code === 'JOB_NOT_FOUND') throw new Error('The relay did not receive this request. Nothing was sent; you can try again.');
        throw e;
      }
    }
    if (Date.now() > until) throw new Error(`Still pending after ${timeoutMs / 1000}s. Job ${id} keeps running; check back shortly (refresh to see the result).`);
    await new Promise(r => setTimeout(r, pollMs));
  }
}
