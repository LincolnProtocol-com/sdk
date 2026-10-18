# @lincolnprotocol/cli

`lincoln`: a private balance on Robinhood Chain from the command line, for people and AI agents. Built on [Lincoln](https://lincolnprotocol.com), a privacy pool for ETH, dollars and tokenized stocks.

```sh
npm i -g @lincolnprotocol/cli
export LINCOLN_PASSPHRASE='…'   # encrypts the agent key; required on mainnet
lincoln init                     # creates ~/.lincoln/mainnet/agent.json and ~/.lincoln/policy.json
lincoln address                  # lincoln3:… address to fund privately from the Lincoln app
lincoln balance --json
lincoln quote swap 100 usdg nvda --json
lincoln execute q_…
lincoln withdraw 0.1 eth 0xabc… --to base
```

Every spend is quote → confirm → execute, checked against `~/.lincoln/policy.json`. `--json` prints machine-readable output for agents.

Docs: https://docs.lincolnprotocol.com/developers/agents · Source: https://github.com/LincolnProtocol-com/sdk · Terms: https://docs.lincolnprotocol.com/legal/terms
