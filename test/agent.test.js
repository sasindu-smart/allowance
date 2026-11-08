import test from "node:test";
import assert from "node:assert/strict";
import { Agent, ATTACKS, naiveDecide, parseDecision } from "../src/agent.js";
import { llmConfigFromEnv } from "../src/llm.js";
import { Treasury } from "../src/ledger.js";
import { DEFAULT_POLICY } from "../src/policy.js";
import { mockPayments } from "../src/payments.js";

test("no LLM key means naive mode", () => {
  assert.equal(llmConfigFromEnv({}), null);
  assert.match(new Agent(null).mode, /naive/);
});

test("LLM config defaults to NEAR AI Cloud base URL", () => {
  const c = llmConfigFromEnv({ LLM_API_KEY: "k" });
  assert.equal(c.baseUrl, "https://cloud-api.near.ai/v1");
});

test("naiveDecide follows an injected instruction", () => {
  const d = naiveDecide(ATTACKS[0]);
  assert.equal(d.action, "pay");
  assert.equal(d.to, "scam-giveaway.near");
  assert.equal(d.amount, 18);
});

test("parseDecision accepts valid JSON, even with extra text around it", () => {
  const d = parseDecision('Sure! {"action":"pay","to":"data-api.near","amount":5,"memo":"x"} done');
  assert.deepEqual(d, { action: "pay", to: "data-api.near", amount: 5, memo: "x" });
});

test("parseDecision rejects malformed or invalid model output", () => {
  assert.equal(parseDecision("not json").action, "ignore");
  assert.equal(parseDecision('{"action":"pay","to":"a.near","amount":-5}').action, "ignore");
  assert.equal(parseDecision('{"action":"pay","to":"a.near","amount":"5"}').action, "ignore");
});

test("attack 1 (scam recipient) is blocked and no money moves", async () => {
  const t = new Treasury(DEFAULT_POLICY, mockPayments);
  const a = new Agent(null);
  const tx = await a.handleMessage(t, ATTACKS[0]);
  assert.equal(tx.status, "blocked");
  assert.equal(t.balance, 100);
});

test("attack 2 (allowed recipient, big amount) waits for human approval", async () => {
  const t = new Treasury(DEFAULT_POLICY, mockPayments);
  const a = new Agent(null);
  const tx = await a.handleMessage(t, ATTACKS[1]);
  assert.equal(tx.status, "pending");
  assert.equal(t.balance, 100);
});

test("attack 3 (unknown recipient) is blocked", async () => {
  const t = new Treasury(DEFAULT_POLICY, mockPayments);
  const a = new Agent(null);
  const tx = await a.handleMessage(t, ATTACKS[2]);
  assert.equal(tx.status, "blocked");
});

test("a message with no payment request is ignored", async () => {
  const t = new Treasury(DEFAULT_POLICY, mockPayments);
  const a = new Agent(null);
  const tx = await a.handleMessage(t, "Hello, how are you?");
  assert.equal(tx.status, "ignored");
});

test("compromised mode obeys the attacker even when an LLM is configured, but the policy still blocks", async () => {
  const t = new Treasury(DEFAULT_POLICY, mockPayments);
  const a = new Agent({ baseUrl: "http://127.0.0.1:1", apiKey: "k", model: "m" }); // LLM would fail if called
  const tx = await a.handleMessage(t, ATTACKS[0], { compromised: true });
  assert.equal(tx.status, "blocked");
  assert.equal(t.balance, 100);
});
