// Spending policy for an agent, read from <home>/policy.json before every spend. It is enforced here,
// in software on the agent's machine, not by the contracts: anyone holding the agent's key can spend
// its whole balance, so keep only what the agent needs in it.
import { readFile } from 'node:fs/promises';
import { writePrivate } from './keystore.js';

export interface Policy {
  /** Largest single spend, in USD. */
  perTransactionUsd: number;
  /** Total spends in any 24 hours, in USD. */
  dailyUsd: number;
  /** Spends above this need the user's explicit approval. */
  approvalAboveUsd: number;
  /** Allowed recipients (lincoln3: or 0x addresses). Empty allows any. */
  allowedRecipients: string[];
  allowedActions: ('send' | 'swap' | 'withdraw' | 'deposit')[];
}

export const DEFAULT_POLICY: Policy = {
  perTransactionUsd: 250, dailyUsd: 1000, approvalAboveUsd: 100, allowedRecipients: [], allowedActions: ['send', 'swap', 'withdraw', 'deposit'],
};

export async function readPolicy(file: string): Promise<Policy> {
  const text = await readFile(file, 'utf8').catch(() => null);
  if (!text) return DEFAULT_POLICY;
  const p = { ...DEFAULT_POLICY, ...JSON.parse(text) } as Policy;
  for (const k of ['perTransactionUsd', 'dailyUsd', 'approvalAboveUsd'] as const) if (!(typeof p[k] === 'number' && p[k] >= 0)) throw new Error(`policy.json: ${k} must be a number ≥ 0.`);
  return p;
}
export const writeDefaultPolicy = (file: string) => writePrivate(file, JSON.stringify(DEFAULT_POLICY, null, 2) + '\n');

export interface PolicyCheck { allowed: boolean; needsApproval: boolean; code?: 'POLICY_ACTION' | 'POLICY_RECIPIENT' | 'POLICY_LIMIT' | 'POLICY_DAILY'; reason?: string }

/** `usd` null means no price is known: such spends always need approval and never count as within limits. */
export function checkPolicy(policy: Policy, { action, usd, recipient, spentTodayUsd }: { action: Policy['allowedActions'][number]; usd: number | null; recipient?: string; spentTodayUsd: number }): PolicyCheck {
  if (!policy.allowedActions.includes(action)) return { allowed: false, needsApproval: false, code: 'POLICY_ACTION', reason: `The policy does not allow "${action}".` };
  if (recipient && policy.allowedRecipients.length && !policy.allowedRecipients.some(r => r.toLowerCase() === recipient.trim().toLowerCase()))
    return { allowed: false, needsApproval: false, code: 'POLICY_RECIPIENT', reason: 'That recipient is not on the policy allowlist.' };
  if (usd !== null && usd > policy.perTransactionUsd) return { allowed: false, needsApproval: false, code: 'POLICY_LIMIT', reason: `$${usd.toFixed(2)} is over the per-transaction limit of $${policy.perTransactionUsd}.` };
  if (usd !== null && spentTodayUsd + usd > policy.dailyUsd) return { allowed: false, needsApproval: false, code: 'POLICY_DAILY', reason: `This would bring today’s spending to $${(spentTodayUsd + usd).toFixed(2)}, over the daily limit of $${policy.dailyUsd}.` };
  return { allowed: true, needsApproval: usd === null || usd > policy.approvalAboveUsd };
}
