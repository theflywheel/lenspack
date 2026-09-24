import { readFileSync } from "node:fs";

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { type LanguageModel, generateText } from "ai";

// Model providers for the chat, in order of preference. Any OpenAI-compatible
// endpoint. Configured as JSON so several can coexist and the eval suite can
// score them against each other:
//   LENSPACK_LLM_PROVIDERS='[{"name":"glm-5.3-flash (amul)","baseUrl":"…","apiKey":"…","model":"glm-5.3-flash"}, …]'
// A single LENSPACK_LLM_BASE_URL / _API_KEY / _MODEL still works.

export type ProviderConfig = {
  name: string;
  baseUrl: string;
  apiKey?: string;
  apiKeyFile?: string; // read at startup; keeps secrets out of unit files
  model: string;
  extraBody?: Record<string, unknown>; // merged into every request (e.g. OpenRouter `reasoning`)
  headers?: Record<string, string>;
};

export type Provider = ProviderConfig & { languageModel: LanguageModel; available: boolean | null; latencyMs?: number; error?: string };

export function providersFromEnv(env = process.env): ProviderConfig[] {
  if (env.LENSPACK_LLM_PROVIDERS) return JSON.parse(env.LENSPACK_LLM_PROVIDERS) as ProviderConfig[];
  if (env.LENSPACK_LLM_BASE_URL && env.LENSPACK_LLM_API_KEY) {
    return [
      {
        name: env.LENSPACK_LLM_MODEL ?? "default",
        baseUrl: env.LENSPACK_LLM_BASE_URL,
        apiKey: env.LENSPACK_LLM_API_KEY,
        model: env.LENSPACK_LLM_MODEL ?? "gpt-4o-mini",
        extraBody: env.LENSPACK_LLM_EXTRA_BODY ? (JSON.parse(env.LENSPACK_LLM_EXTRA_BODY) as Record<string, unknown>) : undefined,
      },
    ];
  }
  return [];
}

export function buildProvider(cfg: ProviderConfig): Provider {
  const apiKey = cfg.apiKey ?? (cfg.apiKeyFile ? readFileSync(cfg.apiKeyFile, "utf8").trim() : "");
  const extra = cfg.extraBody ?? {};
  const fetchWithExtras: typeof fetch = async (input, init) => {
    if (Object.keys(extra).length && init?.body && typeof init.body === "string") {
      init = { ...init, body: JSON.stringify({ ...(JSON.parse(init.body) as Record<string, unknown>), ...extra }) };
    }
    return fetch(input, init);
  };
  const languageModel = createOpenAICompatible({
    name: "lenspack-llm",
    baseURL: cfg.baseUrl,
    apiKey,
    headers: { "HTTP-Referer": "https://lenspack.proto.theflywheel.in", "X-Title": "lenspack", ...(cfg.headers ?? {}) },
    fetch: fetchWithExtras,
  }).chatModel(cfg.model);
  return { ...cfg, apiKey: undefined, languageModel, available: null };
}

/** A tiny completion, so a provider that cannot serve the model is known before anyone asks it to build a board. */
export async function probe(p: Provider, timeoutMs = 20_000): Promise<Provider> {
  const started = Date.now();
  try {
    await generateText({ model: p.languageModel, prompt: "Reply with the single word: ok", maxOutputTokens: 8, abortSignal: AbortSignal.timeout(timeoutMs) });
    return { ...p, available: true, latencyMs: Date.now() - started, error: undefined };
  } catch (e) {
    return { ...p, available: false, latencyMs: Date.now() - started, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  }
}

export function publicView(p: Provider) {
  return { name: p.name, model: p.model, available: p.available, latencyMs: p.latencyMs, error: p.error };
}

/**
 * Stops a tool loop that is going nowhere: when the last `n` steps each ended
 * in a refused or failed tool call, the model is retrying the same wrong
 * idea and the turn should end so it can explain instead.
 */
export function stopOnRepeatedRefusals(n = 3) {
  return ({ steps }: { steps: { toolResults: { output?: unknown }[] }[] }) => {
    if (steps.length < n) return false;
    return steps.slice(-n).every((st) => {
      const outs = st.toolResults ?? [];
      return outs.length > 0 && outs.every((o) => {
        const v = o.output as { applied?: boolean; ok?: boolean } | undefined;
        return v?.applied === false || v?.ok === false;
      });
    });
  };
}
