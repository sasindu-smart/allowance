import { evaluate } from "./policy.js";

// A cross-chain payout request: the policy engine decides FIRST. Only if the payment would be
// allowed (or held for approval) do we ask NEAR Intents for a dry-run quote. Blocked payments
// never reach the Intents API.
export async function quotePayout(treasury, intents, { to, amount, memo, scale = 0.01 }) {
  const verdict = evaluate(treasury.policy, treasury.spentToday, { to, amount });
  const base = { type: "quote", to, amount, memo };

  if (verdict.decision === "block") {
    return treasury.log({ ...base, status: "blocked", reason: `${verdict.reason}. Nothing was sent to NEAR Intents.` });
  }
  if (!intents?.configured) {
    return treasury.log({ ...base, status: "failed", reason: "NEAR Intents is not set up. Add INTENTS_REFUND_TO and INTENTS_RECIPIENT to .env." });
  }
  try {
    const q = await intents.quote({ amountNear: amount * scale });
    const timing = q.timeEstimate ? `, about ${q.timeEstimate}s` : "";
    return treasury.log({
      ...base,
      status: "quoted",
      reason: `Policy: ${verdict.reason}. ${q.amountIn} ${q.originSymbol} would buy about ${q.amountOut} ${q.destinationSymbol} on ${q.destinationChain}${timing}. Dry run: nothing was sent.`,
      quote: q,
    });
  } catch (e) {
    return treasury.log({ ...base, status: "failed", reason: "NEAR Intents error: " + e.message });
  }
}
