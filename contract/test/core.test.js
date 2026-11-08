import test from "node:test";
import assert from "node:assert/strict";
import {
  NEAR, DAY_NS, defaultPolicy, newState, requestPayment, approve, reject, setPolicy, setAgent, validatePolicy,
} from "../src/policy-core.js";

const OWNER = "owner.testnet";
const AGENT = "agent.testnet";
const DATA = "data-api.testnet";
const SCAM = "scam.testnet";
const fund = 10n * NEAR;

const mk = () => {
  const p = defaultPolicy();
  p.allowed = [DATA, "research.testnet"];
  p.blocked = [SCAM];
  return newState(OWNER, AGENT, p);
};
const agent = (now = 1n * DAY_NS, balance = fund) => ({ caller: AGENT, now, balance });
const owner = (now = 1n * DAY_NS, balance = fund) => ({ caller: OWNER, now, balance });
const near = (n) => String(BigInt(Math.round(n * 1000)) * (NEAR / 1000n)); // 3-decimal NEAR -> yocto

test("small payment to an allowed recipient pays by itself and counts toward the day", () => {
  const s = mk();
  const r = requestPayment(s, agent(), { to: DATA, amount: near(0.05), memo: "data" });
  assert.equal(r.result.status, "paid");
  assert.deepEqual(r.transfer, { to: DATA, amount: BigInt(near(0.05)) });
  assert.equal(s.spentToday, near(0.05));
  assert.match(r.logs[0], /^EVENT_JSON:/);
});

test("payment above the approval threshold is held, no transfer", () => {
  const s = mk();
  const r = requestPayment(s, agent(), { to: DATA, amount: near(0.14) });
  assert.equal(r.result.status, "pending");
  assert.equal(r.transfer, null);
  assert.equal(s.spentToday, "0");
  assert.ok(s.pending[r.result.id]);
});

test("blocklisted recipient is blocked", () => {
  const r = requestPayment(mk(), agent(), { to: SCAM, amount: near(0.05) });
  assert.equal(r.result.status, "blocked");
  assert.equal(r.transfer, null);
});

test("unknown recipient is blocked", () => {
  const r = requestPayment(mk(), agent(), { to: "stranger.testnet", amount: near(0.05) });
  assert.equal(r.result.status, "blocked");
  assert.match(r.result.reason, /allowlist/);
});

test("amount over the per-payment cap is blocked", () => {
  const r = requestPayment(mk(), agent(), { to: DATA, amount: near(0.25) });
  assert.equal(r.result.status, "blocked");
  assert.match(r.result.reason, /cap/);
});

test("daily limit is enforced and resets the next day", () => {
  const s = mk();
  for (let i = 0; i < 5; i++) {
    assert.equal(requestPayment(s, agent(), { to: DATA, amount: near(0.1) }).result.status, "paid");
  }
  const over = requestPayment(s, agent(), { to: DATA, amount: near(0.05) });
  assert.equal(over.result.status, "blocked");
  assert.match(over.result.reason, /daily/);
  const nextDay = requestPayment(s, agent(2n * DAY_NS), { to: DATA, amount: near(0.05) });
  assert.equal(nextDay.result.status, "paid");
});

test("invalid amounts and recipients are blocked, not crashed", () => {
  const s = mk();
  for (const amount of ["0", "-5", "abc", "1.5", "", undefined, 5]) {
    assert.equal(requestPayment(s, agent(), { to: DATA, amount }).result.status, "blocked");
  }
  assert.equal(requestPayment(s, agent(), { to: "Bad Account!", amount: "1" }).result.status, "blocked");
});

test("only the agent can request payments", () => {
  assert.throws(() => requestPayment(mk(), owner(), { to: DATA, amount: near(0.05) }), /Only the agent/);
  assert.throws(() => requestPayment(mk(), { caller: "evil.testnet", now: DAY_NS, balance: fund }, { to: DATA, amount: "1" }), /Only the agent/);
});

test("insufficient balance blocks an otherwise allowed payment", () => {
  const r = requestPayment(mk(), agent(1n * DAY_NS, 1n), { to: DATA, amount: near(0.05) });
  assert.equal(r.result.status, "blocked");
  assert.equal(r.result.reason, "Insufficient balance");
});

test("owner approves a held payment: it pays and the pending entry is gone", () => {
  const s = mk();
  const { id } = requestPayment(s, agent(), { to: DATA, amount: near(0.14) }).result;
  const r = approve(s, owner(), id);
  assert.equal(r.result.status, "paid");
  assert.deepEqual(r.transfer, { to: DATA, amount: BigInt(near(0.14)) });
  assert.equal(s.pending[id], undefined);
  assert.equal(s.spentToday, near(0.14));
});

test("approval re-checks the rules: a recipient blocklisted after the request is not paid", () => {
  const s = mk();
  const { id } = requestPayment(s, agent(), { to: DATA, amount: near(0.14) }).result;
  const p = { ...s.policy, blocked: [SCAM, DATA] };
  setPolicy(s, owner(), p);
  const r = approve(s, owner(), id);
  assert.equal(r.result.status, "blocked");
  assert.equal(r.transfer, null);
});

test("owner rejects a held payment: nothing moves", () => {
  const s = mk();
  const { id } = requestPayment(s, agent(), { to: DATA, amount: near(0.14) }).result;
  const r = reject(s, owner(), id);
  assert.equal(r.result.status, "rejected");
  assert.equal(r.transfer, null);
  assert.equal(s.pending[id], undefined);
});

test("the agent cannot approve its own held payment or change the rules", () => {
  const s = mk();
  const { id } = requestPayment(s, agent(), { to: DATA, amount: near(0.14) }).result;
  assert.throws(() => approve(s, agent(), id), /Only the owner/);
  assert.throws(() => reject(s, agent(), id), /Only the owner/);
  assert.throws(() => setPolicy(s, agent(), defaultPolicy()), /Only the owner/);
  assert.throws(() => setAgent(s, agent(), "other.testnet"), /Only the owner/);
});

test("approving an unknown id fails", () => {
  assert.throws(() => approve(mk(), owner(), 99), /No pending/);
});

test("policy validation rejects inconsistent limits and bad accounts", () => {
  const p = defaultPolicy();
  assert.throws(() => validatePolicy({ ...p, perTxCap: String(NEAR * 5n) }), /perTxCap/);
  assert.throws(() => validatePolicy({ ...p, approvalThreshold: String(NEAR) }), /approvalThreshold/);
  assert.throws(() => validatePolicy({ ...p, allowed: ["NOT VALID"] }), /allowed/);
  assert.throws(() => validatePolicy({ ...p, dailyLimit: "1e24" }), /dailyLimit/);
});

test("owner can change the agent, and the old agent loses access", () => {
  const s = mk();
  setAgent(s, owner(), "new-agent.testnet");
  assert.throws(() => requestPayment(s, agent(), { to: DATA, amount: near(0.05) }), /Only the agent/);
  const r = requestPayment(s, { caller: "new-agent.testnet", now: DAY_NS, balance: fund }, { to: DATA, amount: near(0.05) });
  assert.equal(r.result.status, "paid");
});
