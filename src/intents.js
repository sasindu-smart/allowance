// NEAR Intents 1Click API client. DRY-RUN QUOTES ONLY.
//
// NEAR Intents has no testnet, so this app never sends a live swap: every request carries
// `dry: true`, which makes the API return a price quote without creating a deposit address.
//
// Docs used:
//   Quote:  https://docs.near-intents.org/api-reference/oneclick/request-a-swap-quote
//   Tokens: https://docs.near-intents.org/api-reference/oneclick/get-supported-tokens

export const DEFAULT_BASE_URL = "https://1click.chaindefuser.com/v0";

export function intentsConfigFromEnv(env = process.env) {
  const refundTo = (env.INTENTS_REFUND_TO || "").trim();
  const recipient = (env.INTENTS_RECIPIENT || "").trim();
  return {
    configured: Boolean(refundTo && recipient),
    baseUrl: (env.INTENTS_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, ""),
    jwt: (env.ONECLICK_JWT || "").trim() || null,
    refundTo,
    recipient,
    origin: { symbol: "wNEAR", blockchain: "near" },
    destination: {
      symbol: (env.INTENTS_DEST_SYMBOL || "USDC").trim(),
      blockchain: (env.INTENTS_DEST_CHAIN || "base").trim().toLowerCase(),
    },
  };
}

// Whole base units as a string (the API rejects decimals). Rounds to 6 decimal places first.
export function toBaseUnits(amount, decimals) {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) throw new Error("Amount must be a positive number");
  if (!Number.isInteger(decimals) || decimals < 6) throw new Error("Unsupported token decimals");
  const micro = BigInt(Math.round(amount * 1e6));
  if (micro <= 0n) throw new Error("Amount is too small");
  return String(micro * 10n ** BigInt(decimals - 6));
}

export function findToken(tokens, symbol, blockchain) {
  if (!Array.isArray(tokens)) return null;
  return tokens.find((t) => String(t.symbol).toLowerCase() === symbol.toLowerCase() && t.blockchain === blockchain) || null;
}

// `dry: true` is hard-coded: there is deliberately no option to turn it off.
export function buildQuoteRequest({ originAsset, destinationAsset, amount, refundTo, recipient, now = Date.now(), slippageBps = 100 }) {
  return {
    dry: true,
    swapType: "EXACT_INPUT",
    slippageTolerance: slippageBps,
    originAsset,
    depositType: "ORIGIN_CHAIN",
    destinationAsset,
    amount,
    refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(now + 60 * 60 * 1000).toISOString(),
  };
}

export function createIntentsClient(config, { fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  let cache = null; // { at, tokens }

  async function http(path, init = {}) {
    const headers = { "Content-Type": "application/json", Accept: "application/json" };
    if (config.jwt) headers.Authorization = `Bearer ${config.jwt}`;
    const res = await fetchImpl(config.baseUrl + path, { ...init, headers, signal: AbortSignal.timeout(20000) });
    if (!res.ok) {
      let detail = "";
      try {
        const b = await res.json();
        detail = String(b?.message || b?.error || "").slice(0, 200);
      } catch {}
      throw new Error(`NEAR Intents API ${res.status}${detail ? ": " + detail : ""}`);
    }
    return res.json();
  }

  async function getTokens() {
    if (cache && now() - cache.at < 5 * 60 * 1000) return cache.tokens;
    const tokens = await http("/tokens");
    cache = { at: now(), tokens };
    return tokens;
  }

  return {
    configured: config.configured,

    async quote({ amountNear }) {
      if (!config.configured) throw new Error("NEAR Intents is not set up (INTENTS_REFUND_TO and INTENTS_RECIPIENT)");
      const tokens = await getTokens();
      const o = findToken(tokens, config.origin.symbol, config.origin.blockchain);
      const d = findToken(tokens, config.destination.symbol, config.destination.blockchain);
      if (!o) throw new Error(`Token not found: ${config.origin.symbol} on ${config.origin.blockchain}`);
      if (!d) throw new Error(`Token not found: ${config.destination.symbol} on ${config.destination.blockchain}`);

      const body = buildQuoteRequest({
        originAsset: o.assetId,
        destinationAsset: d.assetId,
        amount: toBaseUnits(amountNear, o.decimals),
        refundTo: config.refundTo,
        recipient: config.recipient,
        now: now(),
      });
      const data = await http("/quote", { method: "POST", body: JSON.stringify(body) });
      const q = data?.quote;
      if (!q || q.amountInFormatted == null || q.amountOutFormatted == null) throw new Error("Unexpected quote response from NEAR Intents");
      return {
        correlationId: data.correlationId ?? null,
        amountIn: q.amountInFormatted,
        amountOut: q.amountOutFormatted,
        amountOutUsd: q.amountOutUsd ?? null,
        timeEstimate: q.timeEstimate ?? null,
        originSymbol: o.symbol,
        destinationSymbol: d.symbol,
        destinationChain: d.blockchain,
      };
    },
  };
}
