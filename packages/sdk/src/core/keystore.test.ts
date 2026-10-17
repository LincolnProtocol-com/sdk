import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createKey, keysFromSignature, readKeyFile, signMessageFor, unlockKey } from './keystore.js';
import { NETWORKS } from './network.js';

describe('agent keystore', () => {
  it('signs the same sign-in message as the web app', () => {
    // privacy-frontend src/wallet/signature-key.ts on testnet, byte for byte.
    expect(signMessageFor(NETWORKS.testnet)).toBe('Lincoln Protocol\n\nSign to open your private wallet on Robinhood Chain testnet (chain 46630).\n\nThis is free and sends no transaction. Anyone with this signature can spend your private balance, so only sign it on the Lincoln app.\n\nVersion: 1');
  });
  it('seals the key with a passphrase and derives a stable seed', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'lincoln-')), 'agent.json');
    const kf = await createKey(file, 46630, 'correct horse');
    expect('sealed' in kf.key).toBe(true);
    await expect(createKey(file, 46630)).rejects.toThrow(/already exists/);
    const signer = await unlockKey((await readKeyFile(file))!, 'correct horse');
    expect(signer.address).toBe(kf.address);
    await expect(unlockKey(kf, 'wrong')).rejects.toThrow(/Wrong passphrase/);
    const sig = await signer.signMessage({ message: signMessageFor(NETWORKS.testnet) });
    expect(keysFromSignature(sig, 46630).seed).toBe(keysFromSignature(sig, 46630).seed);
    expect(keysFromSignature(sig, 46630).seed).not.toBe(keysFromSignature(sig, 4663).seed);
  });
});
