import test from "node:test";
import assert from "node:assert/strict";
import { ContractTreasury, verifyOwnerTx, yoctoToNear, queryChainState } from "../src/near-contract.js";
import { DEFAULT_POLICY } from "../src/policy.js";

const HASH = "A".repeat(44);
const ev = (event, data = {}) => `EVENT_JSON:${JSON.stringify({ standard: "allowance", version: "1.0.0", event, data })}`;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const txRes = ({ signer = "owner.testnet", receiver = "vault.testnet", method = "approve", args = { id: "7" }, logs = [ev("payment_approved", { id: "7" })], failure = false } = {}) => ({
  result: { transaction: { signer_id: signer, receiver_id: receiver, actions: [{ FunctionCall: { method_name: method, args: b64(args) } }] },
    status: failure ? { Failure: {} } : { SuccessValue: "" }, receipts_outcome: [{ outcome: { logs } }] },
});
const ctx = { owner: "owner.testnet", contractId: "vault.testnet", method: "approve", id: "7" };

test("verifyOwnerTx accepts the owner's real transaction and returns its events", () => {
  assert.equal(verifyOwnerTx(txRes(), ctx)[0].event, "payment_approved");
});

test("verifyOwnerTx rejects wrong signer, contract, method, payment id, failure and missing tx", () => {
  assert.throws(() => verifyOwnerTx(txRes({ signer: "evil.testnet" }), ctx), /not the owner/);
  assert.throws(() => verifyOwnerTx(txRes({ receiver: "other.testnet" }), ctx), /not for this contract/);
  assert.throws(() => verifyOwnerTx(txRes({ method: "reject" }), ctx), /did not call approve/);
  assert.throws(() => verifyOwnerTx(txRes({ args: { id: "8" } }), ctx), /different payment/);
  assert.throws(() => verifyOwnerTx(txRes({ failure: true }), ctx), /failed on chain/);
  assert.throws(() => verifyOwnerTx({ result: null }, ctx), /not found/);
  assert.throws(() => verifyOwnerTx({ error: { data: "boom" } }, ctx), /boom/);
  assert.throws(() => verifyOwnerTx(txRes({ logs: ["plain log"] }), ctx), /no result/);
});

const mk = (responses) => {
  let i = 0; const seen = [];
  const fetchImpl = async (_u, o) => { seen.push(JSON.parse(o.body)); const r = responses[Math.min(i++, responses.length - 1)]; return { ok: true, json: async () => r }; };
  const t = new ContractTreasury({ policy: DEFAULT_POLICY, contractId: "vault.testnet", agent: "agent.testnet", owner: "owner.testnet", fetchImpl, run: async () => "" });
  return { t, seen };
};
const pend = (t) => t.log({ type: "payment", to: "research-agent.near", amount: 14, memo: "x", status: "pending", contractId: "7" });

test("syncOwnerAction approve: verifies on-chain, then marks the payment paid; replay is refused", async () => {
  const { t, seen } = mk([txRes()]); const p = pend(t);
  const out = await t.syncOwnerAction({ action: "approve", id: p.id, txHash: HASH });
  assert.equal(out.status, "paid"); assert.equal(out.txHash, HASH);
  assert.equal(seen[0].method, "EXPERIMENTAL_tx_status"); assert.equal(seen[0].params.sender_account_id, "owner.testnet");
  await assert.rejects(() => t.syncOwnerAction({ action: "approve", id: p.id, txHash: HASH }), /already recorded/);
});

test("syncOwnerAction waits for a transaction that is not indexed yet", async () => {
  const { t, seen } = mk([{ error: { data: "UNKNOWN_TRANSACTION" } }, txRes()]); const p = pend(t);
  const out = await t.syncOwnerAction({ action: "approve", id: p.id, txHash: HASH, sleepMs: 1 });
  assert.equal(out.status, "paid"); assert.equal(seen.length, 2);
});

test("syncOwnerAction refuses forged input: bad hash, unknown payment, another account's transaction", async () => {
  const { t } = mk([txRes({ signer: "evil.testnet" })]); const p = pend(t);
  await assert.rejects(() => t.syncOwnerAction({ action: "approve", id: p.id, txHash: "x" }), /Invalid transaction hash/);
  await assert.rejects(() => t.syncOwnerAction({ action: "approve", id: 999, txHash: HASH }), /No pending payment/);
  await assert.rejects(() => t.syncOwnerAction({ action: "approve", id: p.id, txHash: HASH }), /not the owner/);
  assert.equal(t.txs.find((x) => x.id === p.id).status, "pending");
  await assert.rejects(() => t.syncOwnerAction({ action: "withdraw", txHash: HASH }), /Unknown action/);
});

test("syncOwnerAction pause and unpause update the kill switch and log it", async () => {
  const a = mk([txRes({ method: "pause", args: { reason: "x" }, logs: [ev("paused", { by: "owner.testnet" })] })]);
  const e1 = await a.t.syncOwnerAction({ action: "pause", txHash: HASH });
  assert.equal(e1.status, "paused"); assert.equal(a.t.paused, true);
  const b = mk([txRes({ method: "unpause", args: {}, logs: [ev("unpaused")] })]); b.t.paused = true;
  const e2 = await b.t.syncOwnerAction({ action: "unpause", txHash: "B".repeat(44) });
  assert.equal(e2.status, "resumed"); assert.equal(b.t.paused, false);
});

test("queryChainState turns get_state into plain numbers", async () => {
  const st = { owner: "owner.testnet", agent: "agent.testnet", guardian: "g.testnet", paused: true, spentToday: "50000000000000000000000", pending: { 1: {} },
    policy: { perTxCap: "200000000000000000000000", dailyLimit: "500000000000000000000000", approvalThreshold: "100000000000000000000000", allowed: ["a.testnet"], blocked: [], maxPerHour: 10 } };
  const fetchImpl = async () => ({ ok: true, json: async () => ({ result: { result: [...Buffer.from(JSON.stringify(st))] } }) });
  const c = await queryChainState({ contractId: "vault.testnet", fetchImpl });
  assert.equal(c.paused, true); assert.equal(c.spentToday, 0.05); assert.equal(c.policy.dailyLimit, 0.5); assert.equal(c.pending, 1);
  assert.equal(yoctoToNear("garbage"), 0);
});

test("syncOwnerAction set_policy: verifies the owner's tx, then shows the contract's new limits in demo units", async () => {
  const policy = { dailyLimit: "1000000000000000000000000", perTxCap: "300000000000000000000000", approvalThreshold: "100000000000000000000000", allowed: ["real-data.testnet"], blocked: [], maxPerHour: 20 };
  const res = txRes({ method: "set_policy", args: { policy }, logs: [ev("policy_updated", { policy })] });
  const { t } = mk([res]);
  t.recipientMap = { "data-api.near": "real-data.testnet" };
  const out = await t.syncOwnerAction({ action: "set_policy", txHash: HASH });
  assert.equal(out.status, "updated");
  assert.equal(t.policy.dailyLimit, 100); assert.equal(t.policy.perTxCap, 30); assert.equal(t.policy.approvalThreshold, 10);
  assert.deepEqual(t.policy.allowedRecipients, ["data-api.near"]); assert.equal(t.policy.maxPerHour, 20);
});
