import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_POLICY, evaluate } from "../src/policy.js";
import { Treasury } from "../src/ledger.js";
import { mockPayments } from "../src/payments.js";

test("small payment to allowed recipient is allowed", () => {
  const v = evaluate(DEFAULT_POLICY, 0, { to: "data-api.near", amount: 5 });
  assert.equal(v.decision, "allow");
});

test("payment above approval threshold needs a human", () => {
  const v = evaluate(DEFAULT_POLICY, 0, { to: "research-agent.near", amount: 14 });
  assert.equal(v.decision, "needs_approval");
});

test("blocklisted recipient is blocked", () => {
  const v = evaluate(DEFAULT_POLICY, 0, { to: "scam-giveaway.near", amount: 8 });
  assert.equal(v.decision, "block");
});

test("unknown recipient is blocked", () => {
  const v = evaluate(DEFAULT_POLICY, 0, { to: "unknown-wallet.near", amount: 3 });
  assert.equal(v.decision, "block");
});

test("amount over per-tx cap is blocked", () => {
  const v = evaluate(DEFAULT_POLICY, 0, { to: "cloud-gpu.near", amount: 25 });
  assert.equal(v.decision, "block");
});

test("daily limit is enforced", () => {
  const v = evaluate(DEFAULT_POLICY, 48, { to: "data-api.near", amount: 5 });
  assert.equal(v.decision, "block");
});

test("treasury: allowed payment reduces balance and counts toward daily spend", async () => {
  const t = new Treasury(DEFAULT_POLICY, mockPayments);
  const tx = await t.requestPayment({ to: "data-api.near", amount: 5, memo: "x" });
  assert.equal(tx.status, "paid");
  assert.equal(t.balance, 95);
  assert.equal(t.spentToday, 5);
});

test("treasury: blocked payment moves no money", async () => {
  const t = new Treasury(DEFAULT_POLICY, mockPayments);
  const tx = await t.requestPayment({ to: "scam-giveaway.near", amount: 8, memo: "x" });
  assert.equal(tx.status, "blocked");
  assert.equal(t.balance, 100);
});

test("treasury: pending payment pays only after human approval", async () => {
  const t = new Treasury(DEFAULT_POLICY, mockPayments);
  const tx = await t.requestPayment({ to: "research-agent.near", amount: 14, memo: "x" });
  assert.equal(tx.status, "pending");
  assert.equal(t.balance, 100);
  await t.approve(tx.id);
  assert.equal(tx.status, "paid");
  assert.equal(t.balance, 86);
});

test("treasury: rejected payment moves no money", async () => {
  const t = new Treasury(DEFAULT_POLICY, mockPayments);
  const tx = await t.requestPayment({ to: "research-agent.near", amount: 14, memo: "x" });
  t.reject(tx.id);
  assert.equal(tx.status, "rejected");
  assert.equal(t.balance, 100);
});

import { Treasury as T2 } from "../src/ledger.js";
import { mockPayments as MP2 } from "../src/payments.js";
test("kill switch refuses everything until resumed; untrusted blocked payment auto-pauses", async () => {
  const t = new T2(DEFAULT_POLICY, MP2);
  await t.pause();
  const blocked = await t.requestPayment({ to: "data-api.near", amount: 5, memo: "x" });
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.reason, /paused/i);
  await t.resume();
  assert.equal((await t.requestPayment({ to: "data-api.near", amount: 5, memo: "x" })).status, "paid");
  await t.requestPayment({ to: "scam-giveaway.near", amount: 8, memo: "x", untrusted: true });
  assert.equal(t.paused, true);
  assert.equal(t.snapshot().paused, true);
});
