// The rules a human sets for the agent. The agent can NOT change these.
export const DEFAULT_POLICY = {
  dailyLimit: 50,          // max total spend per day (NEAR)
  perTxCap: 20,            // max for a single payment
  approvalThreshold: 10,   // payments above this need a human click
  allowedRecipients: ["data-api.near", "research-agent.near", "cloud-gpu.near"],
  blockedRecipients: ["scam-giveaway.near"],
};

// Pure function: easy to test, easy for judges to read.
// Returns { decision: "allow" | "needs_approval" | "block", reason }
export function evaluate(policy, spentToday, tx) {
  const { to, amount } = tx;

  if (!(amount > 0)) return { decision: "block", reason: "Invalid amount" };
  if (policy.blockedRecipients.includes(to))
    return { decision: "block", reason: "Recipient is on the blocklist (possible scam)" };
  if (!policy.allowedRecipients.includes(to))
    return { decision: "block", reason: "Recipient is not on the allowlist" };
  if (amount > policy.perTxCap)
    return { decision: "block", reason: `Amount exceeds per-transaction cap of ${policy.perTxCap}` };
  if (spentToday + amount > policy.dailyLimit)
    return { decision: "block", reason: `Would exceed daily limit of ${policy.dailyLimit}` };
  if (amount > policy.approvalThreshold)
    return { decision: "needs_approval", reason: `Above ${policy.approvalThreshold} NEAR: human approval required` };

  return { decision: "allow", reason: "Within policy" };
}
