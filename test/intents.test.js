import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { intentsConfigFromEnv, toBaseUnits, findToken, buildQuoteRequest, createIntentsClient } from "../src/intents.js";
import { quotePayout } from "../src/payout.js";
import { Treasury } from "../src/ledger.js";
import { DEFAULT_POLICY } from "../src/policy.js";
import { mockPayments } from "../src/payments.js";

const TOKENS = [
  { assetId: "nep141:wrap.near", symbol: "wNEAR", blockchain: "near", decimals: 24, price: 2.8 },
  { assetId: "nep141:base-usdc.omft.near", symbol: "USDC", blockchain: "base", decimals: 6, price: 1 },
  { assetId: "nep141:eth-usdc.omft.near", symbol: "USDC", blockchain: "eth", decimals: 6, price: 1 },
];
const QUOTE = { correlationId: "abc", quote: { amountInFormatted: "0.05", amountOutFormatted: "0.14", amountOutUsd: "0.14", timeEstimate: 90 } };
const CFG = { ...intentsConfigFromEnv({ INTENTS_REFUND_TO: "me.near", INTENTS_RECIPIENT: "0xabc" }) };

// A tiny fake of the 1Click API running on localhost, so the real HTTP code path is exercised.
async function fakeApi({ quoteStatus = 200 } = {}) {
  const seen = { quotes: [], auth: [] };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.auth.push(req.headers.authorization || null);
      res.setHeader("Content-Type", "application/json");
      if (req.method === "GET" && req.url === "/v0/tokens") return res.end(JSON.stringify(TOKENS));
      if (req.method === "POST" && req.url === "/v0/quote") {
        seen.quotes.push(JSON.parse(body));
        res.statusCode = quoteStatus;
        return res.end(JSON.stringify(quoteStatus === 200 ? QUOTE : { message: "amount too low" }));
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { seen, url: `http://127.0.0.1:${server.address().port}/v0`, close: () => server.close() };
}

test("toBaseUnits gives whole-number strings and rejects bad input", () => {
  assert.equal(toBaseUnits(0.05, 24), "50000000000000000000000");
  assert.equal(toBaseUnits(1, 6), "1000000");
  assert.throws(() => toBaseUnits(0, 24));
  assert.throws(() => toBaseUnits(-1, 24));
  assert.throws(() => toBaseUnits(NaN, 24));
  assert.throws(() => toBaseUnits(1, 3));
});

test("config is only 'configured' when refund and recipient are both set", () => {
  assert.equal(intentsConfigFromEnv({}).configured, false);
  assert.equal(intentsConfigFromEnv({ INTENTS_REFUND_TO: "me.near" }).configured, false);
  assert.equal(CFG.configured, true);
});

test("findToken matches symbol and chain", () => {
  assert.equal(findToken(TOKENS, "usdc", "base").assetId, "nep141:base-usdc.omft.near");
  assert.equal(findToken(TOKENS, "USDC", "sol"), null);
});

test("quote request is always a dry run with the documented fields", () => {
  const body = buildQuoteRequest({ originAsset: "a", destinationAsset: "b", amount: "1", refundTo: "me.near", recipient: "0xabc", now: 0 });
  assert.equal(body.dry, true);
  assert.equal(body.swapType, "EXACT_INPUT");
  assert.equal(body.depositType, "ORIGIN_CHAIN");
  assert.equal(body.recipientType, "DESTINATION_CHAIN");
  assert.equal(body.deadline, "1970-01-01T01:00:00.000Z");
  // `dry` cannot be overridden through the builder's inputs
  const forced = buildQuoteRequest({ originAsset: "a", destinationAsset: "b", amount: "1", refundTo: "r", recipient: "x", dry: false });
  assert.equal(forced.dry, true);
});

test("client talks HTTP: picks the right tokens, sends dry:true, returns a normalized quote", async () => {
  const api = await fakeApi();
  try {
    const client = createIntentsClient({ ...CFG, baseUrl: api.url });
    const q = await client.quote({ amountNear: 0.05 });
    assert.equal(q.amountOut, "0.14");
    assert.equal(q.destinationChain, "base");
    assert.equal(q.destinationSymbol, "USDC");
    const sent = api.seen.quotes[0];
    assert.equal(sent.dry, true);
    assert.equal(sent.originAsset, "nep141:wrap.near");
    assert.equal(sent.destinationAsset, "nep141:base-usdc.omft.near");
    assert.equal(sent.amount, "50000000000000000000000");
    assert.deepEqual(api.seen.auth, [null, null]); // no JWT configured -> no Authorization header
  } finally { api.close(); }
});

test("JWT is sent as a Bearer token only when configured", async () => {
  const api = await fakeApi();
  try {
    const client = createIntentsClient({ ...CFG, baseUrl: api.url, jwt: "secret" });
    await client.quote({ amountNear: 0.05 });
    assert.ok(api.seen.auth.every((a) => a === "Bearer secret"));
  } finally { api.close(); }
});

test("API errors become readable messages", async () => {
  const api = await fakeApi({ quoteStatus: 400 });
  try {
    const client = createIntentsClient({ ...CFG, baseUrl: api.url });
    await assert.rejects(() => client.quote({ amountNear: 0.05 }), /400.*amount too low/);
  } finally { api.close(); }
});

test("missing destination token gives a clear error", async () => {
  const api = await fakeApi();
  try {
    const client = createIntentsClient({ ...CFG, baseUrl: api.url, destination: { symbol: "USDC", blockchain: "sol" } });
    await assert.rejects(() => client.quote({ amountNear: 0.05 }), /Token not found: USDC on sol/);
  } finally { api.close(); }
});

// ---- policy gating ----
const fake = (impl) => { const f = { calls: 0, configured: true, async quote(a) { f.calls++; return impl(a); } }; return f; };
const goodQuote = () => ({ amountIn: "0.05", amountOut: "0.14", originSymbol: "wNEAR", destinationSymbol: "USDC", destinationChain: "base", timeEstimate: 90 });

test("allowed payout: policy passes, quote is logged, no money moves", async () => {
  const t = new Treasury(DEFAULT_POLICY, mockPayments);
  const intents = fake(goodQuote);
  const e = await quotePayout(t, intents, { to: "cloud-gpu.near", amount: 5, memo: "gpu" });
  assert.equal(e.status, "quoted");
  assert.match(e.reason, /Dry run: nothing was sent/);
  assert.equal(intents.calls, 1);
  assert.equal(t.balance, 100);
  assert.equal(t.spentToday, 0);
});

test("scam payout is blocked BEFORE any request reaches NEAR Intents", async () => {
  const t = new Treasury(DEFAULT_POLICY, mockPayments);
  const intents = fake(goodQuote);
  const e = await quotePayout(t, intents, { to: "scam-giveaway.near", amount: 8, memo: "scam" });
  assert.equal(e.status, "blocked");
  assert.match(e.reason, /Nothing was sent to NEAR Intents/);
  assert.equal(intents.calls, 0);
});

test("unconfigured Intents explains what to set, and an API failure is logged as failed", async () => {
  const t = new Treasury(DEFAULT_POLICY, mockPayments);
  const off = await quotePayout(t, { configured: false }, { to: "cloud-gpu.near", amount: 5, memo: "x" });
  assert.equal(off.status, "failed");
  assert.match(off.reason, /INTENTS_REFUND_TO/);
  const broken = await quotePayout(t, fake(() => { throw new Error("boom"); }), { to: "cloud-gpu.near", amount: 5, memo: "x" });
  assert.equal(broken.status, "failed");
  assert.match(broken.reason, /boom/);
});
