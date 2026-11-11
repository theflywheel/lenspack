import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { defaultSettingsMiddleware, wrapLanguageModel } from "ai";

import type { LlmAdapter } from "../llm";

// Any endpoint that speaks the OpenAI chat-completions API: OpenRouter, vLLM,
// a hosted model's own gateway. The default kind, so a config written before
// adapters existed means exactly what it meant then.

export const openAICompatibleAdapter: LlmAdapter = {
  kind: "openai-compatible",
  ownKeys: ["extraBody"],
  build(cfg, { apiKey, fetch: viaFetch }) {
    const extra = cfg.extraBody ?? {};
    const fetchWithExtras: typeof fetch = async (input, init) => {
      if (Object.keys(extra).length && init?.body && typeof init.body === "string") {
        init = { ...init, body: JSON.stringify({ ...(JSON.parse(init.body) as Record<string, unknown>), ...extra }) };
      }
      return (viaFetch ?? fetch)(input, init);
    };
    const model = createOpenAICompatible({
      name: "lenspack-llm",
      baseURL: cfg.baseUrl!,
      apiKey: apiKey ?? "",
      headers: { "HTTP-Referer": "https://lenspack.proto.theflywheel.in", "X-Title": "lenspack", ...(cfg.headers ?? {}) },
      fetch: fetchWithExtras,
    }).chatModel(cfg.model);
    // No cap unless the config asks: the endpoint's own default, as before.
    return cfg.maxOutputTokens ? wrapLanguageModel({ model, middleware: defaultSettingsMiddleware({ settings: { maxOutputTokens: cfg.maxOutputTokens } }) }) : model;
  },
};
