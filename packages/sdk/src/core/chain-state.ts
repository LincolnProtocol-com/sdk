// Rebuilds a pool's public state straight from chain logs, with no relay involved. Used when the
// relay is unreachable so a holder can still find their notes and exit by themselves. It mirrors
// the relay's own builder (privacy/src/phase2-asp/state.mjs) for the pool events, but leaves the
// association set unknown: exits never need it, and private spends wait for the relay anyway.
import { decodeEventLog, type Hex, type Log } from 'viem';
import * as sdk from './sdk.js';
import { POOLS, POOL_ABI, REGISTRY_ABI, publicClient, type PoolId } from './pools.js';
import type { PoolState } from './state.js';

const CHUNK = 500_000n;
const s = (v: unknown) => String(v);

/** Pool logs from the deployment block to `head`, in ranges the RPC accepts (halved on refusal). */
async function poolLogs(address: Hex, from: bigint, head: bigint) {
  const logs: Log[] = [];
  let span = CHUNK;
  for (let cursor = from; cursor <= head;) {
    const to = cursor + span - 1n < head ? cursor + span - 1n : head;
    try { logs.push(...await publicClient.getLogs({ address, fromBlock: cursor, toBlock: to })); cursor = to + 1n; }
    catch (e) { if (span <= 1_000n) throw e; span /= 4n; }
  }
  return logs.sort((a, b) => Number(a.blockNumber! - b.blockNumber!) || a.logIndex! - b.logIndex!);
}

export async function chainPoolState(pool: PoolId): Promise<PoolState> {
  const profile = POOLS[pool].profile, address = profile.pool.address as Hex;
  const head = await publicClient.getBlockNumber();
  const [block, logs, policy] = await Promise.all([
    publicClient.getBlock({ blockNumber: head }),
    poolLogs(address, BigInt(profile.pool.startBlock), head),
    publicClient.readContract({ address: profile.registry.address as Hex, abi: REGISTRY_ABI, functionName: 'latestPolicy' }) as Promise<readonly [bigint, bigint, bigint]>,
  ]);

  const commitments: string[] = [], nullifiers: string[] = [], receipts: sdk.Receipt[] = [];
  const deposits: PoolState['deposits'] = [], exits: PoolState['exits'] = [], flows: PoolState['flows'] = [];
  let reserve = 0n;
  for (const log of logs) {
    let event: { eventName: string; args: any };
    try { event = decodeEventLog({ abi: POOL_ABI, topics: log.topics, data: log.data, strict: true }) as any; } catch { continue; }
    const a = event.args, meta = { transactionHash: log.transactionHash!, blockNumber: s(log.blockNumber) };
    switch (event.eventName) {
      case 'NewCommitment':
        if (Number(a.index) !== commitments.length) throw new Error('Chain logs are missing a commitment; try another RPC.');
        commitments.push(s(a.commitment)); receipts.push({ commitment: s(a.commitment), index: Number(a.index), encryptedOutput: a.encryptedOutput, ...meta } as sdk.Receipt);
        break;
      case 'NewNullifier': nullifiers.push(s(a.nullifier)); break;
      case 'DynamicDeposited': {
        const receipt = receipts.at(-1) as sdk.Receipt & Record<string, unknown>;
        Object.assign(receipt, { kind: 'dynamic', value: s(a.value), precommitment: s(a.precommitment), encryptedTemplate: a.encryptedTemplate, originalDepositor: a.processor.toLowerCase() });
        deposits.push({ commitment: s(a.commitment), value: s(a.value), precommitment: s(a.precommitment), originalDepositor: a.processor.toLowerCase(), ...meta });
        reserve += BigInt(a.value);
        flows.push({ kind: 'dynamic', processor: a.processor, publicIn: s(a.value), publicOut: '0', ...meta });
        break;
      }
      case 'PublicFlow':
        reserve -= BigInt(a.publicOut);
        flows.push({ kind: 'normal', processor: a.processor, publicIn: s(a.publicIn), publicOut: s(a.publicOut), ...meta, ...{ recipient: a.recipient } });
        break;
      case 'HolderExited':
        reserve -= BigInt(a.value);
        exits.push({ commitment: s(a.commitment), value: s(a.value), recipient: a.recipient, transactionHash: meta.transactionHash });
        flows.push({ kind: 'holder-exit', processor: a.processor, publicIn: '0', publicOut: s(a.value), ...meta, ...{ recipient: a.recipient } });
        break;
    }
  }

  const root = sdk.buildMerkleTree(commitments).root;
  // Same check the relay path makes: the rebuilt tree must be one the pool contract knows.
  const known = await publicClient.readContract({ address, abi: POOL_ABI, functionName: 'knownRoot', args: [root] }) as boolean;
  if (!known) throw new Error('The rebuilt pool state does not match the contract. The RPC may be behind; try again or use another RPC.');
  const [aspRoot, epoch, validUntil] = policy;
  return {
    chainId: profile.chain.id, pool: profile.pool.address, scope: profile.pool.scope, noteModel: sdk.NOTE_MODEL,
    blockNumber: s(head), blockTimestamp: s(block.timestamp), root: s(root), reserve: s(reserve),
    commitments, nullifiers, receipts, deposits, exits, flows,
    asp: { root: s(aspRoot), epoch: s(epoch), validUntil: s(validUntil), leaves: null, expired: true },
    source: 'chain',
  } as PoolState;
}
