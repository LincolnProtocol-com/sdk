# Lincoln SDK, CLI and MCP server

Give an AI agent (or any program) its own private balance on Robinhood Chain. Hold ETH, dollars and tokenized stocks in the [Lincoln](https://lincolnprotocol.com) privacy pool; send, swap and withdraw with zero-knowledge proofs generated on your machine and submitted by a relayer, so the agent's wallet never appears on chain.

> **Status:** pre-release. Lincoln runs on Robinhood Chain mainnet (chain 4663): nine pools (ETH, USDG, seven stock tokens). Private spending opens when the mainnet relay is live; packages are not published to npm yet.

| Package | What it is |
| --- | --- |
| [`@lincolnprotocol/sdk`](packages/sdk) | TypeScript library for Node 20+ |
| [`@lincolnprotocol/cli`](packages/cli) | `lincoln` command, with `--json` for agents |
| [`@lincolnprotocol/mcp`](packages/mcp) | MCP server for Claude, Codex, Cursor and other MCP clients |
| [`skills/lincoln`](skills/lincoln/SKILL.md) | Agent skill: how to use the tools safely |

## Quick start (from source)

```sh
npm install && npm run build
node packages/cli/dist/index.js init          # creates ~/.lincoln/mainnet/agent.json and ~/.lincoln/policy.json
node packages/cli/dist/index.js address       # share the lincoln3: address to fund it privately
node packages/cli/dist/index.js balance
node packages/cli/dist/index.js quote swap 100 usdg nvda
node packages/cli/dist/index.js execute q_…
```

Set `LINCOLN_PASSPHRASE` before `init` to encrypt the agent key (scrypt + AES-GCM); it is then needed to open the wallet.

## MCP

```json
{
  "mcpServers": {
    "lincoln": {
      "command": "node",
      "args": ["/path/to/lincoln-sdk/packages/mcp/dist/index.js"],
      "env": { "LINCOLN_HOME": "~/.lincoln", "LINCOLN_NETWORK": "mainnet" }
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
- **Withdrawals to other chains** (Base, Arbitrum, Ethereum, Optimism, BSC, Solana; ETH arrives as BNB on BSC and SOL on Solana, USDG stays USDG on Ethereum and Solana, USDT on BSC, USDC elsewhere) go through a single-use Relay deposit address; withdrawals to **Zcash, Bitcoin and Tron** go through NEAR Intents. Solana, Zcash, Bitcoin and Tron need `--refund <0x…>`, a Robinhood Chain address used only if the swap fails. Mainnet only.

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
```

Protocol code in `packages/sdk/src/core` is ported from the Lincoln web app (`sdk.ts`, `relay.ts`, `fees.ts`, `state.ts`, `chain-state.ts`, `caps.ts`, `bridge.ts`) and must stay byte-compatible with it.
