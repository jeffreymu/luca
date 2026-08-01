/**
 * LLM provider abstraction.
 *
 * Resolution order (evaluated at every run, so config changes are instant):
 *   1. Active provider stored in the DB (configured via the Providers UI / API)
 *   2. Env vars LUCA_LLM_BASE_URL / LUCA_LLM_API_KEY / LUCA_LLM_MODEL
 *   3. SimulatedProvider (offline, deterministic)
 *
 * Any OpenAI-compatible chat-completions endpoint works. On LLM failure the
 * engine falls back to the simulated provider and records it in the trace.
 */

export class SimulatedProvider {
  constructor() {
    this.name = "simulated";
    this.available = true;
  }
  async complete() {
    throw new Error("SimulatedProvider does not serve raw completions; specialists simulate directly.");
  }
}

export class OpenAIProvider {
  constructor({ baseUrl, apiKey, model, label }) {
    this.label = label;
    this.baseUrl = (baseUrl ?? "").replace(/\/$/, "");
    this.apiKey = apiKey ?? "";
    this.model = model ?? "";
    this.available = Boolean(this.baseUrl && this.apiKey && this.model);
  }
  get name() {
    return this.label ? `${this.label} (${this.model})` : `openai:${this.model}`;
  }

  async complete({ system, user, timeoutMs = 60_000 }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const body = await res.json();
      const text = body.choices?.[0]?.message?.content;
      if (!text) throw new Error("LLM returned empty content");
      return JSON.parse(text);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Build a runtime provider from a DB row. */
export function providerFromRow(row) {
  return new OpenAIProvider({
    baseUrl: row.base_url,
    apiKey: row.api_key,
    model: row.model,
    label: row.name,
  });
}

/** Never leak full API keys through the API/UI. */
export function maskApiKey(key) {
  if (!key) return "";
  if (key.length <= 8) return key.slice(0, 2) + "…";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/**
 * Connectivity test: GET {baseUrl}/models (cheap, widely supported),
 * then report a few available model ids.
 */
export async function testProvider(provider, timeoutMs = 10_000) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${provider.baseUrl}/models`, {
      headers: { authorization: `Bearer ${provider.apiKey}` },
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      return { ok: false, latencyMs, detail: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
    }
    const body = await res.json();
    const models = (body.data ?? []).map((m) => m.id).slice(0, 5);
    const modelFound = (body.data ?? []).some((m) => m.id === provider.model);
    return {
      ok: true,
      latencyMs,
      detail: modelFound
        ? `连接成功，模型 ${provider.model} 可用。`
        : `连接成功，但模型列表中未找到 ${provider.model}。可用示例: ${models.join(", ") || "(空)"}`,
      modelFound,
      sampleModels: models,
    };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, detail: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Env-var fallback provider (boot-time default). */
export function resolveProvider(env = process.env) {
  const llm = new OpenAIProvider({
    baseUrl: env.LUCA_LLM_BASE_URL ?? "",
    apiKey: env.LUCA_LLM_API_KEY ?? "",
    model: env.LUCA_LLM_MODEL ?? "",
  });
  if (llm.available) return { primary: llm, fallback: new SimulatedProvider(), mode: "llm", source: "env" };
  return { primary: new SimulatedProvider(), fallback: null, mode: "simulated", source: "simulated" };
}
