import test from "node:test";
import assert from "node:assert/strict";
import { buildArgs, parseRecipientMap, createNearTestnetPayments, quoteForShell } from "../src/near-testnet.js";

test("quoteForShell quotes only arguments that contain spaces", () => {
  assert.deepEqual(quoteForShell(["tokens", "0.05 NEAR", "send"]), ["tokens", '"0.05 NEAR"', "send"]);
});
import { getPayments } from "../src/payments.js";
import { Treasury } from "../src/ledger.js";
import { DEFAULT_POLICY } from "../src/policy.js";

test("buildArgs scales amounts and builds the expected CLI call", () => {
  const args = buildArgs({ from: "me-agent.testnet", to: "me-data.testnet", amount: 5, scale: 0.01 });
  assert.deepEqual(args, [
    "tokens", "me-agent.testnet", "send-near", "me-data.testnet", "0.05 NEAR",
    "network-config", "testnet", "sign-with-keychain", "send",
  ]);
});

test("buildArgs rejects shell-injection style account names", () => {
  assert.throws(() => buildArgs({ from: "me.testnet", to: "x.testnet & calc", amount: 1, scale: 0.01 }));
  assert.throws(() => buildArgs({ from: "me.testnet", to: "a b.testnet", amount: 1, scale: 0.01 }));
});

test("buildArgs refuses non-testnet recipients and oversized amounts", () => {
  assert.throws(() => buildArgs({ from: "me.testnet", to: "someone.near", amount: 1, scale: 0.01 }));
  assert.throws(() => buildArgs({ from: "me.testnet", to: "a.testnet", amount: 500, scale: 0.01 }));
});

test("parseRecipientMap parses logical=real pairs", () => {
  assert.deepEqual(parseRecipientMap("a.near=x.testnet, b.near = y.testnet"), { "a.near": "x.testnet", "b.near": "y.testnet" });
});

test("getPayments defaults to mock", () => {
  assert.equal(getPayments({}).name, "mock");
});

test("testnet mode needs an account id", () => {
  assert.throws(() => createNearTestnetPayments({ accountId: "" }));
});

test("a payment error is logged as failed and moves no money", async () => {
  const broken = { name: "broken", async pay() { throw new Error("rpc down"); } };
  const t = new Treasury(DEFAULT_POLICY, broken);
  const tx = await t.requestPayment({ to: "data-api.near", amount: 5, memo: "x" });
  assert.equal(tx.status, "failed");
  assert.equal(t.balance, 100);
  assert.equal(t.spentToday, 0);
});
