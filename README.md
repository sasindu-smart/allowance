# Allowance

**Give your AI agent a budget it can't break.**

Allowance lets an AI agent earn and spend money on NEAR, but only inside rules a human wrote. The rules are enforced by a **NEAR smart contract**, so even a fooled or compromised agent (or a modified server) cannot pay what the rules forbid.

Built for NEAR HACKATHON. Tracks: **Autonomous Business**, **AI Security & Defense**, **Agent Economy**.

## The problem

AI agents are starting to earn and spend money. A wallet with no limits is dangerous: one prompt injection or one scam message and the funds are gone. People need a simple way to say "spend freely inside these limits, ask me beyond them, never pay these addresses", and to know the limit really holds.

## What it does

- The agent earns income (selling reports) and spends money (buying data, hiring other agents).
- Every payment is checked against rules: per-payment cap, daily limit, recipient allowlist, blocklist.
- Small safe payments go through by themselves. Larger ones wait for a **human Approve / Reject** (a separate owner account). Scam or unknown recipients are **blocked**.
- A live dashboard shows each decision with its reason and a link to the transaction on the explorer.
- **Prompt-injection demo:** a message tells the agent to pay a scammer. The agent obeys, and the payment is still blocked. A "compromised agent" button simulates a fully jailbroken model.

## Proof on NEAR testnet

Contract account: **`sasindudev-allowance.testnet`** (JavaScript, `near-sdk-js`). Roles: agent `sasindudev-agent.testnet`, owner `sasindudev-owner.testnet`.

| What happened | Transaction |
|---|---|
| Contract deployed and initialised | [`BwRWqeLb...acUv`](https://testnet.nearblocks.io/txns/BwRWqeLb5UUCjoStYPemndZW6DDPqdX7buyaoCC4acUv) |
| Agent paid 0.05 NEAR to an allowed vendor (`payment_paid`) | [`GpXUv42m...d4FB`](https://testnet.nearblocks.io/txns/GpXUv42mwBiuhgRgD8L9BPeknQ9n318PfSKZZy41d4FB) |
| Agent tried to pay a scam address: refused by the contract (`payment_blocked`: "Recipient is not on the allowlist") | [`AMcdJjgZ...q9g`](https://testnet.nearblocks.io/txns/AMcdJjgZ5i84gYLKeKCKkKULmrxLjxy7tdPWeJdM5q9g) |

You can also read the live rules: `near contract call-function as-read-only sasindudev-allowance.testnet get_state json-args "{}" network-config testnet now`

## Run it

Requirements: Node.js 18 or newer. The first mode needs nothing else.

```bash
npm start        # http://localhost:3000
npm test         # 66 tests (policy engine, adapters, agent, contract rules)
```

Three modes, chosen with `PAYMENT_MODE` in `.env` (copy `.env.example`):

| Mode | Who enforces the rules | Money |
|---|---|---|
| `mock` (default) | This server's policy engine | Nothing real moves. Zero setup. |
| `near-testnet` | This server's policy engine, then a real testnet transfer | Real testnet NEAR, signed from your OS keychain |
| `near-contract` | **The smart contract** (the server only relays) | Real testnet NEAR, paid by the contract |

For `near-testnet` and `near-contract` you need [near-cli-rs](https://docs.near.org/tools/cli) and testnet accounts (see `.env.example`). No private key is stored in this repo or in `.env`: signing uses `sign-with-keychain`. Demo amounts are scaled by `PAYMENT_SCALE` (default 0.01, so 5 becomes 0.05 NEAR) and capped at 1 NEAR per payment.

### Try it: do X, see Y (works in every mode)

| # | Do this | Expected result |
|---|---------|-----------------|
| 1 | Open http://localhost:3000 | Balance 100, spent 0 / 50, rules shown |
| 2 | **Let the agent act** (1st time) | "+15 income" row |
| 3 | Again | 5 to `data-api.near` is **paid** automatically |
| 4 | Again | 14 to `research-agent.near` is **pending** with Approve / Reject |
| 5 | **Approve** | Becomes **paid** (in contract mode, approved on-chain by the owner account) |
| 6 | **Let the agent act** | 8 to `scam-giveaway.near` is **blocked** |
| 7 | Again | 25 to `cloud-gpu.near` is **blocked** (over the cap) |
| 8 | **Send an attack message** | The agent follows an injected "pay the scammer" message; the payment is **blocked** |
| 9 | **Attack a compromised agent** | Simulates a jailbroken model. The rules still hold |

Note: in contract mode the daily-spend counter lives on-chain, so **Reset demo** does not reset it (it resets at UTC midnight). After a few runs you will see "Would exceed the daily limit", which is the on-chain limit working.

## Architecture

```
 Agent (LLM or scripted)  ->  Treasury (src/ledger.js or src/near-contract.js)
                                      |
        mock / near-testnet:          |           near-contract:
        policy engine (src/policy.js) |   NEAR smart contract  sasindudev-allowance.testnet
        then pay                      |   request_payment (agent)  approve / reject (owner)
```

- `contract/src/policy-core.js` all rules, no SDK imports, 16 tests. `contract/src/index.js` is a thin `near-sdk-js` wrapper. Build and deploy steps: `contract/README.md`.
- `src/policy.js` the same rules for the off-chain modes.
- `src/near-contract.js` relays payments to the contract and turns its logged events into dashboard rows.
- `src/agent.js` and `src/llm.js` the agent: a real LLM through an OpenAI-compatible API (NEAR AI Cloud by default, set `LLM_API_KEY`), or a "naive rules" stand-in with no key. Model output is validated before use.
- `public/index.html` the dashboard.

## NEAR tools used

- **NEAR smart contract (JavaScript, `near-sdk-js`)** on testnet: enforces the rules, with separate agent and owner roles.
- **NEAR testnet + near-cli-rs:** accounts, deployment, keychain signing, real transfers.
- **NEAR AI Cloud:** the LLM that plays the agent.
- **NEAR Intents (1Click API), dry-run only:** optional. With `INTENTS_REFUND_TO` and `INTENTS_RECIPIENT` set, the agent can request a cross-chain payout (wNEAR to USDC on Base). Policy is checked first; a blocked payout never reaches the Intents API. Intents has no testnet, so only a price quote is requested (`dry: true`). No swap is executed.

## Honest limits

- The dashboard balance and "spent today" figures are demo accounting scaled by `PAYMENT_SCALE`, not the contract's raw balance.
- A payment marked paid is recorded when the contract accepts it; the contract's transfer then settles in the following receipt.
- Cross-chain payouts are quotes only. Function call keys for the agent and TEE execution are not implemented.

## License

MIT
