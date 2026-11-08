// Policy engine for the Allowance contract.
//
// This file has NO NEAR SDK imports on purpose: all the rules live here, so they can be
// tested with plain `node --test` (see ../test/core.test.js). The contract file is a thin
// wrapper that loads state, calls these functions, and performs the returned transfer.
//
// Amounts are yoctoNEAR (1 NEAR = 10^24) and are kept as decimal strings in state.

export const NEAR = 10n ** 24n;
export const DAY_NS = 86_400_000_000_000n;

// Same shape as the demo server's policy, scaled to real testnet amounts
// (demo 50 / 20 / 10 NEAR  ->  0.5 / 0.2 / 0.1 NEAR with PAYMENT_SCALE=0.01).
export function defaultPolicy() {
  return {
    dailyLimit: String(NEAR / 2n),
    perTxCap: String(NEAR / 5n),
    approvalThreshold: String(NEAR / 10n),
    allowed: [],
    blocked: [],
  };
}

export function newState(owner, agent, policy = defaultPolicy()) {
  validatePolicy(policy);
  return { owner, agent, policy, day: "0", spentToday: "0", pending: {}, nextId: 1 };
}

const isAmount = (s) => typeof s === "string" && /^\d{1,40}$/.test(s);
const isAccount = (s) =>
  typeof s === "string" && s.length >= 2 && s.length <= 64 &&
  /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(s);

export function validatePolicy(p) {
  if (!p || typeof p !== "object") throw new Error("Policy must be an object");
  for (const k of ["dailyLimit", "perTxCap", "approvalThreshold"]) {
    if (!isAmount(p[k])) throw new Error(`${k} must be a whole number of yoctoNEAR (string)`);
  }
  const daily = BigInt(p.dailyLimit), cap = BigInt(p.perTxCap), appr = BigInt(p.approvalThreshold);
  if (cap > daily) throw new Error("perTxCap cannot be larger than dailyLimit");
  if (appr > cap) throw new Error("approvalThreshold cannot be larger than perTxCap");
  for (const k of ["allowed", "blocked"]) {
    if (!Array.isArray(p[k]) || p[k].length > 50 || !p[k].every(isAccount)) {
      throw new Error(`${k} must be a list of at most 50 valid account ids`);
    }
  }
}

function event(name, data) {
  return "EVENT_JSON:" + JSON.stringify({ standard: "allowance", version: "1.0.0", event: name, data });
}

function onlyOwner(state, ctx) {
  if (ctx.caller !== state.owner) throw new Error("Only the owner can do this");
}

// Start a new day's spending counter when the calendar day (UTC) changes.
export function rollover(state, now) {
  const day = String(now / DAY_NS);
  if (state.day !== day) {
    state.day = day;
    state.spentToday = "0";
  }
}

// Pure decision. Returns { decision: "allow" | "needs_approval" | "block", reason }.
export function decide(policy, spentToday, to, amount) {
  if (amount <= 0n) return { decision: "block", reason: "Amount must be greater than zero" };
  if (policy.blocked.includes(to)) return { decision: "block", reason: "Recipient is on the blocklist" };
  if (!policy.allowed.includes(to)) return { decision: "block", reason: "Recipient is not on the allowlist" };
  if (amount > BigInt(policy.perTxCap)) return { decision: "block", reason: "Amount exceeds the per-payment cap" };
  if (BigInt(spentToday) + amount > BigInt(policy.dailyLimit)) return { decision: "block", reason: "Would exceed the daily limit" };
  if (amount > BigInt(policy.approvalThreshold)) return { decision: "needs_approval", reason: "Above the approval threshold: owner approval required" };
  return { decision: "allow", reason: "Within policy" };
}

// ctx = { caller, now (ns, bigint), balance (spendable yoctoNEAR, bigint) }
// Returns { result, transfer, logs } where transfer is null or { to, amount (bigint) }.
export function requestPayment(state, ctx, req) {
  if (ctx.caller !== state.agent) throw new Error("Only the agent can request payments");
  rollover(state, ctx.now);

  const memo = String(req?.memo ?? "").slice(0, 200);
  const to = req?.to;
  if (!isAccount(to)) return refuse(state, "Invalid recipient account", req?.to, req?.amount);
  if (!isAmount(req?.amount)) return refuse(state, "Invalid amount", to, req?.amount);

  const amount = BigInt(req.amount);
  const verdict = decide(state.policy, state.spentToday, to, amount);

  if (verdict.decision === "block") return refuse(state, verdict.reason, to, req.amount);

  if (verdict.decision === "needs_approval") {
    const id = state.nextId++;
    state.pending[id] = { to, amount: req.amount, memo };
    return {
      result: { status: "pending", id, reason: verdict.reason },
      transfer: null,
      logs: [event("payment_held", { id, to, amount: req.amount, memo })],
    };
  }

  if (amount > ctx.balance) return refuse(state, "Insufficient balance", to, req.amount);
  state.spentToday = String(BigInt(state.spentToday) + amount);
  return {
    result: { status: "paid", reason: verdict.reason },
    transfer: { to, amount },
    logs: [event("payment_paid", { to, amount: req.amount, memo })],
  };
}

function refuse(state, reason, to, amount) {
  return {
    result: { status: "blocked", reason },
    transfer: null,
    logs: [event("payment_blocked", { to: String(to ?? ""), amount: String(amount ?? ""), reason })],
  };
}

export function approve(state, ctx, id) {
  onlyOwner(state, ctx);
  const p = state.pending[id];
  if (!p) throw new Error("No pending payment with that id");
  rollover(state, ctx.now);
  delete state.pending[id];

  const amount = BigInt(p.amount);
  // Limits are checked again: the rules or the day's spending may have changed since the request.
  const verdict = decide(state.policy, state.spentToday, p.to, amount);
  if (verdict.decision === "block") {
    return { result: { status: "blocked", reason: verdict.reason }, transfer: null,
      logs: [event("payment_blocked", { id, to: p.to, amount: p.amount, reason: verdict.reason })] };
  }
  if (amount > ctx.balance) {
    return { result: { status: "blocked", reason: "Insufficient balance" }, transfer: null,
      logs: [event("payment_blocked", { id, to: p.to, amount: p.amount, reason: "Insufficient balance" })] };
  }
  state.spentToday = String(BigInt(state.spentToday) + amount);
  return {
    result: { status: "paid", reason: "Approved by owner" },
    transfer: { to: p.to, amount },
    logs: [event("payment_approved", { id, to: p.to, amount: p.amount })],
  };
}

export function reject(state, ctx, id) {
  onlyOwner(state, ctx);
  const p = state.pending[id];
  if (!p) throw new Error("No pending payment with that id");
  delete state.pending[id];
  return { result: { status: "rejected" }, transfer: null,
    logs: [event("payment_rejected", { id, to: p.to, amount: p.amount })] };
}

export function setPolicy(state, ctx, policy) {
  onlyOwner(state, ctx);
  validatePolicy(policy);
  state.policy = policy;
  return { logs: [event("policy_updated", { policy })] };
}

export function setAgent(state, ctx, agent) {
  onlyOwner(state, ctx);
  if (!isAccount(agent)) throw new Error("Invalid agent account");
  state.agent = agent;
  return { logs: [event("agent_changed", { agent })] };
}
