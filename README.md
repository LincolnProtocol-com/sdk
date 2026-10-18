# Lincoln SDK, CLI and MCP server

Give an AI agent (or any program) its own private balance on Robinhood Chain. Hold ETH, dollars and tokenized stocks in the [Lincoln](https://lincolnprotocol.com) privacy pool; send, swap and withdraw with zero-knowledge proofs generated on your machine and submitted by a relayer, so the agent's wallet never appears on chain.

> **Status:** release candidate on Robinhood Chain mainnet (chain 4663): 13 pools (ETH, USDG, USDe, eight stock tokens, PONS and CASHCAT). The contracts are not independently audited yet.

| Package | What it is |
| --- | --- |
| [`@lincolnprotocol/sdk`](packages/sdk) | TypeScript library for Node 20+ |
| [`@lincolnprotocol/cli`](packages/cli) | `lincoln` command, with `--json` for agents |
| [`@lincolnprotocol/mcp`](packages/mcp) | MCP server for Claude, Codex, Cursor and other MCP clients |
| [`skills/lincoln`](skills/lincoln/SKILL.md) | Agent skill: how to use the tools safely |

## Install

**Claude Code** (skill + MCP server in one plugin):

```
/plugin install lincoln --marketplace LincolnProtocol-com/sdk
```

Then create the wallet (`npx @lincolnprotocol/cli init`, below) and start Claude Code with `LINCOLN_PASSPHRASE` set in its environment.

**Any MCP client:**

```sh
export LINCOLN_PASSPHRASE='…'                 # encrypts the agent key; required on mainnet
npx @lincolnprotocol/cli init                 # creates ~/.lincoln/mainnet/agent.json and ~/.lincoln/policy.json
claude mcp add lincoln -e LINCOLN_PASSPHRASE="$LINCOLN_PASSPHRASE" -- npx -y @lincolnprotocol/mcp
codex mcp add lincoln --env LINCOLN_PASSPHRASE="$LINCOLN_PASSPHRASE" -- npx -y @lincolnprotocol/mcp
```

**Just looking?** The hosted server is read-only and needs no key or install (pools, fees, relay status, prices, docs):

```sh
claude mcp add --transport http lincoln-docs https://mcp.lincolnprotocol.com/mcp
```

**Other harnesses** read [AGENTS.md](AGENTS.md); the skill alone is `cp -r skills/lincoln ~/.claude/skills/`.

## CLI

```sh
npm i -g @lincolnprotocol/cli
lincoln address       # share the lincoln3: address to fund it privately
lincoln balance
lincoln quote swap 100 usdg nvda
lincoln execute q_…
```

## MCP

```json
{
  "mcpServers": {
    "lincoln": {
      "command": "npx",
      "args": ["-y", "@lincolnprotocol/mcp"],
      "env": { "LINCOLN_PASSPHRASE": "…" }
    }
  }
}
```

Tools: `lincoln_balance`, `lincoln_address`, `lincoln_pools`, `lincoln_policy`, `lincoln_activity`, `lincoln_status`, `lincoln_quote`, and `lincoln_send` / `lincoln_swap` / `lincoln_withdraw` / `lincoln_deposit`, which take a `quoteId`, never raw amounts.

## SDK

```ts
import { Lincoln } from '@lincolnprotocol/sdk';

const agent = await Lincoln.open();
console.log(await agent.balances());
const q = await agent.quoteSwap({ from: "usdg", to: "nvda", amount: "100" });
const r = await agent.execute(q.id);            // { txHash, jobId, explorer, message }
```

## How it works

- **Wallet.** `init` creates an ordinary key pair. It signs the same sign-in message as the Lincoln web app, and the private wallet seed is derived from that signature, so importing the key into a browser wallet opens the same private balance in the app.
- **Spends.** Pool state comes from the relay and is checked against the chain (Merkle root and association-set policy) before use. The proof is generated and verified locally, then the relay submits it. Job IDs are kept, so an interrupted spend is followed, never paid twice.
- **Circuits.** Downloaded once from the Lincoln app, checked against the SHA-256 pins in this package, cached in `~/.lincoln/circuits`.
- **Network.** Pool profiles, swap routes and circuit pins ship with the package; a relay can't redirect funds. Relays, the bridge proxy and circuit files are reached through the Lincoln app's own origin, so third parties don't see the agent's IP.
- **Withdrawals to other chains** (Base, Arbitrum, Ethereum, Optimism, BSC, Solana; ETH arrives as BNB on BSC and SOL on Solana, USDG stays USDG on Ethereum and Solana, USDT on BSC, USDC elsewhere) go through a single-use Relay deposit address (`--receive wbtc|cbbtc|usdc|…` picks another token there); withdrawals to **Zcash, Bitcoin and Tron** go through NEAR Intents. Solana, Zcash, Bitcoin and Tron need `--refund <0x…>`, a Robinhood Chain address used only if the swap fails. Mainnet only.

## Spending policy

`~/.lincoln/policy.json` is checked at quote time and again before every spend:

```json
{ "perTransactionUsd": 250, "dailyUsd": 1000, "approvalAboveUsd": 100, "allowedRecipients": [], "allowedActions": ["send", "swap", "withdraw", "deposit"] }
```

Spends above `approvalAboveUsd`, or of an asset without a USD price, fail with `APPROVAL_REQUIRED` until the user approves (`--approve`, or `userApproved: true` over MCP). **Limits are enforced by this software, not by the contracts**: anyone with the agent's key can spend its whole balance, so keep only what the agent needs in it.

## Rules

Same [Terms](https://docs.lincolnprotocol.com/legal/terms) as the app: no funds linked to crime or sanctions, and not offered in the United States, the United Kingdom or sanctioned regions. The contracts are not independently audited yet.

## Develop

```sh
npm run build    # tsc -b for all three packages
npm test         # vitest
npm run release  # clean build, tests, then publish sdk, cli and mcp to npm (needs npm login)
```

Protocol code in `packages/sdk/src/core` is ported from the Lincoln web app (`sdk.ts`, `relay.ts`, `fees.ts`, `state.ts`, `chain-state.ts`, `caps.ts`, `bridge.ts`) and must stay byte-compatible with it.
