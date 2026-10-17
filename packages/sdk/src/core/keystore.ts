// The agent's wallet on disk. One public key pair (an ordinary EOA) per network: it signs the same
// fixed message the Lincoln web app uses for signature sign-in, and the private wallet seed is derived
// from that signature. So the agent's private balance can also be opened in the app by importing this
// key into a browser wallet. The key is encrypted with a passphrase when one is given.
import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { gcm } from '@noble/ciphers/aes.js';
import { bytesToHex, getAddress, hexToBytes, isHex, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { NetworkInfo } from './network.js';

/** Byte-identical to the web app's current sign-in message (EIP-4361, privacy-frontend src/wallet/signature-key.ts). */
export const signInMessageFor = (net: NetworkInfo, address: string) => [
  'app.lincolnprotocol.com wants you to sign in with your Ethereum account:',
  getAddress(address),
  '',
  `Open your Lincoln private wallet on ${net.label}. Free, no transaction. Anyone with this signature can spend your private balance, so sign it only on app.lincolnprotocol.com.`,
  '',
  'URI: https://app.lincolnprotocol.com',
  'Version: 1',
  `Chain ID: ${net.id}`,
  'Nonce: lincolnprivatewallet',
  'Issued At: 2026-10-17T00:00:00.000Z',
].join('\n');

/** The legacy (version 1) message: agent wallets created before 17 October 2026 keep using it. */
export const signMessageFor = (net: NetworkInfo) => [
  'Lincoln Protocol',
  '',
  `Sign to open your private wallet on ${net.label} (chain ${net.id}).`,
  '',
  'This is free and sends no transaction. Anyone with this signature can spend your private balance, so only sign it on the Lincoln app.',
  '',
  'Version: 1',
].join('\n');

const enc = new TextEncoder();
const SALT = enc.encode('LINCOLN_SIGNATURE_WALLET_V1');
const SALT_V2 = enc.encode('LINCOLN_SIGNATURE_WALLET_V2');
export interface SignatureKeys { seed: string; cacheKey: Uint8Array }
export function keysFromSignature(signature: Hex, chainId: number, version: 1 | 2 = 1): SignatureKeys {
  if (!isHex(signature) || (signature.length !== 132 && signature.length !== 130)) throw new Error('Unexpected signature format.');
  const ikm = hexToBytes(signature), salt = version === 2 ? SALT_V2 : SALT;
  const seed = bytesToHex(hkdf(sha256, ikm, salt, enc.encode(`seed:${chainId}`), 32)).slice(2);
  return { seed, cacheKey: hkdf(sha256, ikm, salt, enc.encode(`cache:${chainId}`), 32) };
}
/** The seed keys for an agent key file: its sign-in version decides the message (absent = legacy 1). */
export async function walletKeys(kf: KeyFile, signer: { signMessage(a: { message: string }): Promise<Hex> }, net: NetworkInfo) {
  const version = kf.signIn ?? 1;
  const message = version === 2 ? signInMessageFor(net, kf.address) : signMessageFor(net);
  return keysFromSignature(await signer.signMessage({ message }), net.id, version);
}

interface Sealed { kdf: 'scrypt'; N: number; r: number; p: number; salt: string; iv: string; data: string }
export interface KeyFile { schema: 'lincoln-agent-key/v1'; chainId: number; address: Hex; createdAt: string; key: { plain: Hex } | { sealed: Sealed };
  /** Sign-in message version the seed comes from: 2 = SIWE (new wallets), absent = legacy 1. */
  signIn?: 2 }

const SCRYPT = { N: 2 ** 17, r: 8, p: 1 };
async function seal(secret: Uint8Array, passphrase: string): Promise<Sealed> {
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = await scryptAsync(enc.encode(passphrase), salt, { ...SCRYPT, dkLen: 32 });
  return { kdf: 'scrypt', ...SCRYPT, salt: bytesToHex(salt), iv: bytesToHex(iv), data: bytesToHex(gcm(key, iv).encrypt(secret)) };
}
async function unseal(s: Sealed, passphrase: string): Promise<Uint8Array> {
  const key = await scryptAsync(enc.encode(passphrase), hexToBytes(s.salt as Hex), { N: s.N, r: s.r, p: s.p, dkLen: 32 });
  try { return gcm(key, hexToBytes(s.iv as Hex)).decrypt(hexToBytes(s.data as Hex)); }
  catch { throw new Error('Wrong passphrase for the agent wallet (LINCOLN_PASSPHRASE).'); }
}

export async function writePrivate(file: string, text: string) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(`${file}.tmp`, text, { mode: 0o600 });
  await rename(`${file}.tmp`, file);
  await chmod(file, 0o600).catch(() => undefined);
}

/** Creates a new agent key. Refuses to overwrite an existing one. */
export async function createKey(file: string, chainId: number, passphrase?: string): Promise<KeyFile> {
  if (await readFile(file).then(() => true, () => false)) throw new Error(`An agent wallet already exists at ${file}.`);
  const pk = generatePrivateKey(), address = privateKeyToAccount(pk).address;
  const key = passphrase ? { sealed: await seal(hexToBytes(pk), passphrase) } : { plain: pk };
  const kf: KeyFile = { schema: 'lincoln-agent-key/v1', chainId, address, createdAt: new Date().toISOString(), key, signIn: 2 };
  await writePrivate(file, JSON.stringify(kf, null, 2));
  return kf;
}

export async function readKeyFile(file: string): Promise<KeyFile | null> {
  const text = await readFile(file, 'utf8').catch(() => null);
  if (!text) return null;
  const kf = JSON.parse(text) as KeyFile;
  if (kf.schema !== 'lincoln-agent-key/v1') throw new Error(`Unrecognised agent wallet file ${file}.`);
  return kf;
}

export async function unlockKey(kf: KeyFile, passphrase?: string): Promise<PrivateKeyAccount> {
  let pk: Hex;
  if ('plain' in kf.key) pk = kf.key.plain;
  else {
    if (!passphrase) throw new Error('The agent wallet is encrypted: set LINCOLN_PASSPHRASE.');
    pk = bytesToHex(await unseal(kf.key.sealed, passphrase));
  }
  const account = privateKeyToAccount(pk);
  if (account.address.toLowerCase() !== kf.address.toLowerCase()) throw new Error('Agent wallet file is inconsistent.');
  return account;
}
