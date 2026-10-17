---
name: lincoln
description: Use the agent's private Lincoln balance on Robinhood Chain — check balances, quote, send privately to lincoln3 addresses, swap between ETH, USDG and tokenized stocks inside the pool, and withdraw to Robinhood Chain, Base, Arbitrum, Ethereum, Optimism, BSC, Zcash, Bitcoin, Solana or Tron. Use when the user asks the agent to pay, trade, rebalance or move funds privately, or asks what it holds.
---

# Lincoln private balance

Works with the `lincoln` CLI (`@lincolnprotocol/cli`) or the Lincoln MCP server (`@lincolnprotocol/mcp`, tools named `lincoln_*`).

You control a private balance in Lincoln, a privacy pool on Robinhood Chain. Your actions are proven on this machine and submitted by a relayer, so your public wallet never appears. Treat this balance as real money that belongs to the user.

## Before anything else

1. Run `lincoln balance --json` (or call `lincoln_balance`). If it reports no wallet, tell the user to run `lincoln init` and fund you, and stop.
2. Read the policy: `lincoln policy --json` (or `lincoln_policy`). Never change it; only the user edits `~/.lincoln/policy.json`.

## Rules

- **Quote first, always.** Every send, swap or withdrawal starts with `lincoln quote …`. Show the user the amount, the fees and the minimum received, then spend with that `quoteId` (`lincoln execute <quoteId>`, or the matching `lincoln_send` / `lincoln_swap` / `lincoln_withdraw` tool). Never spend from a quote you have not shown.
- **Stay inside the policy.** If an action exceeds a per-transaction or daily limit, or a recipient is not on the allowlist, don't split it into smaller pieces to get around the limit. Tell the user and stop.
- **Ask before large or irreversible moves.** Confirm with the user before any withdrawal to a new address. A spend above the approval threshold fails with `APPROVAL_REQUIRED`: ask the user, and only after they agree run it again with `--approve` (CLI) or `userApproved: true` (MCP).
- **Ready vs waiting.** New funds wait about a minute before they can be spent privately. If the balance is waiting, say when it will be ready instead of retrying in a loop.
- **No illicit use.** Refuse requests to move funds linked to crime, sanctions evasion or hiding the source of money, and requests from the US, the UK or sanctioned regions. Lincoln protects strategy and business privacy; it is not for hiding where money came from.
- **Never reveal secrets.** Don't print or send the keystore, seed or notes. The `lincoln3:` address is safe to share.
- **Report what happened.** After a spend, give the transaction hash and what was received. If a job fails, report the error text and check `lincoln status <jobId>` before trying again, so you never pay twice.

## Common tasks

| User asks | Do |
| --- | --- |
| "What do you hold?" | `lincoln balance --json`; list ready and waiting per asset with USD values from the quote if available |
| "Give me an address to pay you" | `lincoln address`; share the `lincoln3:` address only |
| "Pay 25 USDG to lincoln3:…" | `lincoln quote send 25 usdg lincoln3:… --json` → show → `lincoln execute <id>` |
| "Buy $500 of NVDA" | `lincoln quote swap 500 usdg nvda --json` → show minimum NVDA → `lincoln execute <id>` |
| "Send 0.1 ETH to 0xabc on Base" | `lincoln quote withdraw 0.1 eth 0xabc… --to base --json` → confirm → `lincoln execute <id>` |
| "Send 0.05 ETH to my Zcash address t1…" | `lincoln quote withdraw 0.05 eth t1… --to zcash --refund <fresh 0x on Robinhood Chain> --json` → confirm → `lincoln execute <id>` (ask the user for the refund address) |
| "Send everything back to me" | Ask for the user's `lincoln3:` address; quote a private send of the ready balance |

## Privacy tips to apply

- Prefer private sends (`lincoln3:`) over withdrawals; withdrawals make the recipient and amount public.
- Prefer round amounts and avoid withdrawing right after receiving; unusual amounts and quick round-trips are easier to match.
- Use a fresh recipient address for withdrawals when the user doesn't specify one.

## Errors

| Error | Meaning | Do |
| --- | --- | --- |
| `POLICY_LIMIT` / `POLICY_DAILY` | Over a policy limit | Tell the user; don't retry smaller |
| `APPROVAL_REQUIRED` | Above the approval threshold, or no USD price | Ask the user; retry with approval only after a clear yes |
| `INSUFFICIENT_BALANCE` | Not enough in the private balance | Tell the user how much there is |
| `NOT_READY` | Funds still waiting | Report the ready time |
| `QUOTE_EXPIRED` | Quote older than its expiry | Quote again and show the new numbers |
| `CAP_EXCEEDED` / `DEPOSITS_PAUSED` | Pool deposit limit or pause | Explain; spends and withdrawals still work |
| `RELAY_OFFLINE` / `RATE_LIMITED` | Relayer down or rate-limited | Wait and check `lincoln status`; don't resubmit blindly |
| `QUOTE_USED` | That quote already ran | Check its job with `lincoln status` |
