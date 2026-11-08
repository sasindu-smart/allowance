# Allowance

**Give your AI agent a budget it can't break.**

Allowance lets an AI agent earn and spend money on NEAR, but only inside rules a human wrote. The rules are enforced by a **NEAR smart contract**, so even a fooled or compromised agent (or a modified server) cannot pay what the rules forbid.

Built for NEAR HACKATHON. Tracks: **Autonomous Business**, **AI Security & Defense**, **Agent Economy**.

**Try it:** https://allowance-khm3.onrender.com (public demo, simulated payments, nothing to install; the first load can take up to a minute on the free host). The real on-chain run, with its transactions on NEAR testnet, is in [Proof on NEAR testnet](#proof-on-near-testnet) below.

## The problem

AI agents are starting to earn and spend money. A wallet with no limits is dangerous: one prompt injection or one scam message and the funds are gone. People need a simple way to say "spend freely inside these limits, ask me beyond them, never pay these addresses", and to know the limit really holds.

## What it does

- The agent earns income (selling reports) and spends money (buying data, hiring other agents).
- Every payment is checked against rules: per-payment cap, daily limit, recipient allowlist, blocklist.
- Small safe payments go through by themselves. Larger ones wait for a **human Approve / Reject** (a separate owner account). Scam or unknown recipients are **blocked**.
- A live dashboard shows each decision with its reason and a link to the transaction on the explorer.
- **Kill switch + guardian (v2):** the owner can pause the agent at any time. A separate **guardian** account (pause-only, it can never pay, approve or resume) trips automatically when a message-triggered payment is blocked. Only the owner can resume. In contract mode the pause lives on-chain, so a modified server cannot bypass it.
- **Rate limit and per-recipient caps (v2):** `maxPerHour` and `recipientDailyCaps` are enforced by the contract.
- **Prompt-injection demo:** a message tells the agent to pay a scammer. The agent obeys, and the payment is still blocked. A "compromised agent" button simulates a fully jailbroken model.

## Proof on NEAR testnet

Contract account: **`sasindudev-allowance2.testnet`** (v2, JavaScript, `near-sdk-js`). Roles: agent `sasindudev-agent.testnet`, owner `sasindudev.testnet` (signs in a real wallet), guardian `sasindudev-guardian.testnet` (can only pause).

| What happened | Transaction |
|---|---|
| Contract v2 deployed and initialised | [`5gtASUxJ…qej7`](https://testnet.nearblocks.io/txns/5gtASUxJLvQup1hC9jPQRUy499E1DCYfXR6ikoJuqej7) |
| Agent paid within policy, checked by the contract (`payment_paid`) | [`GzubwSCi…1MUX`](https://testnet.nearblocks.io/txns/GzubwSCiXYPSfZeJVCqx4bs3i7Ab9nBQVNRcHNK11MUX) |
| Agent tried to pay a scam address: refused by the contract (`payment_blocked`) | [`c9zHP1ME…erAE`](https://testnet.nearblocks.io/txns/c9zHP1MEhRRaNJ6xcKPsXMVvgwr35aStvQirpy2erAE) |
| Guardian paused the agent automatically after the blocked, message-triggered payment (`paused`) | [`HhRBDYXc…gwL8`](https://testnet.nearblocks.io/txns/HhRBDYXc4Gu5pGbqXXb9pHVh3yPiMHK1w1N2yPbkgwL8) |
| Owner resumed the agent from their wallet (`unpaused`) | [`CWBeDkEW…7c1z`](https://testnet.nearblocks.io/txns/CWBeDkEWbgP99QjodNkw6YUuz8nu2fkMX2KBnGH27c1z) |
| Large payment held above the approval line, then approved by the owner in their wallet (`payment_approved`) | [`9KGZ98Sf…FM4o`](https://testnet.nearblocks.io/txns/9KGZ98SfMSNbbARDSRmar9j3GX2CJtXNDfiUSai6FM4o) |

You can also read the live rules: `near contract call-function as-read-only sasindudev-allowance2.testnet get_state json-args "{}" network-config testnet now`

(The first version of the contract, `sasindudev-allowance2.testnet`, is still on testnet. Its transactions are in the project history.)

## Run it

Requirements: Node.js 18 or newer. The first mode needs nothing else.

```bash
npm start        # http://localhost:3000 (landing page), /app (dashboard)
npm test         # 90 tests (policy engine, adapters, agent, contract rules)
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
| 10 | After step 8 or 9 | The guardian has **paused** the agent (red banner). **Resume the agent** to continue; **Pause the agent** works any time |

Note: in contract mode the daily-spend counter lives on-chain, so **Reset demo** does not reset it (it resets at UTC midnight). After a few runs you will see "Would exceed the daily limit", which is the on-chain limit working.

## Owner wallet (contract mode)

In `near-contract` mode the dashboard has **Connect wallet**. The owner signs approve, reject, pause and resume in their own NEAR wallet (Meteor, Sender, Nightly, HERE and others, via NEAR Wallet Selector). No key touches this app. After signing, the server looks the transaction up on the NEAR RPC and checks who signed what, on which contract, for which payment, before it updates the dashboard. The owner can also change the limits from the dashboard (**Edit rules**), signed in the wallet and enforced by the contract at once. The **Live on-chain state** card reads the contract's `get_state` directly from the chain. Without a wallet the buttons fall back to server-side signing with a key in your OS keychain.

## Architecture

```
 Agent (LLM or scripted)  ->  Treasury (src/ledger.js or src/near-contract.js)
                                      |
        mock / near-testnet:          |           near-contract:
        policy engine (src/policy.js) |   NEAR smart contract  sasindudev-allowance2.testnet
        then pay                      |   request_payment (agent)  approve / reject (owner)
```

- `contract/src/policy-core.js` all rules, no SDK imports, 16 tests. `contract/src/index.js` is a thin `near-sdk-js` wrapper. Build and deploy steps: `contract/README.md`.
- `src/policy.js` the same rules for the off-chain modes.
- `src/near-contract.js` relays payments to the contract and turns its logged events into dashboard rows.
- `src/agent.js` and `src/llm.js` the agent: a real LLM through an OpenAI-compatible API (NEAR AI Cloud by default, set `LLM_API_KEY`), or a "naive rules" stand-in with no key. Model output is validated before use.
- `public/landing.html` the home page, `public/app.html` the owner dashboard, `public/docs.html` the docs.

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
