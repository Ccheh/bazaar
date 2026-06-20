// Provider-agnostic LLM call via plain fetch (no SDK dependency).
// Supports DeepSeek / any OpenAI-compatible endpoint / Anthropic. Falls back to a
// labeled heuristic when no key is set, so the on-chain loop always runs.
//
// PRIVACY: only public service metadata (names, prices, task text, returned outputs)
// is ever sent to the LLM. Private keys are used ONLY for local signing and NEVER leave
// the machine / never appear in a prompt.

type Provider = "deepseek" | "openai" | "anthropic" | "none";

interface LlmConfig {
  provider: Provider;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Resolve the active provider from env. Priority: DeepSeek → generic OpenAI-compatible → Anthropic. */
export function resolveLlm(): LlmConfig {
  const model = process.env.BAZAAR_MODEL;
  if (process.env.DEEPSEEK_API_KEY) {
    return {
      provider: "deepseek",
      baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
      apiKey: process.env.DEEPSEEK_API_KEY,
      model: model ?? "deepseek-chat",
    };
  }
  if (process.env.OPENAI_API_KEY) {
    return {
      provider: "openai",
      baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      apiKey: process.env.OPENAI_API_KEY,
      model: model ?? "gpt-4o-mini",
    };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      provider: "anthropic",
      baseUrl: process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: model ?? "claude-haiku-4-5-20251001",
    };
  }
  return { provider: "none", baseUrl: "", apiKey: "", model: "" };
}

export function llmEnabled(): boolean {
  return resolveLlm().provider !== "none";
}

export function llmLabel(): string {
  const c = resolveLlm();
  return c.provider === "none" ? "heuristic (no LLM key)" : `${c.provider}:${c.model}`;
}

// Default max_tokens is generous: thinking models (deepseek-v4-pro) emit a reasoning
// chain; we cap the FINAL answer high enough to never truncate the JSON verdict.
export async function askLLM(system: string, user: string, maxTokens = 2048): Promise<string | null> {
  const c = resolveLlm();
  if (c.provider === "none") return null;
  try {
    if (c.provider === "anthropic") {
      const res = await fetch(`${c.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": c.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: c.model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: "user", content: user }],
        }),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { content?: Array<{ text?: string }> };
      return json?.content?.[0]?.text ?? null;
    }

    // OpenAI-compatible (DeepSeek / OpenAI / OpenRouter / local Ollama, etc.).
    // response_format json_object makes structured replies reliable (prompts say "JSON").
    const res = await fetch(`${c.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${c.apiKey}`,
      },
      body: JSON.stringify({
        model: c.model,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return json?.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}

/** Pull the first JSON object out of a model reply. */
export function extractJson<T>(text: string | null): T | null {
  if (!text) return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as T;
  } catch {
    return null;
  }
}
