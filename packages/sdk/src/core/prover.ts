// Groth16 proofs on this machine. Circuit files are fetched once from the Lincoln app, checked against
// the hash pins that ship with the package, and cached under the Lincoln home directory. The witness
// never leaves this process.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as snarkjs from 'snarkjs';
import { NET, type CircuitFile } from './network.js';

export type Circuit = 'joinsplit' | 'holder-exit';
export type ProofStage = 'download' | 'prove' | 'verify';

let cacheDir = '';
/** Where circuit files are cached (set by Lincoln.open to <home>/circuits). */
export function setCircuitCache(dir: string) { cacheDir = dir; }

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const loaded = new Map<string, Promise<Uint8Array>>();

async function load(entry: CircuitFile): Promise<Uint8Array> {
  let hit = loaded.get(entry.sha256);
  if (!hit) {
    hit = (async () => {
      const file = cacheDir && join(cacheDir, entry.sha256);
      if (file) {
        const cached = await readFile(file).catch(() => null);
        if (cached && cached.length === entry.bytes && sha256(cached) === entry.sha256) return new Uint8Array(cached);
      }
      const res = await fetch(`${NET.app}${entry.path}`);
      if (!res.ok) throw new Error(`Unable to download ${entry.path} (${res.status}).`);
      const data = new Uint8Array(await res.arrayBuffer());
      if (data.length !== entry.bytes || sha256(data) !== entry.sha256) throw new Error(`Circuit file ${entry.path} does not match its pinned hash.`);
      if (file) { await mkdir(cacheDir, { recursive: true }); await writeFile(`${file}.tmp`, data); await rename(`${file}.tmp`, file); }
      return data;
    })();
    hit.catch(() => loaded.delete(entry.sha256));
    loaded.set(entry.sha256, hit);
  }
  return hit;
}

const stringify = (value: unknown): unknown =>
  typeof value === 'bigint' ? String(value) : Array.isArray(value) ? value.map(stringify)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stringify(v)])) : value;

/** Downloads (if needed) and checks a circuit's files ahead of the first proof. */
export async function warmCircuit(circuit: Circuit) {
  const c = NET.circuits?.[circuit]; if (!c) throw new Error(`No ${circuit} circuit for ${NET.label}.`);
  await Promise.all([load(c.wasm), load(c.zkey), load(c.vkey)]);
}

/** Generates a proof and verifies it locally before it is sent anywhere. */
export async function prove(circuit: Circuit, prepared: { inputSignals: Record<string, unknown>; publicSignals: string[] }, onStage?: (stage: ProofStage) => void): Promise<unknown> {
  const c = NET.circuits?.[circuit]; if (!c) throw new Error(`No ${circuit} circuit for ${NET.label}.`);
  onStage?.('download');
  const [wasm, zkey, vkeyBytes] = await Promise.all([load(c.wasm), load(c.zkey), load(c.vkey)]);
  onStage?.('prove');
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(stringify(prepared.inputSignals) as any, { type: 'mem', data: wasm } as any, { type: 'mem', data: zkey } as any);
  onStage?.('verify');
  const vkey = JSON.parse(new TextDecoder().decode(vkeyBytes));
  if (!await snarkjs.groth16.verify(vkey, publicSignals, proof)) throw new Error('Generated proof failed local verification.');
  if (publicSignals.length !== prepared.publicSignals.length || publicSignals.some((v: string, i: number) => String(v) !== prepared.publicSignals[i])) throw new Error('Prover returned unexpected public signals.');
  return proof;
}
