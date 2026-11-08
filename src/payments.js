import { createNearTestnetPayments, parseRecipientMap } from "./near-testnet.js";

// Payment adapter. MOCK mode = nothing real moves (safe for learning).
export const mockPayments = {
  name: "mock",
  account: "demo-treasury",
  async pay() {
    return { ok: true, txHash: "mock-" + Math.random().toString(36).slice(2, 12) };
  },
};

// PAYMENT_MODE=mock (default) or near-testnet
export function getPayments(env = process.env) {
  if (env.PAYMENT_MODE === "near-testnet") {
    return createNearTestnetPayments({
      accountId: env.NEAR_ACCOUNT_ID,
      recipientMap: parseRecipientMap(env.RECIPIENT_MAP),
      scale: Number(env.PAYMENT_SCALE || 0.01),
    });
  }
  return mockPayments;
}
