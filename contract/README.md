# Allowance smart contract

JavaScript contract (`near-sdk-js` 2.0.0). Rules live in `src/policy-core.js` (no SDK imports, tested with `npm test`); `src/index.js` is a thin wrapper.

| Who | Methods |
|---|---|
| Agent | `request_payment({to, amount, memo})`: pays, holds, or blocks according to the policy |
| Owner | `approve({id})`, `reject({id})`, `set_policy({policy})`, `set_agent({agent})` |
| Anyone | `get_state()` (view) |

Amounts are yoctoNEAR strings. Defaults: daily limit 0.5 NEAR, per-payment cap 0.2, approval above 0.1.

## Build (Linux or WSL, Node 20)
    npm install
    npm run build        # writes build/allowance.wasm

## Deploy to testnet (near-cli-rs, interactive)
    near create-account YOURNAME-allowance.testnet --useFaucet
    near contract deploy YOURNAME-allowance.testnet
    # use-file -> build/allowance.wasm, with-init-call, function: init, json-args:
    # {"owner":"OWNER.testnet","agent":"AGENT.testnet","allowed":["data.testnet","research.testnet"],"blocked":[]}

`init` takes the owner explicitly and runs in the same transaction as the deploy.
