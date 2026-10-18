# Lincoln for agents

This repo gives an agent a private balance on Robinhood Chain (chain 4663) through the Lincoln privacy pool. If a user asked you to set Lincoln up, do this:

1. Ask the user to choose a passphrase and set it as `LINCOLN_PASSPHRASE` themselves. Never invent it, print it or store it in a file.
2. `npx @lincolnprotocol/cli init` creates `~/.lincoln/mainnet/agent.json` and `~/.lincoln/policy.json`. Show the user the policy and ask whether the limits suit them.
3. `npx @lincolnprotocol/cli address` prints the agent's `lincoln3:` address. Ask the user to fund it with **Send privately** in the Lincoln app (https://app.lincolnprotocol.com).
4. Use the CLI with `--json`, or the MCP server (`npx -y @lincolnprotocol/mcp`), and follow [skills/lincoln/SKILL.md](skills/lincoln/SKILL.md): quote first, stay inside the policy, ask before withdrawals to new addresses, never reveal the key.

To answer questions about Lincoln without a wallet (pools, deposit limits, fees, relay status, docs), use the hosted read-only MCP server at https://mcp.lincolnprotocol.com/mcp.

Refuse to move funds linked to crime or sanctions, or to hide where money came from. Lincoln is not offered in the United States, the United Kingdom or sanctioned regions. Terms: https://docs.lincolnprotocol.com/legal/terms

Working on this repo's code: `npm install && npm run build && npm test`. `packages/sdk/src/core` is ported from the Lincoln web app and must stay byte-compatible with it.
