// Browser port of /privacy/src/phase2-asp/sdk.mjs (factorized-note ASP JoinSplit client).
// Every derivation, encoding and ciphertext layout must stay byte-compatible with the Node SDK
// so CLI wallets, receivers, backups and the relay interoperate. See sdk.compat.test.ts.
import { x25519 } from '@noble/curves/ed25519.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { gcm } from '@noble/ciphers/aes.js';
import { poseidon1, poseidon2, poseidon3 } from 'poseidon-lite';
import { encodeAbiParameters, isAddress, keccak256, stringToHex, type Hex } from 'viem';

export const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const MAX_VALUE = (1n << 128n) - 1n;
export const TREE_DEPTH = 20;
export const RECEIPT_BYTES = 256;
export const NOTE_MODEL = 'factorized-asp-v1';
export const PROFILE_SCHEMA = 'phase2-asp-test-profile/v1';
export const PRODUCTION_PROFILE_SCHEMA = 'phase2-asp-production-profile/v1';
export const DOMAIN = keccak256(stringToHex('CHENG_PHASE2_ASP_V1'));
export const EXIT_DOMAIN = keccak256(stringToHex('CHENG_PHASE2_ASP_EXIT_V1'));
export const SWAP_DOMAIN = keccak256(stringToHex('CHENG_PHASE2_ROUTES_V1'));
export const NATIVE_ASSET = '0x0000000000000000000000000000000000000000';
export const MAX_ROUTE_HOPS = 4;
const BACKUP_N = 32768, BACKUP_R = 8, BACKUP_P = 1;
const MAX_NOTES = 10000;
const U64 = (1n << 64n) - 1n;
const enc = new TextEncoder();

export interface Profile {
  // Test profiles: experimental, testOnly. Mainnet release-candidate profiles: releaseCandidate, not testOnly (see normalizeProfile).
  schema: string; experimental?: boolean; testOnly: boolean; productionReady: false; releaseCandidate?: boolean;
  chain: { id: number; rpcUrl: string };
  pool: { address: string; asset: string; noteModel: string; scope: string; treeDepth: number; startBlock: string; runtimeCodeHash: string };
  registry: { address: string; provider: string; startBlock?: string; runtimeCodeHash?: string };
  [key: string]: unknown;
}
export interface NormalizedProfile { chainId: number; pool: string; asset: string; scope: bigint; treeDepth: number; noteModel: string; registry: string; provider: string }
export interface Account { version: 1; seed: string; notes: string[] }
export interface Receiver { version: 1; noteModel: string; chainId: number; pool: string; scope: string; ownerPublicKey: string; encryptionPublicKey: string }
export interface Note { version: 1; chainId: number; pool: string; scope: bigint; value: bigint; ownerPublicKey: bigint; blinding: bigint; commitment: bigint }
export interface Receipt { commitment: string; index: number; encryptedOutput: string; value?: string; precommitment?: string }
export interface DynamicEvent { value?: string | bigint; amount?: string | bigint; precommitment: string | bigint; commitment: string | bigint; encryptedTemplate?: string; encryptedOutput?: string }
export interface ASPState { root: string; epoch: string; validUntil: string; leaves?: string[] | null; cidDigest?: string; expired?: boolean }
export interface DepositRecord { commitment: string; value: string; precommitment: string; originalDepositor: string; transactionHash: string; blockNumber: string }
export interface PublicState {
  root: string; commitments: string[]; nullifiers: string[]; receipts: Receipt[];
  asp: ASPState; deposits?: DepositRecord[]; blockTimestamp?: string; chainId?: number; pool?: string; scope?: string; noteModel?: string;
}
export interface ExtData { recipient: string; feeRecipient: string; processor: string; publicIn: bigint; publicOut: bigint; fee: bigint }
export interface ExtDataInput { recipient: string; feeRecipient: string; processor: string; publicIn: bigint | string; publicOut: bigint | string; fee: bigint | string }
export interface ExitData { processor: string; recipient: string; feeRecipient: string; fee: bigint }
export interface ExitDataInput { processor: string; recipient: string; feeRecipient: string; fee: bigint | string }

function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const toHex = (b: Uint8Array): Hex => `0x${Array.from(b, x => x.toString(16).padStart(2, '0')).join('')}`;
function fromHex(value: string): Uint8Array {
  const s = value.startsWith('0x') ? value.slice(2) : value, out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const equalsZero = (b: Uint8Array) => b.every(x => x === 0);
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; } return out;
};
function exactKeys(value: unknown, keys: string[], name: string) {
  check(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(','), `Invalid ${name} fields.`);
}
function poseidon(inputs: bigint[]): bigint {
  if (inputs.length === 1) return poseidon1(inputs);
  if (inputs.length === 2) return poseidon2(inputs);
  if (inputs.length === 3) return poseidon3(inputs);
  throw new Error('Unsupported Poseidon arity.');
}
export function field(value: bigint | string, max = FIELD - 1n, nonzero = false): bigint {
  check(typeof value === 'bigint' || typeof value === 'string' && /^(0|[1-9]\d{0,77})$/.test(value), 'Canonical decimal integer required.');
  const result = BigInt(value);
  check(result >= 0n && result <= max && (!nonzero || result > 0n), 'Integer outside allowed range.');
  return result;
}
function bytes(value: string, length: number): Uint8Array {
  check(typeof value === 'string' && /^0x[0-9a-f]*$/i.test(value) && value.length === 2 + length * 2, 'Invalid fixed-size byte encoding.');
  return fromHex(value);
}
function address(value: string, name = 'address', nonzero = false): string {
  check(isAddress(value) && (!nonzero || value.toLowerCase() !== NATIVE_ASSET), `Invalid ${name}.`);
  return value.toLowerCase();
}
export function randomField(): bigint {
  for (;;) { const r = BigInt(toHex(randomBytes(32))); if (r > 0n && r < FIELD) return r; }
}

const profileCache = new WeakMap<Profile, NormalizedProfile>();
export function normalizeProfile(profile: Profile): NormalizedProfile {
  const hit = profileCache.get(profile); if (hit) return hit;
  const production = profile?.schema === PRODUCTION_PROFILE_SCHEMA;
  if (production) {
    // Mirrors the backend SDK (src/phase2-asp/sdk.mjs): a pinned Robinhood mainnet release candidate.
    const p = profile as any, refs = p.production;
    check(p.releaseCandidate === true && p.testOnly === false && p.productionReady === false && p.experimental !== true && p.chain?.id === 4663 && p.pool?.noteModel === NOTE_MODEL, 'Explicit Robinhood mainnet ASP release-candidate profile required.');
    check(/^[a-f0-9]{64}$/.test(p.artifactSHA256 ?? '') && refs?.build?.path === 'artifacts/phase2-mainnet/contracts.json' && refs.build.sha256 === p.artifactSHA256, 'Pinned production build required.');
    check(refs.releaseId === undefined || refs.releaseId === p.artifactSHA256, 'Production release identity mismatch.');
    for (const name of ['joinsplit', 'holder-exit'])
      check(refs?.manifests?.[name]?.path === `protocol/phase2-mainnet/build/${name}/manifest.json` && /^[a-f0-9]{64}$/.test(refs.manifests[name].sha256 ?? ''), 'Pinned final production manifest required.');
    check(/^0x[0-9a-f]{64}$/i.test(p.genesisHash ?? '') && [p.pool, p.verifier, p.exitVerifier, p.registry].every(pin => /^0x[0-9a-f]{64}$/i.test(pin?.runtimeCodeHash ?? '')), 'Pinned production deployment identity required.');
    for (const pin of [p.pool, p.registry]) check(typeof pin.startBlock === 'string' && /^(0|[1-9][0-9]*)$/.test(pin.startBlock), 'Production deployment start block required.');
  } else check(profile?.schema === PROFILE_SCHEMA && profile.pool?.noteModel === NOTE_MODEL && profile.experimental === true && profile.testOnly === true && profile.productionReady === false && [31341, 46630].includes(profile?.chain?.id), 'Explicit local or Robinhood testnet Phase-2 ASP factorized profile required.');
  const pool = address(profile.pool.address, 'pool', true);
  const scope = BigInt(keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }], [DOMAIN, BigInt(profile.chain.id), pool as Hex]))) % FIELD;
  if (profile.pool.scope !== undefined) check(field(profile.pool.scope, FIELD - 1n, true) === scope, 'Pool scope does not match chain and pool.');
  check((profile.pool.treeDepth ?? TREE_DEPTH) === TREE_DEPTH, 'Phase-2 tree depth mismatch.');
  if (production) {
    const p = profile as any;
    address(p.verifier?.address, 'production verifier', true); address(p.exitVerifier?.address, 'production exit verifier', true);
    check(new Set([pool, p.registry.address.toLowerCase(), p.verifier.address.toLowerCase(), p.exitVerifier.address.toLowerCase()]).size === 4, 'Production deployment roles must differ.');
  }
  const result = {
    chainId: profile.chain.id, pool, asset: address(profile.pool.asset ?? NATIVE_ASSET, 'asset'), scope, treeDepth: TREE_DEPTH, noteModel: NOTE_MODEL,
    registry: address(profile.registry?.address, 'ASP registry', true), provider: address(profile.registry?.provider, 'ASP provider', true),
  };
  profileCache.set(profile, result); return result;
}
export function profileDomain(profile: Profile) { const p = normalizeProfile(profile); return `${DOMAIN}:${p.chainId}:${p.pool}:${p.scope}:${NOTE_MODEL}`; }

export function createAccount(seed?: string): Account {
  if (seed === undefined) seed = toHex(randomBytes(32)).slice(2);
  check(/^[0-9a-f]{64}$/.test(seed), 'Account seed must be 32 bytes of lowercase hex.');
  return { version: 1, seed, notes: [] };
}
function accountSeed(account: Account): Uint8Array {
  check(account?.version === 1 && /^[0-9a-f]{64}$/.test(account.seed) && Array.isArray(account.notes) && account.notes.length <= MAX_NOTES, 'Invalid Phase-2 account.');
  return fromHex(account.seed);
}
function derive(account: Account, profile: Profile, purpose: string, counter = 0): Uint8Array {
  return hmac(sha256, accountSeed(account), enc.encode(`CHENG_PHASE2_ASP_ACCOUNT_V1:${profileDomain(profile)}:${purpose}:${counter}`));
}
export function spendingSecret(account: Account, profile: Profile): bigint {
  for (let i = 0; ; i++) { const v = BigInt(toHex(derive(account, profile, 'spend', i))); if (v > 0n && v < FIELD) return v; }
}
const encryptionKey = (account: Account, profile: Profile) => derive(account, profile, 'receipt-x25519');

export function receiverAddress(account: Account, profile: Profile): Receiver {
  const p = normalizeProfile(profile);
  return {
    version: 1, noteModel: NOTE_MODEL, chainId: p.chainId, pool: p.pool, scope: String(p.scope),
    ownerPublicKey: String(poseidon([spendingSecret(account, profile)])), encryptionPublicKey: toHex(x25519.getPublicKey(encryptionKey(account, profile))),
  };
}
export function validateReceiver(receiver: Receiver, profile: Profile): Receiver {
  exactKeys(receiver, ['version', 'noteModel', 'chainId', 'pool', 'scope', 'ownerPublicKey', 'encryptionPublicKey'], 'receiver');
  const p = normalizeProfile(profile);
  check(receiver.version === 1 && receiver.noteModel === NOTE_MODEL && receiver.chainId === p.chainId && address(receiver.pool, 'receiver pool', true) === p.pool && field(receiver.scope, FIELD - 1n, true) === p.scope, 'Receiver belongs to another chain or pool.');
  field(receiver.ownerPublicKey, FIELD - 1n, true);
  const key = bytes(receiver.encryptionPublicKey, 32);
  // Rejects low-order Curve25519 points before preparing funds.
  let shared: Uint8Array;
  try { shared = x25519.getSharedSecret(new Uint8Array(32).fill(1), key); } catch { throw new Error('Invalid receiver encryption key.'); }
  check(!equalsZero(shared), 'Invalid receiver encryption key.');
  return receiver;
}

const commit = (value: bigint, owner: bigint, blinding: bigint) => value === 0n ? 0n : poseidon([value, poseidon([owner, blinding])]);
export function createNote({ value, receiver, blinding = randomField() }: { value: bigint | string; receiver: Receiver; blinding?: bigint | string }, profile: Profile): Note {
  validateReceiver(receiver, profile);
  const p = normalizeProfile(profile), v = field(value, MAX_VALUE), owner = field(receiver.ownerPublicKey, FIELD - 1n, true), b = field(blinding, FIELD - 1n, true);
  return { version: 1, chainId: p.chainId, pool: p.pool, scope: p.scope, value: v, ownerPublicKey: owner, blinding: b, commitment: commit(v, owner, b) };
}
function normalizeNote(note: any, profile: Profile): Note {
  exactKeys(note, ['version', 'chainId', 'pool', 'scope', 'value', 'ownerPublicKey', 'blinding', 'commitment'], 'note');
  const p = normalizeProfile(profile);
  check(note.version === 1 && note.chainId === p.chainId && address(note.pool, 'note pool', true) === p.pool && field(note.scope, FIELD - 1n, true) === p.scope, 'Note belongs to another chain or pool.');
  const value = field(note.value, MAX_VALUE), owner = field(note.ownerPublicKey, FIELD - 1n, true), blinding = field(note.blinding, FIELD - 1n, true), commitment = field(note.commitment);
  check(commit(value, owner, blinding) === commitment, 'Note commitment mismatch.');
  return { version: 1, chainId: p.chainId, pool: p.pool, scope: p.scope, value, ownerPublicKey: owner, blinding, commitment };
}
export function notePrecommitment(note: Note, profile: Profile) { const n = normalizeNote(note, profile); return poseidon([n.ownerPublicKey, n.blinding]); }
export const serializeNote = (note: Note, profile: Profile) => JSON.stringify(normalizeNote(note, profile), (_, v) => typeof v === 'bigint' ? String(v) : v);
export function deserializeNote(text: string, profile: Profile): Note {
  check(typeof text === 'string' && text.length <= 2048, 'Invalid note encoding length.');
  let note; try { note = JSON.parse(text); } catch { throw new Error('Invalid note JSON.'); }
  return normalizeNote(note, profile);
}
export function nullifier(note: Note, secret: bigint, profile: Profile): bigint {
  const n = normalizeNote(note, profile), s = field(secret, FIELD - 1n, true);
  check(poseidon([s]) === n.ownerPublicKey, 'Spending key does not own this note.');
  return poseidon([s, n.commitment, n.scope]);
}

// ---------- Encrypted receipts ----------
function sharedKey(privateKey: Uint8Array, publicKey: Uint8Array, aad: Uint8Array): Uint8Array {
  const shared = x25519.getSharedSecret(privateKey, publicKey);
  check(!equalsZero(shared), 'Invalid receipt encryption key.');
  return hkdf(sha256, shared, sha256(aad), enc.encode('CHENG_PHASE2_ASP_RECEIPT_AES256GCM_V1'), 32);
}
const intBytes = (value: bigint, size: number) => fromHex(value.toString(16).padStart(size * 2, '0'));
/** Seals a 195-byte plaintext into the 256-byte on-chain layout: version | ephemeral pub | iv | ciphertext | tag. */
function seal(version: number, receiverKey: string, aad: Uint8Array, plain: Uint8Array): Hex {
  const ephemeral = randomBytes(32), key = sharedKey(ephemeral, bytes(receiverKey, 32), aad), iv = randomBytes(12);
  return toHex(concat(new Uint8Array([version]), x25519.getPublicKey(ephemeral), iv, gcm(key, iv, aad).encrypt(plain)));
}
function open(account: Account, profile: Profile, version: number, data: Uint8Array, aad: Uint8Array): Uint8Array {
  check(data[0] === version, 'Unsupported receipt version.');
  const key = sharedKey(encryptionKey(account, profile), data.subarray(1, 33), aad);
  const plain = gcm(key, data.subarray(33, 45), aad).decrypt(data.subarray(45, 256));
  check(plain[0] === version, 'Unsupported receipt plaintext.');
  return plain;
}
const receiptAAD = (profile: Profile, commitment: bigint | string) => enc.encode(`${profileDomain(profile)}:receipt:v1:${field(commitment)}`);
export function encryptReceipt(receiver: Receiver, note: Note, profile: Profile): Hex {
  validateReceiver(receiver, profile);
  const n = normalizeNote(note, profile);
  check(n.ownerPublicKey === field(receiver.ownerPublicKey), 'Receipt recipient does not own output.');
  // Binary plaintext has no input IDs, deposit labels, EOA or sender address.
  const plain = randomBytes(195); plain[0] = 1; plain.set(intBytes(n.value, 16), 1); plain.set(intBytes(n.blinding, 32), 17);
  return seal(1, receiver.encryptionPublicKey, receiptAAD(profile, n.commitment), plain);
}
export function decryptReceipt(account: Account, profile: Profile, commitment: bigint | string, encryptedOutput: string): Note {
  const plain = open(account, profile, 1, bytes(encryptedOutput, RECEIPT_BYTES), receiptAAD(profile, commitment));
  const note = createNote({ value: BigInt(toHex(plain.subarray(1, 17))), blinding: BigInt(toHex(plain.subarray(17, 49))), receiver: receiverAddress(account, profile) }, profile);
  check(note.commitment === field(commitment), 'Recovered note does not match on-chain commitment.');
  return note;
}
const dynamicAAD = (profile: Profile, precommitment: bigint | string) => enc.encode(`${profileDomain(profile)}:dynamic-receipt:v2:${field(precommitment, FIELD - 1n, true)}`);
export interface DynamicInvoice { precommitment: bigint; encryptedTemplate: Hex }
/** An amount-independent invoice used by depositDynamic and swaps. Only the receiver can decrypt its blinding. */
export function createDynamicReceiver(receiver: Receiver, profile: Profile, { blinding = randomField() }: { blinding?: bigint } = {}): DynamicInvoice {
  validateReceiver(receiver, profile);
  const b = field(blinding, FIELD - 1n, true), precommitment = poseidon([field(receiver.ownerPublicKey, FIELD - 1n, true), b]);
  check(precommitment > 0n, 'Zero dynamic precommitment.');
  // Dynamic ciphertext carries no amount. The canonical pool event supplies it.
  const plain = randomBytes(195); plain[0] = 2; plain.set(intBytes(b, 32), 1);
  return { precommitment, encryptedTemplate: seal(2, receiver.encryptionPublicKey, dynamicAAD(profile, precommitment), plain) };
}
export const createDynamicReceive = (account: Account, profile: Profile, options?: { blinding?: bigint }) => createDynamicReceiver(receiverAddress(account, profile), profile, options);
export function decryptDynamicReceipt(account: Account, profile: Profile, event: DynamicEvent): Note {
  check(event && typeof event === 'object', 'Canonical dynamic deposit event required.');
  const value = field((event.value ?? event.amount)!, MAX_VALUE, true), precommitment = field(event.precommitment, FIELD - 1n, true), commitment = field(event.commitment, FIELD - 1n, true);
  const plain = open(account, profile, 2, bytes((event.encryptedTemplate ?? event.encryptedOutput)!, RECEIPT_BYTES), dynamicAAD(profile, precommitment));
  const note = createNote({ value, blinding: BigInt(toHex(plain.subarray(1, 33))), receiver: receiverAddress(account, profile) }, profile);
  check(notePrecommitment(note, profile) === precommitment && note.commitment === commitment, 'Recovered dynamic note does not match canonical deposit.');
  return note;
}

// ---------- Merkle trees ----------
let zeroCache: bigint[] | null = null;
function zeros() {
  if (!zeroCache) { zeroCache = [0n]; for (let l = 0; l < TREE_DEPTH; l++) zeroCache.push(poseidon([zeroCache[l], zeroCache[l]])); }
  return zeroCache;
}
export function buildMerkleTree(leaves: (bigint | string)[] = []) {
  check(Array.isArray(leaves) && leaves.length <= 2 ** TREE_DEPTH, 'Invalid Merkle leaf count.');
  const values = leaves.map(v => field(v, FIELD - 1n, true));
  check(new Set(values.map(String)).size === values.length, 'Duplicate Merkle commitments.');
  const z = zeros(), levels: bigint[][] = [values];
  for (let level = 0; level < TREE_DEPTH; level++) {
    const current = levels[level], next: bigint[] = [];
    for (let i = 0; i < current.length; i += 2) next.push(poseidon([current[i], current[i + 1] ?? z[level]]));
    levels.push(next);
  }
  const root = levels[TREE_DEPTH][0] ?? z[TREE_DEPTH];
  return {
    root, leaves: values,
    generateProof(index: number) {
      check(Number.isSafeInteger(index) && index >= 0 && index < values.length, 'Invalid Merkle leaf index.');
      const siblings: bigint[] = []; let cursor = index;
      for (let level = 0; level < TREE_DEPTH; level++) { siblings.push(levels[level][cursor ^ 1] ?? z[level]); cursor = Math.floor(cursor / 2); }
      return { root, index, siblings };
    },
  };
}
function publicState(state: PublicState, profile: Profile) {
  const p = normalizeProfile(profile);
  check(state.noteModel === undefined || state.noteModel === NOTE_MODEL, 'Public state note model mismatch.');
  check((state.chainId === undefined || state.chainId === p.chainId) && (state.pool === undefined || address(state.pool, 'state pool', true) === p.pool) && (state.scope === undefined || field(state.scope, FIELD - 1n, true) === p.scope), 'Public state belongs to another chain or pool.');
  const tree = buildMerkleTree(state.commitments);
  check(field(state.root) === tree.root, 'Public state Merkle root mismatch.');
  check(Array.isArray(state.nullifiers), 'Public state nullifier array required.');
  const nfs = state.nullifiers.map(v => String(field(v, FIELD - 1n, true)));
  check(new Set(nfs).size === nfs.length, 'Duplicate public nullifiers.');
  return { tree, spent: new Set(nfs) };
}

// ---------- Recovery ----------
export interface Recovered { notes: Note[]; balance: bigint; received: number; root: bigint }
/** Decrypts every public output this account owns and returns its unspent notes. Mutates account.notes. */
export function recoverAccount(account: Account, profile: Profile, state: PublicState): Recovered {
  accountSeed(account);
  const { tree, spent } = publicState(state, profile), secret = spendingSecret(account, profile), ownPub = poseidon([secret]);
  const p = normalizeProfile(profile), notes = new Map<string, Note>(), other: string[] = [];
  for (const text of account.notes) {
    check(typeof text === 'string' && text.length <= 2048, 'Invalid saved note.');
    let record; try { record = JSON.parse(text); } catch { throw new Error('Invalid saved note JSON.'); }
    if (record?.chainId !== p.chainId || record.pool !== p.pool) { other.push(text); continue; }
    const note = deserializeNote(text, profile);
    check(note.ownerPublicKey === ownPub, 'Saved note is not owned by this account.'); notes.set(String(note.commitment), note);
  }
  check(Array.isArray(state.receipts) && state.receipts.length <= 2 ** TREE_DEPTH, 'Public encrypted outputs required.');
  const seen = new Set<number>(); let received = 0;
  for (const event of state.receipts) {
    check(event && Number.isSafeInteger(event.index) && event.index >= 0 && event.index < tree.leaves.length, 'Invalid public output index.');
    const commitment = field(event.commitment, FIELD - 1n, true), cipher = bytes(event.encryptedOutput, RECEIPT_BYTES);
    check(tree.leaves[event.index] === commitment && !seen.has(event.index), 'Public output is missing, reordered or duplicated.'); seen.add(event.index);
    let note;
    // Unauthenticated ciphertext belongs to another receiver or is unspendable; it never blocks recovery.
    try { note = cipher[0] === 2 ? decryptDynamicReceipt(account, profile, event as unknown as DynamicEvent) : decryptReceipt(account, profile, commitment, event.encryptedOutput); } catch { continue; }
    if (!notes.has(String(commitment))) received++;
    notes.set(String(commitment), note);
  }
  check(other.length + notes.size <= MAX_NOTES, 'Wallet note capacity exceeded.');
  account.notes = [...other, ...[...notes.values()].map(n => serializeNote(n, profile))];
  const leafSet = new Set(tree.leaves.map(String));
  const available = [...notes.values()].filter(n => n.value > 0n && leafSet.has(String(n.commitment)) && !spent.has(String(nullifier(n, secret, profile))));
  return { notes: available, balance: available.reduce((s, n) => s + n.value, 0n), received, root: tree.root };
}
export function selectNotes(notes: Note[], amount: bigint): Note[] {
  const target = field(amount, MAX_VALUE, true);
  check(Array.isArray(notes) && notes.length <= MAX_NOTES, 'Invalid note-selection collection.');
  const items = notes.filter(n => n.value > 0n);
  check(new Set(items.map(n => String(n.commitment))).size === items.length, 'Duplicate note-selection inputs.');
  items.sort((a, b) => a.value < b.value ? -1 : a.value > b.value ? 1 : a.commitment < b.commitment ? -1 : 1);
  let best: Note[] | null = null, total = 0n;
  const consider = (selected: Note[]) => {
    const sum = selected.reduce((n, x) => n + x.value, 0n);
    if (sum >= target && (!best || sum < total || sum === total && selected.length < best.length)) { best = selected; total = sum; }
  };
  for (const n of items) consider([n]);
  // Sorted two-pointer search finds the least total at or above target in O(n).
  let left = 0, right = items.length - 1;
  while (left < right) { const sum = items[left].value + items[right].value; if (sum >= target) { consider([items[left], items[right]]); right--; } else left++; }
  if (!best) {
    check(items.reduce((s, n) => s + n.value, 0n) < target, 'Payment requires more than two inputs; consolidate notes first.');
    throw new Error('Insufficient private balance.');
  }
  return best;
}

// ---------- ASP association set ----------
export const associationLeaf = (commitment: bigint | string, profile: Profile) => poseidon([field(commitment, FIELD - 1n, true), normalizeProfile(profile).scope]);
function associationLeaves(leaves: (bigint | string)[]) {
  check(Array.isArray(leaves) && leaves.length <= 2 ** TREE_DEPTH, 'Invalid association-set leaf count.');
  const result = leaves.map(v => field(v, FIELD - 1n, true));
  check(new Set(result.map(String)).size === result.length, 'Duplicate association-set leaves.'); return result;
}
export const associationSetDigest = (leaves: (bigint | string)[]) => keccak256(encodeAbiParameters([{ type: 'uint256[]' }], [associationLeaves(leaves)]));
function aspPolicy(aspState: ASPState, { requireLeaves = false } = {}) {
  check(aspState && typeof aspState === 'object', 'ASP policy required.');
  const root = field(aspState.root, FIELD - 1n, true), epoch = field(aspState.epoch, U64, true), validUntil = field(aspState.validUntil, U64, true);
  let tree: ReturnType<typeof buildMerkleTree> | null = null;
  if (requireLeaves || aspState.leaves !== undefined && aspState.leaves !== null) {
    const leaves = associationLeaves(aspState.leaves ?? (undefined as never)); tree = buildMerkleTree(leaves);
    check(tree.root === root, 'Association-set root mismatch.');
    if (aspState.cidDigest !== undefined) check(associationSetDigest(leaves).toLowerCase() === aspState.cidDigest.toLowerCase(), 'Association-set digest mismatch.');
  }
  return { root, epoch, validUntil, tree };
}
/** Whether a note's commitment is in the current ASP association set (required for normal spending). */
export function isApproved(note: Note, profile: Profile, aspState: ASPState) {
  return (aspState.leaves ?? []).includes(String(associationLeaf(note.commitment, profile)));
}

// ---------- JoinSplit ----------
function normalizeExtData(e: ExtDataInput): ExtData {
  exactKeys(e, ['recipient', 'feeRecipient', 'processor', 'publicIn', 'publicOut', 'fee'], 'external data');
  const ext = { recipient: address(e.recipient, 'recipient'), feeRecipient: address(e.feeRecipient, 'fee recipient'), processor: address(e.processor, 'processor'), publicIn: field(e.publicIn, MAX_VALUE), publicOut: field(e.publicOut, MAX_VALUE), fee: field(e.fee, MAX_VALUE) };
  check(ext.fee <= ext.publicOut, 'Relayer fee exceeds public output.');
  check(ext.publicIn === 0n || ext.publicOut === 0n, 'Simultaneous public deposit and withdrawal unsupported.');
  check(ext.publicOut === ext.fee || ext.recipient !== NATIVE_ASSET, 'Withdrawal recipient is zero.');
  check(ext.fee === 0n || ext.feeRecipient !== NATIVE_ASSET, 'Fee recipient is zero.');
  return ext;
}
export function joinSplitContextBase(profile: Profile, externalData: ExtDataInput, encryptedOutputs: string[]): bigint {
  const p = normalizeProfile(profile), ext = normalizeExtData(externalData);
  check(Array.isArray(encryptedOutputs) && encryptedOutputs.length === 2, 'Exactly two encrypted outputs required.');
  encryptedOutputs.forEach(c => bytes(c, RECEIPT_BYTES));
  return BigInt(keccak256(encodeAbiParameters([
    { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' },
    { type: 'uint128' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes32' }, { type: 'bytes32' },
  ], [DOMAIN, BigInt(p.chainId), p.pool as Hex, p.scope, p.registry as Hex, p.provider as Hex, ext.processor as Hex, ext.recipient as Hex, ext.feeRecipient as Hex,
    ext.publicIn, ext.publicOut, ext.fee, keccak256(encryptedOutputs[0] as Hex), keccak256(encryptedOutputs[1] as Hex)]))) % FIELD;
}
export function joinSplitContext(profile: Profile, externalData: ExtDataInput, encryptedOutputs: string[], aspState: ASPState): bigint {
  const p = aspPolicy(aspState);
  return poseidon([joinSplitContextBase(profile, externalData, encryptedOutputs), poseidon([p.root, p.epoch, p.validUntil])]);
}

export interface Prepared {
  inputSignals: Record<string, unknown>; publicSignals: string[]; extData: ExtData;
  encryptedOutputs: Hex[]; outputNotes: Note[]; inputNotes: Note[];
}
export function prepareJoinSplit({ account, profile, state, aspState = state?.asp, inputs, outputs = [], externalData }:
  { account: Account; profile: Profile; state: PublicState; aspState?: ASPState; inputs?: Note[]; outputs?: { receiver: Receiver; value: bigint }[]; externalData: ExtDataInput }): Prepared {
  accountSeed(account);
  const { tree, spent } = publicState(state, profile), ext = normalizeExtData(externalData), secret = spendingSecret(account, profile), self = receiverAddress(account, profile);
  check(ext.publicIn === 0n, 'ASP funding must use depositDynamic.');
  const policy = aspPolicy(aspState, { requireLeaves: true }), aspTree = policy.tree!, approved = new Set(aspTree.leaves.map(String));
  check(aspState.expired !== true && (state.blockTimestamp === undefined || policy.validUntil > field(state.blockTimestamp, U64)), 'ASP policy has expired.');
  check(Array.isArray(outputs) && outputs.length <= 2, 'At most two output specifications allowed.');
  const requested = outputs.map(o => { exactKeys(o, ['receiver', 'value'], 'output specification'); validateReceiver(o.receiver, profile); return { receiver: o.receiver, value: field(o.value, MAX_VALUE, true) }; });
  const target = requested.reduce((s, o) => s + o.value, 0n) + ext.publicOut;
  check(target <= MAX_VALUE, 'Requested public and private output total exceeds uint128.');
  if (inputs === undefined) {
    const recovered = recoverAccount(structuredClone(account), profile, state);
    inputs = target > ext.publicIn ? selectNotes(recovered.notes.filter(n => approved.has(String(associationLeaf(n.commitment, profile)))), target - ext.publicIn) : [];
  }
  check(Array.isArray(inputs) && inputs.length <= 2, 'JoinSplit supports at most two real inputs.');
  const inputNotes = inputs.map(n => normalizeNote(n, profile));
  check(new Set(inputNotes.map(n => String(n.commitment))).size === inputNotes.length, 'Duplicate JoinSplit inputs.');
  type Witness = { note: { value: bigint; blinding: bigint; commitment: bigint }; secret: bigint; nf: bigint; index: number; siblings: bigint[]; aspIndex: number; aspSiblings: bigint[] };
  const witnesses: Witness[] = [];
  for (const note of inputNotes) {
    check(note.value > 0n, 'Explicit real input must have nonzero value.');
    const nf = nullifier(note, secret, profile);
    check(!spent.has(String(nf)), 'Input note has already been spent.');
    const index = tree.leaves.findIndex(v => v === note.commitment);
    check(index >= 0, 'Input note is not in the public Merkle tree.');
    const aspIndex = aspTree.leaves.findIndex(v => v === associationLeaf(note.commitment, profile));
    check(aspIndex >= 0, 'Input note is pending ASP approval.');
    witnesses.push({ note, secret, nf, ...tree.generateProof(index), aspIndex, aspSiblings: aspTree.generateProof(aspIndex).siblings });
  }
  const inputTotal = inputNotes.reduce((s, n) => s + n.value, 0n) + ext.publicIn;
  check(inputTotal <= MAX_VALUE && inputTotal >= target, 'JoinSplit value conservation failed.');
  const change = inputTotal - target;
  if (change > 0n) { check(requested.length < 2, 'Two recipient outputs leave no slot for change.'); requested.push({ receiver: self, value: change }); }
  const scope = normalizeProfile(profile).scope;
  while (witnesses.length < 2) {
    const dummySecret = randomField(), dummyPub = poseidon([dummySecret]), blinding = randomField(), commitment = poseidon([0n, poseidon([dummyPub, blinding])]);
    witnesses.push({ note: { value: 0n, blinding, commitment }, secret: dummySecret, nf: poseidon([dummySecret, commitment, scope]), index: 0, siblings: Array(TREE_DEPTH).fill(0n), aspIndex: 0, aspSiblings: Array(TREE_DEPTH).fill(0n) });
  }
  while (requested.length < 2) requested.push({ receiver: self, value: 0n });
  const outputNotes = requested.map(o => createNote(o, profile));
  check(ext.publicIn > 0n || ext.publicOut > 0n || outputNotes.some(n => n.value > 0n), 'Empty JoinSplit transaction is not permitted.');
  const positive = outputNotes.filter(n => n.value > 0n).map(n => String(n.commitment));
  check(new Set(positive).size === positive.length, 'Duplicate output commitments.');
  const encryptedOutputs = outputNotes.map((n, i) => encryptReceipt(requested[i].receiver, n, profile));
  const contextBase = joinSplitContextBase(profile, ext, encryptedOutputs), context = joinSplitContext(profile, ext, encryptedOutputs, aspState);
  const inputSignals = {
    root: tree.root, publicIn: ext.publicIn, publicOut: ext.publicOut, context, scope, contextBase, aspRoot: policy.root, aspEpoch: policy.epoch, aspValidUntil: policy.validUntil,
    inputNullifiers: witnesses.map(w => w.nf), outputCommitments: outputNotes.map(n => n.commitment),
    inputValues: witnesses.map(w => w.note.value), inputSecrets: witnesses.map(w => w.secret), inputBlindings: witnesses.map(w => w.note.blinding),
    inputPathIndices: witnesses.map(w => BigInt(w.index)), inputPathElements: witnesses.map(w => w.siblings),
    inputASPPathIndices: witnesses.map(w => BigInt(w.aspIndex)), inputASPPathElements: witnesses.map(w => w.aspSiblings),
    outputValues: outputNotes.map(n => n.value), outputPubKeys: outputNotes.map(n => n.ownerPublicKey), outputBlindings: outputNotes.map(n => n.blinding),
  };
  const publicSignals = [tree.root, ext.publicIn, ext.publicOut, context, scope, ...inputSignals.inputNullifiers, ...inputSignals.outputCommitments].map(String);
  return { inputSignals, publicSignals, extData: ext, encryptedOutputs, outputNotes, inputNotes };
}

// ---------- Routed swaps ----------
export interface SwapRoute { adapter: string; router: string; wrappedNative: string; factory: string; protocol: number | string; path: string; sourcePool?: string; targetPool?: string; [key: string]: unknown }
export interface SwapAction { processor: string; amountIn: bigint; minAmountOut: bigint; deadline: bigint; targetPrecommitment: bigint; encryptedTemplate: string }
function routeProtocol(value: number | string) {
  if (value === 0 || value === 'Uniswap V3') return { id: 0, name: 'Uniswap V3' };
  if (value === 1 || value === 'UP Slipstream') return { id: 1, name: 'UP Slipstream' };
  throw new Error('Unsupported routed swap protocol.');
}
export function normalizeSwapRoute({ sourceProfile, targetProfile, route }: { sourceProfile: Profile; targetProfile: Profile; route: SwapRoute }) {
  const source = normalizeProfile(sourceProfile), target = normalizeProfile(targetProfile);
  check(source.chainId === target.chainId && source.pool !== target.pool, 'Swap pools must differ on the same chain.');
  check(route && typeof route === 'object', 'Immutable swap route required.');
  const roles = { adapter: address(route.adapter, 'adapter', true), router: address(route.router, 'router', true), wrappedNative: address(route.wrappedNative, 'wrappedNative', true), factory: address(route.factory, 'factory', true) };
  check(new Set(Object.values(roles)).size === 4, 'Swap route roles must differ.');
  for (const [name, expected] of [['sourcePool', source.pool], ['targetPool', target.pool]] as const) if (route[name] !== undefined) check(address(route[name]!, name, true) === expected, 'Swap route pool mismatch.');
  const protocol = routeProtocol(route.protocol), encoded = route.path;
  check(typeof encoded === 'string' && /^0x[0-9a-f]+$/i.test(encoded), 'Invalid packed route path.');
  const body = encoded.slice(2), hops = (body.length / 2 - 20) / 23;
  check(Number.isSafeInteger(hops) && hops >= 1 && hops <= MAX_ROUTE_HOPS, 'Route requires one to four hops.');
  const tokens = [address(`0x${body.slice(0, 40)}`, 'route token', true)], parameters: number[] = [];
  for (let i = 0; i < hops; i++) {
    const offset = 40 + i * 46, parameter = Number.parseInt(body.slice(offset, offset + 6), 16);
    check(parameter > 0 && parameter < (protocol.id === 0 ? 1_000_000 : 1 << 23), 'Invalid route fee or tick spacing.');
    parameters.push(parameter); tokens.push(address(`0x${body.slice(offset + 6, offset + 46)}`, 'route token', true));
  }
  check(new Set(tokens).size === tokens.length, 'Repeated route token.');
  const tokenIn = source.asset === NATIVE_ASSET ? roles.wrappedNative : source.asset, tokenOut = target.asset === NATIVE_ASSET ? roles.wrappedNative : target.asset;
  check(tokens[0] === tokenIn && tokens.at(-1) === tokenOut, 'Route path asset endpoints mismatch.');
  return { ...roles, chainId: source.chainId, sourcePool: source.pool, targetPool: target.pool, sourceAsset: source.asset, targetAsset: target.asset,
    protocol: protocol.id, protocolName: protocol.name, path: encoded.toLowerCase(), pathHash: keccak256(encoded as Hex), tokens, parameters, hops,
    wrapNative: source.asset === NATIVE_ASSET, unwrapNative: target.asset === NATIVE_ASSET };
}
export function normalizeSwapAction(action: { processor: string; amountIn: bigint | string; minAmountOut: bigint | string; deadline: bigint | string; targetPrecommitment: bigint | string; encryptedTemplate: string }): SwapAction {
  exactKeys(action, ['processor', 'amountIn', 'minAmountOut', 'deadline', 'targetPrecommitment', 'encryptedTemplate'], 'swap action');
  const result = { processor: address(action.processor, 'swap submitter', true), amountIn: field(action.amountIn, MAX_VALUE, true), minAmountOut: field(action.minAmountOut, MAX_VALUE, true),
    deadline: field(action.deadline, (1n << 256n) - 1n, true), targetPrecommitment: field(action.targetPrecommitment, FIELD - 1n, true), encryptedTemplate: action.encryptedTemplate };
  check(bytes(result.encryptedTemplate, RECEIPT_BYTES)[0] === 2, 'Dynamic receiver template required.');
  return result;
}
export function swapActionHash({ sourceProfile, targetProfile, route, action }: { sourceProfile: Profile; targetProfile: Profile; route: SwapRoute; action: SwapAction }): Hex {
  const r = normalizeSwapRoute({ sourceProfile, targetProfile, route }), a = normalizeSwapAction(action);
  return keccak256(encodeAbiParameters([
    { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' },
    { type: 'uint8' }, { type: 'bytes32' }, { type: 'address' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' },
  ], [SWAP_DOMAIN, BigInt(r.chainId), r.adapter as Hex, r.sourcePool as Hex, r.targetPool as Hex, r.router as Hex, r.wrappedNative as Hex, r.factory as Hex,
    r.protocol, r.pathHash, a.processor as Hex, a.amountIn, a.minAmountOut, a.deadline, a.targetPrecommitment, keccak256(a.encryptedTemplate as Hex)]));
}
export const swapActionEnvelope = (options: Parameters<typeof swapActionHash>[0]): Hex => `${swapActionHash(options)}${'00'.repeat(224)}` as Hex;
export interface PreparedSwap extends Prepared { action: SwapAction; actionHash: Hex; actionEnvelope: Hex; route: ReturnType<typeof normalizeSwapRoute> }
/** Builds a source proof and a bound target invoice without predicting DEX output. */
export function prepareSwap({ account, sourceProfile, targetProfile, sourceState, route, action, inputs }:
  { account: Account; sourceProfile: Profile; targetProfile: Profile; sourceState: PublicState; route: SwapRoute; action: { processor: string; amountIn: bigint; minAmountOut: bigint; deadline: bigint }; inputs?: Note[] }): PreparedSwap {
  const r = normalizeSwapRoute({ sourceProfile, targetProfile, route });
  const invoice = createDynamicReceive(account, targetProfile);
  const a = normalizeSwapAction({ ...action, targetPrecommitment: invoice.precommitment, encryptedTemplate: invoice.encryptedTemplate });
  const prepared = prepareJoinSplit({ account, profile: sourceProfile, state: sourceState, inputs, outputs: [], externalData: {
    recipient: r.adapter, feeRecipient: NATIVE_ASSET, processor: r.adapter, publicIn: 0n, publicOut: a.amountIn, fee: 0n,
  } });
  check(prepared.outputNotes[1].commitment === 0n, 'Swap action requires the second source output to be empty.');
  const options = { sourceProfile, targetProfile, route, action: a }, actionHash = swapActionHash(options), actionEnvelope = swapActionEnvelope(options);
  prepared.encryptedOutputs[1] = actionEnvelope;
  const context = joinSplitContext(sourceProfile, prepared.extData, prepared.encryptedOutputs, sourceState.asp);
  prepared.inputSignals.contextBase = joinSplitContextBase(sourceProfile, prepared.extData, prepared.encryptedOutputs);
  prepared.inputSignals.context = context; prepared.publicSignals[3] = String(context);
  return { ...prepared, action: a, actionHash, actionEnvelope, route: r };
}

// ---------- Proof formatting ----------
const BASE_FIELD = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
export interface ProofCoords { pA: [string, string]; pB: [[string, string], [string, string]]; pC: [string, string] }
/** Formats a snarkjs Groth16 proof for the Solidity verifier (note the pi_b coordinate swap). */
export function proofCoords(proof: any): ProofCoords {
  const f = (v: string) => String(field(v, BASE_FIELD - 1n));
  return {
    pA: [f(proof.pi_a[0]), f(proof.pi_a[1])],
    pB: [[f(proof.pi_b[0][1]), f(proof.pi_b[0][0])], [f(proof.pi_b[1][1]), f(proof.pi_b[1][0])]],
    pC: [f(proof.pi_c[0]), f(proof.pi_c[1])],
  };
}
export interface PublicTransaction extends ProofCoords { pubSignals: string[]; extData: Record<keyof ExtData, string>; encryptedOutputs: Hex[] }
export function publicTransaction(prepared: Prepared, proof: any): PublicTransaction {
  check(prepared && Array.isArray(prepared.publicSignals) && prepared.publicSignals.length === 9, 'Invalid prepared JoinSplit.');
  const ext = normalizeExtData(prepared.extData);
  check(Array.isArray(prepared.encryptedOutputs) && prepared.encryptedOutputs.length === 2, 'Invalid encrypted outputs.');
  prepared.encryptedOutputs.forEach(c => bytes(c, RECEIPT_BYTES));
  return {
    ...proofCoords(proof), pubSignals: prepared.publicSignals.map(v => String(field(v))),
    extData: Object.fromEntries(Object.entries(ext).map(([k, v]) => [k, String(v)])) as Record<keyof ExtData, string>,
    encryptedOutputs: [...prepared.encryptedOutputs],
  };
}

// ---------- Public exits (no ASP needed; reveal the note's commitment and value) ----------
function normalizeExitData(data: ExitDataInput): ExitData {
  exactKeys(data, ['processor', 'recipient', 'feeRecipient', 'fee'], 'holder-exit data');
  const result = { processor: address(data.processor, 'exit processor', true), recipient: address(data.recipient, 'exit recipient', true), feeRecipient: address(data.feeRecipient, 'exit fee recipient'), fee: field(data.fee, MAX_VALUE) };
  check(result.fee === 0n || result.feeRecipient !== NATIVE_ASSET, 'Exit fee recipient is zero.'); return result;
}
export function holderExitContext(profile: Profile, externalData: ExitDataInput): bigint {
  const p = normalizeProfile(profile), d = normalizeExitData(externalData);
  return BigInt(keccak256(encodeAbiParameters([
    { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint128' },
  ], [EXIT_DOMAIN, BigInt(p.chainId), p.pool as Hex, p.scope, d.processor as Hex, d.recipient as Hex, d.feeRecipient as Hex, d.fee]))) % FIELD;
}
export interface PreparedExit { inputSignals: Record<string, unknown>; publicSignals: string[]; data: ExitData; note: Note; ragequit?: true; originalDepositor?: string }
export function prepareHolderExit({ account, profile, note, state, externalData }: { account: Account; profile: Profile; note: Note; state?: PublicState; externalData: ExitDataInput }): PreparedExit {
  accountSeed(account);
  const n = normalizeNote(note, profile), secret = spendingSecret(account, profile), nf = nullifier(n, secret, profile), data = normalizeExitData(externalData), p = normalizeProfile(profile);
  check(n.value > 0n && data.fee <= n.value, 'Invalid holder-exit amount or fee.');
  check(data.recipient !== p.pool && (data.fee === 0n || data.feeRecipient !== p.pool), 'Exit cannot pay the pool itself.');
  if (state) {
    const { tree, spent } = publicState(state, profile);
    check(tree.leaves.includes(n.commitment), 'Exit note is absent from canonical pool state.');
    check(!spent.has(String(nf)), 'Exit note has already been spent.');
  }
  const context = holderExitContext(profile, data);
  return { inputSignals: { commitment: n.commitment, nullifier: nf, value: n.value, scope: p.scope, context, secret, blinding: n.blinding },
    publicSignals: [n.commitment, nf, n.value, p.scope, context].map(String), data, note: n };
}
/** Returns an unspent original deposit note to the address that deposited it, with zero fee. */
export function prepareRagequit({ account, profile, note, state, processor }: { account: Account; profile: Profile; note: Note; state: PublicState; processor: string }): PreparedExit {
  accountSeed(account);
  const n = normalizeNote(note, profile);
  nullifier(n, spendingSecret(account, profile), profile);
  check(state && Array.isArray(state.deposits), 'Canonical original-deposit records required for ragequit.');
  const record = state.deposits!.find(r => String(r.commitment) === String(n.commitment));
  check(record && field(record.value, MAX_VALUE, true) === n.value, 'Note has no canonical original-deposit record.');
  const originalDepositor = address(record.originalDepositor, 'original depositor', true);
  return { ...prepareHolderExit({ account, profile, note: n, state, externalData: { processor, recipient: originalDepositor, feeRecipient: NATIVE_ASSET, fee: 0n } }), ragequit: true, originalDepositor };
}
export interface PublicExit extends ProofCoords { pubSignals: string[]; data: Record<keyof ExitData, string> }
export function publicHolderExitTransaction(prepared: PreparedExit, proof: any): PublicExit {
  check(Array.isArray(prepared?.publicSignals) && prepared.publicSignals.length === 5, 'Prepared five-signal holder exit required.');
  const data = normalizeExitData(prepared.data);
  return { ...proofCoords(proof), pubSignals: prepared.publicSignals.map(v => String(field(v))),
    data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, typeof v === 'bigint' ? String(v) : v])) as Record<keyof ExitData, string> };
}

/** Saves own outputs (change) into the account before broadcast so they stay recoverable. */
export function rememberOutputs(account: Account, profile: Profile, prepared: Prepared) {
  accountSeed(account);
  const own = field(receiverAddress(account, profile).ownerPublicKey), notes = new Map(account.notes.map(t => [t, t]));
  for (const output of prepared.outputNotes ?? []) {
    const note = normalizeNote(output, profile);
    if (note.value > 0n && note.ownerPublicKey === own) { const t = serializeNote(note, profile); notes.set(t, t); }
  }
  check(notes.size <= MAX_NOTES, 'Wallet note capacity exceeded.'); account.notes = [...notes.values()];
}

// ---------- Encrypted backup (identical envelope to the CLI) ----------
export interface Envelope { schema: 'phase2-asp-encrypted-account/v1'; kdf: 'scrypt'; N: number; r: number; p: number; salt: string; iv: string; ciphertext: string; tag: string }
const backupAAD = enc.encode('CHENG_PHASE2_ASP_ENCRYPTED_ACCOUNT_V1');
function passwordCheck(password: string) {
  const n = enc.encode(password).length;
  check(typeof password === 'string' && n >= 16 && n <= 1024, 'Password must be 16–1024 bytes.');
}
const kdf = (password: string, salt: Uint8Array) => scryptAsync(enc.encode(password), salt, { N: BACKUP_N, r: BACKUP_R, p: BACKUP_P, dkLen: 32, maxmem: 64 * 1024 * 1024 });
/** Seals with an already derived key (fresh IV) so saves after unlock skip scrypt. Still a standard envelope. */
export function sealAccountWithKey(account: Account, salt: Uint8Array, key: Uint8Array): Envelope {
  accountSeed(account); exactKeys(account, ['version', 'seed', 'notes'], 'account');
  const iv = randomBytes(12), sealed = gcm(key, iv, backupAAD).encrypt(enc.encode(JSON.stringify(account)));
  return { schema: 'phase2-asp-encrypted-account/v1', kdf: 'scrypt', N: BACKUP_N, r: BACKUP_R, p: BACKUP_P, salt: toHex(salt), iv: toHex(iv), ciphertext: toHex(sealed.subarray(0, -16)), tag: toHex(sealed.subarray(-16)) };
}
export async function sealAccount(account: Account, password: string): Promise<Envelope> {
  passwordCheck(password);
  const salt = randomBytes(32);
  return sealAccountWithKey(account, salt, await kdf(password, salt));
}
export async function deriveBackupKey(password: string, envelope?: Envelope) {
  passwordCheck(password);
  const salt = envelope ? bytes(envelope.salt, 32) : randomBytes(32);
  return { salt, key: await kdf(password, salt) };
}
export async function openAccount(envelope: Envelope, password: string): Promise<Account> {
  passwordCheck(password);
  exactKeys(envelope, ['schema', 'kdf', 'N', 'r', 'p', 'salt', 'iv', 'ciphertext', 'tag'], 'backup');
  check(envelope.schema === 'phase2-asp-encrypted-account/v1' && envelope.kdf === 'scrypt' && envelope.N === BACKUP_N && envelope.r === BACKUP_R && envelope.p === BACKUP_P, 'Unsupported backup KDF parameters.');
  const key = await kdf(password, bytes(envelope.salt, 32));
  let account: Account;
  try {
    const plain = gcm(key, bytes(envelope.iv, 12), backupAAD).decrypt(concat(fromHex(envelope.ciphertext), bytes(envelope.tag, 16)));
    account = JSON.parse(new TextDecoder().decode(plain));
  } catch { throw new Error('Wrong password or corrupted backup.'); }
  exactKeys(account, ['version', 'seed', 'notes'], 'account'); accountSeed(account);
  check(account.notes.every(n => typeof n === 'string' && n.length <= 2048), 'Invalid backup note collection.');
  return account;
}
/** Local, non-backup storage key for activity history; derived from the seed so it unlocks with the vault. */
export const activityKey = (account: Account) => hmac(sha256, accountSeed(account), enc.encode('CHENG_WEB_ACTIVITY_V1'));
export { gcm as aesGcm, toHex, fromHex };

// ---------- Paid swap routes (port of /privacy src/phase2-fees/sdk.mjs) ----------
// Fee adapters reuse the JoinSplit circuit with a distinct, proof-bound action envelope that also binds the
// adapter's immutable fee (bps) and treasury, and the user's absolute fee cap. minAmountOut is the NET output.
export const FEE_SWAP_DOMAIN = keccak256(stringToHex('LINCOLN_PHASE2_FEE_ROUTES_V1'));
export const MAX_SERVICE_FEE_BPS = 100;
export const FEE_ADAPTER_TYPES = ['Phase2FeeRouteAdapter', 'Phase2FeeRouter02Adapter'] as const;
export const isFeeRoute = (route: SwapRoute) => FEE_ADAPTER_TYPES.includes(route.adapterType as typeof FEE_ADAPTER_TYPES[number]);
export interface FeeSwapAction extends SwapAction { maxServiceFee: bigint }

const feeBpsOf = (bps: unknown) => { check(Number.isSafeInteger(bps) && (bps as number) > 0 && (bps as number) <= MAX_SERVICE_FEE_BPS, 'Invalid service fee rate.'); return bps as number; };
export const serviceFee = (gross: bigint | string, bps: number) => field(gross, MAX_VALUE) * BigInt(feeBpsOf(bps)) / 10_000n;
export function minimumGrossOutput(minNet: bigint | string, bps: number) {
  const net = field(minNet, MAX_VALUE, true), gross = (net - 1n) * 10_000n / BigInt(10_000 - feeBpsOf(bps)) + 1n;
  check(gross <= MAX_VALUE, 'Gross output exceeds uint128.');
  return gross;
}
export function normalizeFeeSwapRoute(options: { sourceProfile: Profile; targetProfile: Profile; route: SwapRoute }) {
  const { route } = options;
  check(isFeeRoute(route), 'Unsupported fee adapter.');
  const geometry = normalizeSwapRoute(options);
  check(route.adapterType !== 'Phase2FeeRouter02Adapter' || geometry.protocol === 0, 'Router02 adapters require Uniswap V3.');
  const feeBps = feeBpsOf(route.feeBps), treasury = address(route.treasury as string, 'fee treasury', true);
  check(![geometry.adapter, geometry.router, geometry.wrappedNative, geometry.factory, geometry.sourcePool, geometry.targetPool, ...geometry.tokens].includes(treasury), 'Invalid fee treasury.');
  return { ...geometry, adapterType: route.adapterType as string, feeBps, treasury };
}
export function normalizeFeeSwapAction(action: { processor: string; amountIn: bigint | string; minAmountOut: bigint | string; deadline: bigint | string; targetPrecommitment: bigint | string; encryptedTemplate: string; maxServiceFee: bigint | string }): FeeSwapAction {
  exactKeys(action, ['processor', 'amountIn', 'minAmountOut', 'deadline', 'targetPrecommitment', 'encryptedTemplate', 'maxServiceFee'], 'fee swap action');
  const { maxServiceFee, ...base } = action;
  return { ...normalizeSwapAction(base), maxServiceFee: field(maxServiceFee, MAX_VALUE) };
}
export function feeSwapActionHash({ sourceProfile, targetProfile, route, action }: { sourceProfile: Profile; targetProfile: Profile; route: SwapRoute; action: FeeSwapAction }): Hex {
  const r = normalizeFeeSwapRoute({ sourceProfile, targetProfile, route }), a = normalizeFeeSwapAction(action);
  return keccak256(encodeAbiParameters([
    { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' },
    { type: 'uint8' }, { type: 'bytes32' }, { type: 'uint16' }, { type: 'address' }, { type: 'address' }, { type: 'uint128' }, { type: 'uint128' },
    { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'uint128' },
  ], [FEE_SWAP_DOMAIN, BigInt(r.chainId), r.adapter as Hex, r.sourcePool as Hex, r.targetPool as Hex, r.router as Hex, r.wrappedNative as Hex, r.factory as Hex,
    r.protocol, r.pathHash, r.feeBps, r.treasury as Hex, a.processor as Hex, a.amountIn, a.minAmountOut, a.deadline, a.targetPrecommitment, keccak256(a.encryptedTemplate as Hex), a.maxServiceFee]));
}
export const feeSwapActionEnvelope = (options: Parameters<typeof feeSwapActionHash>[0]): Hex => `${feeSwapActionHash(options)}${'00'.repeat(224)}` as Hex;
export interface PreparedFeeSwap extends Prepared { action: FeeSwapAction; actionHash: Hex; actionEnvelope: Hex; route: ReturnType<typeof normalizeFeeSwapRoute> }
/** A paid swap: minAmountOut is the user's NET private output after the adapter's fee; maxServiceFee caps that fee. */
export function prepareFeeSwap({ account, sourceProfile, targetProfile, sourceState, route, action, inputs }:
  { account: Account; sourceProfile: Profile; targetProfile: Profile; sourceState: PublicState; route: SwapRoute; action: { processor: string; amountIn: bigint; minAmountOut: bigint; deadline: bigint; maxServiceFee: bigint }; inputs?: Note[] }): PreparedFeeSwap {
  const r = normalizeFeeSwapRoute({ sourceProfile, targetProfile, route });
  const invoice = createDynamicReceive(account, targetProfile);
  const a = normalizeFeeSwapAction({ ...action, targetPrecommitment: invoice.precommitment, encryptedTemplate: invoice.encryptedTemplate });
  minimumGrossOutput(a.minAmountOut, r.feeBps);
  const prepared = prepareJoinSplit({ account, profile: sourceProfile, state: sourceState, inputs, outputs: [], externalData: {
    recipient: r.adapter, feeRecipient: NATIVE_ASSET, processor: r.adapter, publicIn: 0n, publicOut: a.amountIn, fee: 0n,
  } });
  check(prepared.outputNotes[1].commitment === 0n, 'Swap action requires the second source output to be empty.');
  const options = { sourceProfile, targetProfile, route, action: a }, actionHash = feeSwapActionHash(options), actionEnvelope = feeSwapActionEnvelope(options);
  prepared.encryptedOutputs[1] = actionEnvelope;
  const context = joinSplitContext(sourceProfile, prepared.extData, prepared.encryptedOutputs, sourceState.asp);
  prepared.inputSignals.contextBase = joinSplitContextBase(sourceProfile, prepared.extData, prepared.encryptedOutputs);
  prepared.inputSignals.context = context; prepared.publicSignals[3] = String(context);
  return { ...prepared, action: a, actionHash, actionEnvelope, route: r };
}
