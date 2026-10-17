import { validateReceiver, type Receiver } from './sdk.js';
import { POOLS, type PoolId } from './pools.js';

// Shareable private address. Receivers are bound to one pool, so the address bundles one receiver
// per pool: "lincoln3:" + base64url({version:1, receivers:[…]}). Each receiver is exactly the CLI's
// receiver JSON. Also accepted: "lincoln2:" (one ETH-pool receiver) and raw receiver JSON.
// None of these grant spending rights.
const PREFIX = 'lincoln3:', SINGLE = 'lincoln2:';
const b64url = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)));

export const encodeReceivers = (receivers: Receiver[]) => PREFIX + b64url(JSON.stringify({ version: 1, receivers }));

function parse(input: string): Receiver[] {
  const text = input.trim();
  if (text.startsWith('lincoln1:')) throw new Error('That address is for the retired v1 pool. Ask the recipient for a new one.');
  try {
    if (text.startsWith(PREFIX)) { const b = JSON.parse(unb64url(text.slice(PREFIX.length))); if (Array.isArray(b?.receivers)) return b.receivers; }
    else { const one = JSON.parse(text.startsWith(SINGLE) ? unb64url(text.slice(SINGLE.length)) : text); return Array.isArray(one?.receivers) ? one.receivers : [one]; }
  } catch { /* fall through */ }
  throw new Error('Not a valid private address.');
}

/** The recipient's receiver for `pool`, validated against that pool's profile. */
export function decodeReceiver(input: string, pool: PoolId = 'eth'): Receiver {
  const profile = POOLS[pool].profile, want = profile.pool.address.toLowerCase();
  const match = parse(input).find(r => typeof r?.pool === 'string' && r.pool.toLowerCase() === want);
  if (!match) throw new Error(`This private address cannot receive ${POOLS[pool].symbol}. Ask the recipient for an up-to-date address.`);
  return validateReceiver(match, profile);
}

/** The bundle inside a lincoln3: address, for download or CLI use. */
export const receiversOf = (code: string) => ({ version: 1, receivers: parse(code) });

export const shortReceiver = (code: string) => `${code.slice(0, 14)}…${code.slice(-8)}`;
