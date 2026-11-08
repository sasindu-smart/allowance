import { execFile } from "node:child_process";

// Treasury backed by the Allowance SMART CONTRACT on NEAR testnet.
//
// Here the rules are NOT checked by this server. Every payment is sent to the contract's
// `request_payment` method (signed by the agent's key) and the CONTRACT decides: pay, hold for
// the owner, or block. This file only translates the contract's logged events into ledger rows.
// Even if this server were modified, it could not make the contract pay what its rules forbid.
//
// Signing happens inside near-cli-rs with keys in your OS keychain; no key is read here.

const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const okAccount = (a) => typeof a === "string" && a.length >= 2 && a.length <= 64 && ACCOUNT_RE.test(a);

// 0.05 -> "50000000000000000000000" (yoctoNEAR). Rounds to 6 decimals first.
export function toYocto(nearAmount) {
  if (typeof nearAmount !== "number" || !Number.isFinite(nearAmount) || nearAmount <= 0) throw new Error("Invalid amount");
  if (nearAmount > 1) throw new Error("On-chain amount out of safe range (max 1 NEAR in testnet mode)");
  const micro = BigInt(Math.round(nearAmount * 1e6));
  if (micro <= 0n) throw new Error("Amount is too small");
  return String(micro * 10n ** 18n);
}

// Pure + testable: argument list for `near contract call-function as-transaction ...`
export function buildCallArgs({ contractId, method, args, signer }) {
  if (!okAccount(contractId)) throw new Error("Invalid contract account");
  if (!okAccount(signer)) throw new Error("Invalid signer account");
  if (!/^[a-z_]+$/.test(method)) throw new Error("Invalid method name");
  return [
    "contract", "call-function", "as-transaction", contractId, method,
    "json-args", JSON.stringify(args),
    "prepaid-gas", "30 Tgas", "attached-deposit", "0 NEAR",
    "sign-as", signer, "network-config", "testnet", "sign-with-keychain", "send",
  ];
}

// Windows runs `near` through a shell (npm .cmd shim): quote anything with spaces or quotes.
export function quoteArgsForWindows(args) {
  return args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a));
}

// Pull the contract's EVENT_JSON log lines and the transaction id out of the CLI output.
export function parseCliOutput(out) {
  const events = [];
  for (const m of out.matchAll(/EVENT_JSON:(\{.*\})/g)) {
    try {
      const e = JSON.parse(m[1]);
      if (e?.standard === "allowance") events.push({ event: e.event, data: e.data });
    } catch {}
  }
  const tx = out.match(/Transaction ID:\s*([A-Za-z0-9]+)/);
  return { events, txHash: tx ? tx[1] : null };
}

function runNear(args) {
  const useShell = process.platform === "win32";
  const cmdArgs = useShell ? quoteArgsForWindows(args) : args;
  return new Promise((resolve, reject) => {
    execFile("near", cmdArgs, { shell: useShell, timeout: 120000 }, (err, stdout, stderr) => {
      const out = String(stdout) + String(stderr);
      if (err) return reject(new Error(out.replace(/\s+/g, " ").slice(0, 300) || err.message));
      resolve(out);
    });
  });
}

export class ContractTreasury {
  constructor({ policy, contractId, agent, owner, recipientMap = {}, scale = 0.01, run = runNear }) {
    if (!okAccount(contractId)) throw new Error("CONTRACT_ID is not set (see .env.example)");
    if (!okAccount(agent)) throw new Error("NEAR_ACCOUNT_ID (the agent account) is not set");
    if (!okAccount(owner)) throw new Error("OWNER_ACCOUNT_ID is not set");
    Object.assign(this, { policy, contractId, agent, owner, recipientMap, scale, run });
    this.payments = { name: "near-contract", account: contractId };
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

  async callContract(method, args, signer) {
    const out = await this.run(buildCallArgs({ contractId: this.contractId, method, args, signer }));
    const parsed = parseCliOutput(out);
    if (!parsed.events.length) throw new Error("The contract returned no result");
    return parsed;
  }

  async requestPayment({ to, amount, memo }) {
    const base = { type: "payment", to, amount, memo };
    let r;
    try {
      const real = this.recipientMap[to] || to;
      r = await this.callContract("request_payment", { to: real, amount: toYocto(amount * this.scale), memo }, this.agent);
    } catch (e) {
      return this.log({ ...base, status: "failed", reason: "On-chain call failed: " + e.message });
    }
    const ev = r.events[0];
    if (ev.event === "payment_paid") {
      this.balance -= amount;
      this.spentToday += amount;
      return this.log({ ...base, status: "paid", reason: "Within policy (checked by the smart contract)", txHash: r.txHash });
    }
    if (ev.event === "payment_held") {
      return this.log({ ...base, status: "pending", reason: "Above the approval threshold: the contract is holding it for the owner", contractId: ev.data.id, txHash: r.txHash });
    }
    return this.log({ ...base, status: "blocked", reason: `${ev.data?.reason || "Blocked"} (enforced by the smart contract)`, txHash: r.txHash });
  }

  async approve(id) {
    const tx = this.txs.find((t) => t.id === id && t.status === "pending");
    if (!tx) return null;
    let r;
    try {
      r = await this.callContract("approve", { id: tx.contractId }, this.owner);
    } catch (e) {
      tx.status = "failed";
      tx.reason = "On-chain approval failed: " + e.message;
      return tx;
    }
    const ev = r.events[0];
    tx.txHash = r.txHash || tx.txHash;
    if (ev.event === "payment_approved") {
      this.balance -= tx.amount;
      this.spentToday += tx.amount;
      tx.status = "paid";
      tx.reason = "Approved by the owner (executed by the smart contract)";
    } else {
      tx.status = "blocked";
      tx.reason = `${ev.data?.reason || "Blocked"} (re-checked by the smart contract)`;
    }
    return tx;
  }

  async reject(id) {
    const tx = this.txs.find((t) => t.id === id && t.status === "pending");
    if (!tx) return null;
    try {
      await this.callContract("reject", { id: tx.contractId }, this.owner);
    } catch (e) {
      tx.status = "failed";
      tx.reason = "On-chain rejection failed: " + e.message;
      return tx;
    }
    tx.status = "rejected";
    tx.reason = "Rejected by the owner";
    return tx;
  }

  snapshot() {
    return {
      balance: this.balance,
      spentToday: this.spentToday,
      policy: this.policy,
      txs: this.txs,
      mode: "near-contract",
      account: this.contractId,
    };
  }
}
