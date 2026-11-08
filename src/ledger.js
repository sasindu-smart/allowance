import { evaluate } from "./policy.js";

// The treasury holds money + history. Every payment MUST go through requestPayment,
// which asks the policy engine first. The agent has no other way to spend.
export class Treasury {
  constructor(policy, payments) {
    this.policy = policy;
    this.payments = payments;
    this.reset();
  }

  reset() {
    this.balance = 100;
    this.spentToday = 0;
    this.txs = [];
    this.nextId = 1;
  }

  log(entry) {
    const e = { id: this.nextId++, time: new Date().toISOString(), ...entry };
    this.txs.unshift(e);
    return e;
  }

  income(from, amount, memo) {
    this.balance += amount;
    return this.log({ type: "income", from, amount, memo, status: "received" });
  }

  async requestPayment({ to, amount, memo }) {
    const verdict = evaluate(this.policy, this.spentToday, { to, amount });
    if (verdict.decision === "allow" && amount > this.balance)
      return this.log({ type: "payment", to, amount, memo, status: "blocked", reason: "Insufficient balance" });
    if (verdict.decision === "block")
      return this.log({ type: "payment", to, amount, memo, status: "blocked", reason: verdict.reason });
    if (verdict.decision === "needs_approval")
      return this.log({ type: "payment", to, amount, memo, status: "pending", reason: verdict.reason });
    return this.execute({ to, amount, memo, reason: verdict.reason });
  }

  async execute({ to, amount, memo, reason }) {
    let res;
    try {
      res = await this.payments.pay({ to, amount });
    } catch (e) {
      return this.log({ type: "payment", to, amount, memo, status: "failed", reason: "Payment error: " + e.message });
    }
    this.balance -= amount;
    this.spentToday += amount;
    return this.log({ type: "payment", to, amount, memo, status: "paid", reason, txHash: res.txHash });
  }

  async approve(id) {
    const tx = this.txs.find((t) => t.id === id && t.status === "pending");
    if (!tx) return null;
    // Re-check policy at approval time (limits may have been used up meanwhile).
    const verdict = evaluate(this.policy, this.spentToday, tx);
    if (verdict.decision === "block" || tx.amount > this.balance) {
      tx.status = "blocked";
      tx.reason = verdict.decision === "block" ? verdict.reason : "Insufficient balance";
      return tx;
    }
    let res;
    try {
      res = await this.payments.pay(tx);
    } catch (e) {
      tx.status = "failed";
      tx.reason = "Payment error: " + e.message;
      return tx;
    }
    this.balance -= tx.amount;
    this.spentToday += tx.amount;
    tx.status = "paid";
    tx.reason = "Approved by human";
    tx.txHash = res.txHash;
    return tx;
  }

  reject(id) {
    const tx = this.txs.find((t) => t.id === id && t.status === "pending");
    if (!tx) return null;
    tx.status = "rejected";
    tx.reason = "Rejected by human";
    return tx;
  }

  snapshot() {
    return {
      balance: this.balance,
      spentToday: this.spentToday,
      policy: this.policy,
      txs: this.txs,
      mode: this.payments.name,
      account: this.payments.account || null,
    };
  }
}
