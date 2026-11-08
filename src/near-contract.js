import { execFile } from "node:child_process";
import { Treasury } from "./ledger.js";

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

// Pull the useful part out of near-cli output. The CLI first echoes the unsigned transaction,
// so the real reason is usually near the end; keep that, not the echo.
export function summarizeCliError(out) {
  const flat = String(out).replace(/[├│└─┌]+/g, " ").replace(/\s+/g, " ").trim();
  const m = flat.match(/(Smart contract panicked[^]*|ExecutionError[^]*|Error:[^]*|[Ee]rror[^]*|[Ff]ailure[^]*)/);
  const pick = m ? m[1] : flat;
  return pick.length > 300 ? pick.slice(0, 300) + "..." : pick;
}

function runNear(args) {
  const useShell = process.platform === "win32";
  const cmdArgs = useShell ? quoteArgsForWindows(args) : args;
  return new Promise((resolve, reject) => {
    execFile("near", cmdArgs, { shell: useShell, timeout: 120000 }, (err, stdout, stderr) => {
      const out = String(stdout) + String(stderr);
      if (err) {
        console.error("[near-cli failed]", out.trim().slice(-1500) || err.message);
        return reject(new Error(summarizeCliError(out) || err.message));
      }
      resolve(out);
    });
  });
}


export const DEFAULT_RPC = "https://rpc.testnet.near.org";
const b64json = (b) => JSON.parse(Buffer.from(b, "base64").toString("utf8"));

// "50000000000000000000000" -> 0.05 (rounded to 4 decimals). For display only.
export function yoctoToNear(y) {
  try { return Number((BigInt(y) / 10n ** 20n)) / 10000; } catch { return 0; }
}

// Checks a transaction result from the NEAR RPC (`tx` / EXPERIMENTAL_tx_status). Throws a readable
// error unless the OWNER really signed THIS method on THIS contract, it succeeded, and (when given)
// it was about the expected payment id. Returns the contract events found in its logs.
export function verifyOwnerTx(res, { owner, contractId, method, id }) {
  if (res?.error) throw new Error("NEAR RPC: " + (res.error.data || res.error.message || "error"));
  const r = res?.result;
  if (!r?.transaction) throw new Error("Transaction not found on chain yet. Wait a few seconds and try again");
  const t = r.transaction;
  if (t.signer_id !== owner) throw new Error(`That transaction was signed by ${t.signer_id}, not the owner (${owner})`);
  if (t.receiver_id !== contractId) throw new Error("That transaction is not for this contract");
  const fc = t.actions?.[0]?.FunctionCall;
  if (!fc || fc.method_name !== method) throw new Error(`That transaction did not call ${method}`);
  if (r.status?.Failure) throw new Error("The transaction failed on chain");
  if (id !== undefined && id !== null) {
    let args; try { args = b64json(fc.args); } catch { args = {}; }
    if (String(args.id) !== String(id)) throw new Error("That transaction was about a different payment");
  }
  const logs = (r.receipts_outcome || []).flatMap((o) => o.outcome?.logs || []);
  const events = parseCliOutput(logs.join("\n")).events;
  if (!events.length) throw new Error("The contract returned no result");
  return events;
}

async function rpc(fetchImpl, url, method, params) {
  const r = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "allowance", method, params }) });
  if (!r.ok) throw new Error("NEAR RPC returned HTTP " + r.status);
  return r.json();
}

// Reads the contract's get_state straight from the chain (a view call, no signing, no cost).
export async function queryChainState({ contractId, rpcUrl = DEFAULT_RPC, fetchImpl = fetch }) {
  const res = await rpc(fetchImpl, rpcUrl, "query", { request_type: "call_function", finality: "optimistic", account_id: contractId, method_name: "get_state", args_base64: Buffer.from("{}").toString("base64") });
  if (res.error || res.result?.error) throw new Error("Could not read the contract: " + (res.result?.error || res.error?.data || res.error?.message));
  const st = JSON.parse(Buffer.from(res.result.result).toString("utf8"));
  const p = st.policy || {};
  return {
    contractId, owner: st.owner, agent: st.agent, guardian: st.guardian || null, paused: !!st.paused,
    spentToday: yoctoToNear(st.spentToday || "0"), pending: Object.keys(st.pending || {}).length,
    policy: { perTxCap: yoctoToNear(p.perTxCap), dailyLimit: yoctoToNear(p.dailyLimit), approvalThreshold: yoctoToNear(p.approvalThreshold),
      allowed: p.allowed || [], blocked: p.blocked || [], maxPerHour: p.maxPerHour || 0, recipientDailyCaps: p.recipientDailyCaps || {} },
  };
}

export class ContractTreasury extends Treasury {
  // guardian (optional): a separate account that can only PAUSE the agent on-chain.
  constructor({ policy, contractId, agent, owner, guardian = null, recipientMap = {}, scale = 0.01, run = runNear, rpcUrl = DEFAULT_RPC, fetchImpl = fetch }) {
    if (!okAccount(contractId)) throw new Error("CONTRACT_ID is not set (see .env.example)");
    if (!okAccount(agent)) throw new Error("NEAR_ACCOUNT_ID (the agent account) is not set");
    if (!okAccount(owner)) throw new Error("OWNER_ACCOUNT_ID is not set");
    if (guardian && !okAccount(guardian)) throw new Error("GUARDIAN_ACCOUNT_ID is not a valid account");
    super(policy, { name: "near-contract", account: contractId });
    Object.assign(this, { contractId, agent, owner, guardian, recipientMap, scale, run, rpcUrl, fetchImpl });
    this.usedTx = new Set();
  }

  // The contract keeps its own daily total, and "Reset demo" cannot reset a real chain. Read it
  // so the dashboard shows what the contract will actually enforce. Best effort: offline is fine.
  // Turn the contract's rules (real NEAR, real accounts) into the dashboard's demo units and names.
  // Amounts in p are in real NEAR (numbers).
  policyFromChain(p) {
    const demo = (near) => Math.round((near / this.scale) * 100) / 100;
    const back = Object.fromEntries(Object.entries(this.recipientMap).map(([logical, real]) => [real, logical]));
    return {
      dailyLimit: demo(p.dailyLimit), perTxCap: demo(p.perTxCap), approvalThreshold: demo(p.approvalThreshold),
      allowedRecipients: (p.allowed || []).map((a) => back[a] || a), blockedRecipients: (p.blocked || []).map((a) => back[a] || a),
      maxPerHour: p.maxPerHour || 0,
    };
  }

  // Copy what the chain says (rules, daily total, paused) into the dashboard's ledger.
  adoptChain(c) {
    this.policy = { ...this.policy, ...this.policyFromChain(c.policy) };
    this.spentToday = Math.round((c.spentToday / this.scale) * 100) / 100;
    this.paused = !!c.paused;
    if (!c.paused) this.pauseReason = null;
  }

  async syncFromChain() {
    try {
      const c = await queryChainState({ contractId: this.contractId, rpcUrl: this.rpcUrl, fetchImpl: this.fetchImpl });
      this.adoptChain(c);
      return c;
    } catch { return null; }
  }

  async callContract(method, args, signer) {
    const out = await this.run(buildCallArgs({ contractId: this.contractId, method, args, signer }));
    const parsed = parseCliOutput(out);
    if (!parsed.events.length) throw new Error("The contract returned no result");
    return parsed;
  }

  // Kill switch on-chain. The guardian account signs automatic pauses; the owner signs manual ones.
  async pause(reason = "Paused by the owner", by = "owner") {
    const signer = by === "guardian" && this.guardian ? this.guardian : this.owner;
    const who = signer === this.guardian ? "guardian" : "owner";
    const base = { type: "control", memo: "Agent paused" };
    try {
      const r = await this.callContract("pause", { reason }, signer);
      if (r.events[0].event !== "paused") throw new Error("The contract did not confirm the pause");
      this.paused = true;
      this.pauseReason = reason;
      return this.log({ ...base, status: "paused", reason: `${who}: ${reason} (on-chain)`, txHash: r.txHash });
    } catch (e) {
      return this.log({ ...base, status: "failed", reason: "On-chain pause failed: " + e.message });
    }
  }

  async resume() {
    const base = { type: "control", memo: "Agent resumed" };
    try {
      const r = await this.callContract("unpause", {}, this.owner);
      if (r.events[0].event !== "unpaused") throw new Error("The contract did not confirm");
      this.paused = false;
      this.pauseReason = null;
      return this.log({ ...base, status: "resumed", reason: "Resumed by the owner (on-chain)", txHash: r.txHash });
    } catch (e) {
      return this.log({ ...base, status: "failed", reason: "On-chain resume failed: " + e.message });
    }
  }

  async processPayment({ to, amount, memo }) {
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
    if (/paused/i.test(ev.data?.reason || "")) { this.paused = true; }
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

  // The owner signed an action in their OWN wallet (browser). We do not trust the browser's word:
  // we look the transaction up on the NEAR RPC, check who signed what, and only then update our ledger.
  async syncOwnerAction({ action, id, txHash, sleepMs = 1500 }) {
    const M = { approve: "approve", reject: "reject", pause: "pause", unpause: "unpause", set_policy: "set_policy" }[action];
    if (!M) throw new Error("Unknown action");
    if (typeof txHash !== "string" || !/^[A-Za-z0-9]{40,50}$/.test(txHash)) throw new Error("Invalid transaction hash");
    if (this.usedTx.has(txHash)) throw new Error("That transaction was already recorded");
    let tx = null;
    if (action === "approve" || action === "reject") {
      tx = this.txs.find((t) => t.id === id && t.status === "pending");
      if (!tx) throw new Error("No pending payment with that id");
    }
    let events, last;
    for (let i = 0; i < 4; i++) {
      try {
        const res = await rpc(this.fetchImpl, this.rpcUrl, "EXPERIMENTAL_tx_status", { tx_hash: txHash, sender_account_id: this.owner, wait_until: "FINAL" });
        events = verifyOwnerTx(res, { owner: this.owner, contractId: this.contractId, method: M, id: tx ? tx.contractId : undefined });
        break;
      } catch (e) { last = e; if (!/not found|UNKNOWN_TRANSACTION|DOESN'T EXIST/i.test(e.message) || i === 3) throw e; await new Promise((r) => setTimeout(r, sleepMs)); }
    }
    if (!events) throw last;
    this.usedTx.add(txHash);
    const ev = events[0];
    if (action === "approve") {
      tx.txHash = txHash;
      if (ev.event === "payment_approved") { this.balance -= tx.amount; this.spentToday += tx.amount; tx.status = "paid"; tx.reason = "Approved by the owner in their wallet (executed by the smart contract)"; }
      else { tx.status = "blocked"; tx.reason = `${ev.data?.reason || "Blocked"} (re-checked by the smart contract)`; }
      return tx;
    }
    if (action === "reject") { tx.txHash = txHash; tx.status = "rejected"; tx.reason = "Rejected by the owner in their wallet"; return tx; }
    if (action === "set_policy") {
      if (ev.event !== "policy_updated" || !ev.data?.policy) throw new Error("The contract did not confirm the new rules");
      this.policy = { ...this.policy, ...this.policyFromChain({ ...ev.data.policy, dailyLimit: yoctoToNear(ev.data.policy.dailyLimit), perTxCap: yoctoToNear(ev.data.policy.perTxCap), approvalThreshold: yoctoToNear(ev.data.policy.approvalThreshold) }) };
      return this.log({ type: "control", memo: "Rules updated", status: "updated", reason: "Owner changed the rules in their wallet (on-chain)", txHash });
    }
    if (action === "pause") {
      this.paused = true; this.pauseReason = "Paused by the owner";
      return this.log({ type: "control", memo: "Agent paused", status: "paused", reason: "owner: signed in their wallet (on-chain)", txHash });
    }
    this.paused = false; this.pauseReason = null;
    return this.log({ type: "control", memo: "Agent resumed", status: "resumed", reason: "Resumed by the owner in their wallet (on-chain)", txHash });
  }
}
