import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "./env.js";
import { DEFAULT_POLICY } from "./policy.js";
import { Treasury } from "./ledger.js";
import { Agent } from "./agent.js";
import { getPayments } from "./payments.js";
import { ContractTreasury } from "./near-contract.js";
import { parseRecipientMap } from "./near-testnet.js";
import { intentsConfigFromEnv, createIntentsClient } from "./intents.js";
import { quotePayout } from "./payout.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "..", "public");
const PORT = process.env.PORT || 3000;

// PAYMENT_MODE=near-contract: the smart contract enforces the rules (see src/near-contract.js).
const contractMode = process.env.PAYMENT_MODE === "near-contract";
const payments = contractMode ? { name: "near-contract" } : getPayments();
const treasury = contractMode
  ? new ContractTreasury({
      policy: DEFAULT_POLICY,
      contractId: process.env.CONTRACT_ID,
      agent: process.env.NEAR_ACCOUNT_ID,
      owner: process.env.OWNER_ACCOUNT_ID,
      recipientMap: parseRecipientMap(process.env.RECIPIENT_MAP),
      scale: Number(process.env.PAYMENT_SCALE || 0.01),
    })
  : new Treasury(DEFAULT_POLICY, payments);
const agent = new Agent();
const intents = createIntentsClient(intentsConfigFromEnv());
const SCALE = Number(process.env.PAYMENT_SCALE) || 0.01;
console.log(`Payment mode: ${payments.name}`);
console.log(`NEAR Intents: ${intents.configured ? "dry-run quotes enabled" : "not configured (optional)"}`);
console.log(`Agent mode: ${agent.mode}`);

const state = () => ({ ...treasury.snapshot(), agentMode: agent.mode, intentsReady: intents.configured });

const json = (res, code, data) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && url.pathname === "/api/state") return json(res, 200, state());

  if (req.method === "POST" && url.pathname === "/api/step") {
    const entry = await agent.step(treasury);
    return json(res, 200, { entry, ...state() });
  }

  if (req.method === "POST" && url.pathname === "/api/attack") {
    const text = agent.nextAttack();
    const compromised = url.searchParams.get("compromised") === "1";
    const entry = await agent.handleMessage(treasury, text, { compromised });
    return json(res, 200, { entry, ...state() });
  }

  // Cross-chain payout: policy decides first, then NEAR Intents returns a DRY-RUN quote only.
  if (req.method === "POST" && url.pathname === "/api/intents/quote") {
    const scam = url.searchParams.get("scenario") === "scam";
    const req2 = scam
      ? { to: "scam-giveaway.near", amount: 8, memo: "Cross-chain payout to an unknown vendor" }
      : { to: "cloud-gpu.near", amount: 5, memo: "Pay GPU vendor in USDC on Base" };
    const entry = await quotePayout(treasury, intents, { ...req2, scale: SCALE });
    return json(res, 200, { entry, ...state() });
  }

  if (req.method === "POST" && url.pathname === "/api/reset") {
    treasury.reset();
    agent.i = 0;
    agent.attackIndex = 0;
    return json(res, 200, state());
  }

  const m = url.pathname.match(/^\/api\/(approve|reject)\/(\d+)$/);
  if (req.method === "POST" && m) {
    const id = Number(m[2]);
    const tx = m[1] === "approve" ? await treasury.approve(id) : await treasury.reject(id);
    return tx ? json(res, 200, state()) : json(res, 404, { error: "No pending tx with that id" });
  }

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(fs.readFileSync(path.join(PUBLIC, "index.html")));
  }

  json(res, 404, { error: "Not found" });
});

server.listen(PORT, () => console.log(`Allowance running: http://localhost:${PORT}`));
