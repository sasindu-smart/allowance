// Minimal OpenAI-compatible chat client (works with NEAR AI Cloud).
// Docs: https://docs.near.ai/cloud/guides/openai-compatibility  (base URL https://cloud-api.near.ai/v1)

export function llmConfigFromEnv(env = process.env) {
  if (!env.LLM_API_KEY) return null; // no key => agent falls back to naive rule-based mode
  return {
    baseUrl: (env.LLM_BASE_URL || "https://cloud-api.near.ai/v1").replace(/\/$/, ""),
    apiKey: env.LLM_API_KEY,
    model: env.LLM_MODEL || "zai-org/GLM-5.1-FP8", // check your account's model list: GET /v1/models
  };
}

export async function chat(config, messages) {
  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({ model: config.model, messages, temperature: 0 }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? "";
}
