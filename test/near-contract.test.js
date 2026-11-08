import test from "node:test";
import assert from "node:assert/strict";
import { ContractTreasury, toYocto, buildCallArgs, quoteArgsForWindows, parseCliOutput } from "../src/near-contract.js";
import { DEFAULT_POLICY } from "../src/policy.js";

const ev = (event, data) => `EVENT_JSON:${JSON.stringify({ standard: "allowance", version: "1.0.0", event, data })}`;
const cli = (event, data, tx = "TX123") => `Transaction ID: ${tx}\nFunction execution logs:\n  Logs [c.testnet]:\n    ${ev(event, data)}\n`;
const mk = (run) => new ContractTreasury({
  policy: DEFAULT_POLICY, contractId: "vault.testnet", agent: "agent.testnet", owner: "owner.testnet",
  recipientMap: { "data-api.near": "data.testnet" }, scale: 0.01, run,
});

test("toYocto converts and refuses unsafe values", () => {
  assert.equal(toYocto(0.05), "50000000000000000000000");
  assert.equal(toYocto(1), "1000000000000000000000000");
  assert.throws(() => toYocto(0));
  assert.throws(() => toYocto(2));
  assert.throws(() => toYocto("1"));
});

test("buildCallArgs validates inputs and builds the CLI call", () => {
  const a = buildCallArgs({ contractId: "v.testnet", method: "request_payment", args: { to: "d.testnet" }, signer: "a.testnet" });
  assert.ok(a.includes("as-transaction") && a.includes("sign-as") && a.includes("a.testnet"));
  assert.equal(a[a.indexOf("json-args") + 1], '{"to":"d.testnet"}');
  assert.throws(() => buildCallArgs({ contractId: "BAD NAME", method: "x", args: {}, signer: "a.testnet" }));
  assert.throws(() => buildCallArgs({ contractId: "v.testnet", method: "x; rm", args: {}, signer: "a.testnet" }));
  assert.throws(() => buildCallArgs({ contractId: "v.testnet", method: "x", args: {}, signer: "a b" }));
});

test("windows quoting escapes JSON quotes and spaces", () => {
  assert.deepEqual(quoteArgsForWindows(['{"a":"b"}', "30 Tgas", "plain"]), ['"{\\"a\\":\\"b\\"}"', '"30 Tgas"', "plain"]);
});

test("parseCliOutput reads events and the transaction id", () => {
  const p = parseCliOutput(cli("payment_paid", { to: "x" }));
  assert.equal(p.txHash, "TX123");
  assert.equal(p.events[0].event, "payment_paid");
  assert.deepEqual(parseCliOutput("nothing here").events, []);
});

test("an allowed payment is sent to the contract with the mapped recipient and scaled amount", async () => {
  let seen;
  const t = mk(async (args) => { seen = args; return cli("payment_paid", { to: "data.testnet" }); });
  const e = await t.requestPayment({ to: "data-api.near", amount: 5, memo: "data" });
  assert.equal(e.status, "paid");
  assert.equal(e.txHash, "TX123");
  assert.equal(t.balance, 95);
  assert.equal(t.spentToday, 5);
  const body = JSON.parse(seen[seen.indexOf("json-args") + 1]);
  assert.equal(body.to, "data.testnet");
  assert.equal(body.amount, "50000000000000000000000");
  assert.equal(seen[seen.indexOf("sign-as") + 1], "agent.testnet");
});

test("a payment the contract blocks is logged as blocked and no money is counted", async () => {
  const t = mk(async () => cli("payment_blocked", { reason: "Recipient is not on the allowlist" }));
  const e = await t.requestPayment({ to: "scam-giveaway.near", amount: 8, memo: "scam" });
  assert.equal(e.status, "blocked");
  assert.match(e.reason, /not on the allowlist.*smart contract/);
  assert.equal(t.balance, 100);
  assert.equal(t.spentToday, 0);
});

test("held payment: owner approves on-chain, signed by the OWNER account", async () => {
  const calls = [];
  const t = mk(async (args) => {
    calls.push(args);
    return args.includes("approve") ? cli("payment_approved", { id: 7 }, "TXA") : cli("payment_held", { id: 7 });
  });
  const held = await t.requestPayment({ to: "data-api.near", amount: 14, memo: "x" });
  assert.equal(held.status, "pending");
  assert.equal(held.contractId, 7);
  const done = await t.approve(held.id);
  assert.equal(done.status, "paid");
  assert.equal(t.spentToday, 14);
  const approveCall = calls[1];
  assert.equal(approveCall[approveCall.indexOf("sign-as") + 1], "owner.testnet");
  assert.equal(JSON.parse(approveCall[approveCall.indexOf("json-args") + 1]).id, 7);
});

test("owner rejects a held payment", async () => {
  const t = mk(async (args) => (args.includes("reject") ? cli("payment_rejected", { id: 3 }) : cli("payment_held", { id: 3 })));
  const held = await t.requestPayment({ to: "data-api.near", amount: 14, memo: "x" });
  const r = await t.reject(held.id);
  assert.equal(r.status, "rejected");
  assert.equal(t.spentToday, 0);
});

test("CLI failure or empty result becomes a failed row, never a paid one", async () => {
  const boom = mk(async () => { throw new Error("network down"); });
  const e1 = await boom.requestPayment({ to: "data-api.near", amount: 5, memo: "x" });
  assert.equal(e1.status, "failed");
  assert.equal(boom.balance, 100);
  const empty = mk(async () => "Transaction ID: Z\nno events");
  const e2 = await empty.requestPayment({ to: "data-api.near", amount: 5, memo: "x" });
  assert.equal(e2.status, "failed");
  assert.equal(empty.balance, 100);
});

test("amounts above the safe range fail before anything is sent", async () => {
  let called = false;
  const t = mk(async () => { called = true; return ""; });
  const e = await t.requestPayment({ to: "data-api.near", amount: 500, memo: "x" });
  assert.equal(e.status, "failed");
  assert.equal(called, false);
});

test("snapshot reports contract mode", () => {
  const s = mk(async () => "").snapshot();
  assert.equal(s.mode, "near-contract");
  assert.equal(s.account, "vault.testnet");
});
