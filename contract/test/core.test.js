import test from "node:test";
import assert from "node:assert/strict";
import {
  NEAR, DAY_NS, defaultPolicy, newState, requestPayment, approve, reject, setPolicy, setAgent, validatePolicy, pause, unpause, setGuardian, HOUR_NS,
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

// ---------- v2: pause / guardian ----------
const GUARD = "guardian.testnet";
const mk2 = (policyChanges = {}) => {
  const p = defaultPolicy();
  p.allowed = [DATA, "research.testnet"];
  p.blocked = [SCAM];
  Object.assign(p, policyChanges);
  return newState(OWNER, AGENT, p, GUARD);
};
const as = (caller, now = 1n * DAY_NS, balance = fund) => ({ caller, now, balance });

test("owner can pause: payments are refused until the owner unpauses", () => {
  const s = mk2();
  pause(s, as(OWNER), "testing");
  const r = requestPayment(s, as(AGENT), { to: DATA, amount: near(0.05) });
  assert.equal(r.result.status, "blocked");
  assert.match(r.result.reason, /paused/);
  assert.equal(r.transfer, null);
  unpause(s, as(OWNER));
  assert.equal(requestPayment(s, as(AGENT), { to: DATA, amount: near(0.05) }).result.status, "paid");
});

test("guardian can pause but can never unpause, approve, reject or change rules", () => {
  const s = mk2();
  const { id } = requestPayment(s, as(AGENT), { to: DATA, amount: near(0.14) }).result;
  pause(s, as(GUARD), "possible prompt injection");
  assert.equal(s.paused, true);
  assert.throws(() => unpause(s, as(GUARD)), /Only the owner/);
  assert.throws(() => approve(s, as(GUARD), id), /Only the owner/);
  assert.throws(() => reject(s, as(GUARD), id), /Only the owner/);
  assert.throws(() => setPolicy(s, as(GUARD), defaultPolicy()), /Only the owner/);
  assert.throws(() => setGuardian(s, as(GUARD), "x.testnet"), /Only the owner/);
});

test("the agent and strangers cannot pause", () => {
  const s = mk2();
  assert.throws(() => pause(s, as(AGENT)), /owner or the guardian/);
  assert.throws(() => pause(s, as("evil.testnet")), /owner or the guardian/);
  assert.equal(s.paused, false);
});

test("a held payment cannot be approved while paused", () => {
  const s = mk2();
  const { id } = requestPayment(s, as(AGENT), { to: DATA, amount: near(0.14) }).result;
  pause(s, as(OWNER));
  assert.throws(() => approve(s, as(OWNER), id), /paused/);
  assert.ok(s.pending[id], "the held payment is kept");
  unpause(s, as(OWNER));
  assert.equal(approve(s, as(OWNER), id).result.status, "paid");
});

test("owner can set or remove the guardian", () => {
  const s = mk2();
  setGuardian(s, as(OWNER), "new-guard.testnet");
  assert.equal(s.guardian, "new-guard.testnet");
  assert.throws(() => pause(s, as(GUARD)), /owner or the guardian/);
  setGuardian(s, as(OWNER), null);
  assert.equal(s.guardian, null);
  assert.throws(() => setGuardian(s, as(OWNER), "BAD NAME"), /Invalid guardian/);
});

// ---------- v2: rate limit ----------
test("rate limit: at most N payments per hour, then it frees up", () => {
  const s = mk2({ maxPerHour: 2 });
  const t0 = 1n * DAY_NS;
  assert.equal(requestPayment(s, as(AGENT, t0), { to: DATA, amount: near(0.01) }).result.status, "paid");
  assert.equal(requestPayment(s, as(AGENT, t0 + 1n), { to: DATA, amount: near(0.01) }).result.status, "paid");
  const third = requestPayment(s, as(AGENT, t0 + 2n), { to: DATA, amount: near(0.01) });
  assert.equal(third.result.status, "blocked");
  assert.match(third.result.reason, /Rate limit/);
  const later = requestPayment(s, as(AGENT, t0 + HOUR_NS + 10n), { to: DATA, amount: near(0.01) });
  assert.equal(later.result.status, "paid");
});

test("rate limit also applies when the owner approves a held payment", () => {
  const s = mk2({ maxPerHour: 1 });
  const { id } = requestPayment(s, as(AGENT), { to: DATA, amount: near(0.14) }).result; // held
  assert.equal(requestPayment(s, as(AGENT, DAY_NS + 1n), { to: DATA, amount: near(0.01) }).result.status, "paid");
  const r = approve(s, as(OWNER, DAY_NS + 2n), id);
  assert.equal(r.result.status, "blocked");
  assert.match(r.result.reason, /Rate limit/);
});

test("maxPerHour 0 means no limit", () => {
  const s = mk2();
  for (let i = 0; i < 6; i++) {
    assert.equal(requestPayment(s, as(AGENT, DAY_NS + BigInt(i)), { to: DATA, amount: near(0.01) }).result.status, "paid");
  }
});

// ---------- v2: per-recipient daily cap ----------
test("per-recipient daily cap blocks one vendor even when the daily limit has room", () => {
  const s = mk2({ recipientDailyCaps: { [DATA]: near(0.12) } });
  assert.equal(requestPayment(s, as(AGENT), { to: DATA, amount: near(0.08) }).result.status, "paid");
  const over = requestPayment(s, as(AGENT), { to: DATA, amount: near(0.08) });
  assert.equal(over.result.status, "blocked");
  assert.match(over.result.reason, /recipient's daily cap/);
  // another vendor is unaffected
  assert.equal(requestPayment(s, as(AGENT), { to: "research.testnet", amount: near(0.08) }).result.status, "paid");
});

test("per-recipient cap resets on a new day", () => {
  const s = mk2({ recipientDailyCaps: { [DATA]: near(0.1) } });
  assert.equal(requestPayment(s, as(AGENT, DAY_NS), { to: DATA, amount: near(0.1) }).result.status, "paid");
  assert.equal(requestPayment(s, as(AGENT, DAY_NS + 5n), { to: DATA, amount: near(0.05) }).result.status, "blocked");
  assert.equal(requestPayment(s, as(AGENT, 2n * DAY_NS), { to: DATA, amount: near(0.05) }).result.status, "paid");
});

test("policy validation covers the new fields", () => {
  const p = defaultPolicy();
  assert.throws(() => validatePolicy({ ...p, maxPerHour: -1 }), /maxPerHour/);
  assert.throws(() => validatePolicy({ ...p, maxPerHour: 1.5 }), /maxPerHour/);
  assert.throws(() => validatePolicy({ ...p, maxPerHour: 5000 }), /maxPerHour/);
  assert.throws(() => validatePolicy({ ...p, recipientDailyCaps: [] }), /recipientDailyCaps/);
  assert.throws(() => validatePolicy({ ...p, recipientDailyCaps: { "BAD NAME": "1" } }), /recipientDailyCaps/);
  assert.throws(() => validatePolicy({ ...p, recipientDailyCaps: { [DATA]: String(NEAR * 5n) } }), /recipientDailyCaps/);
  validatePolicy({ ...p, maxPerHour: 10, recipientDailyCaps: { [DATA]: near(0.1) } });
});
