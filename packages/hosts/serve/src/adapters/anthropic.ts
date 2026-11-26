import { createAnthropic } from "@ai-sdk/anthropic";
import { type ModelMessage, type ToolSet, wrapLanguageModel } from "ai";

import type { AnthropicSettings, LlmAdapter, PreparedCall, ProviderConfig, ProviderOptions } from "../llm";
import { type Pricing, type ProviderUsage, type Tokens, tokensOf } from "../metering";

// Claude through Anthropic's Messages API. Three things differ from an
// OpenAI-compatible endpoint and are handled here, so nothing else changes:
// - the prompt cache is opt-in per block: the tools, the stable system prompt
//   and a tool loop's tail get breakpoints, as the chat repeats all three. The
//   first two are kept for an hour by default (questions on a dashboard come
//   minutes apart, and the saved-answer store makes model calls rarer still);
//   the tail, read again only within the turn, for five minutes;
// - thinking counts toward the output cap and is tied to the conversation that
//   produced it, and lenspack's history is edited every turn (the board in the
//   system prompt changes, old turns fall out of the window), so stale thinking
//   blocks are dropped by the API rather than refused;
// - effort and thinking are request options, set once per provider.

type Model = {
  /** US$ per million tokens: input, output, cache read. Cache writes are derived from input and the TTL. */
  price: [input: number, output: number, cacheRead: number];
  /** Takes `thinking: { type: "adaptive" }`. */
  adaptive?: boolean;
  /** Takes output_config.effort. */
  effort?: boolean;
  /** The levels it takes, where not all five. */
  efforts?: string[];
  /** Ties thinking blocks to the conversation (preserved thinking), so edited history needs block_binding. */
  preserved?: boolean;
  /** Takes `fallbacks: "default"` (server-side retry of a refused turn). */
  fallbacks?: boolean;
};

// Anthropic's published first-party list rates, US$ per million tokens: [input, output, cache read].
// Source: https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-11-24 against the
// rates as of 2026-10-06). Costs computed from them are ESTIMATES: they leave out discounts, batch
// and fast-mode rates and partner (Bedrock, Vertex) prices. A config's own `pricing` wins, and a
// model not listed here is metered but unpriced.
// Haiku 5.5 has a second, higher rate above 100K prompt tokens; a chat turn is
// far below that, so its lower rate is the one listed.
const MODELS: Record<string, Model> = {
  "claude-fable-5-1": { price: [10, 50, 0.25], adaptive: true, effort: true, preserved: true, fallbacks: true },
  "claude-opus-5-5": { price: [4, 20, 0.2], adaptive: true, effort: true, preserved: true, fallbacks: true },
  "claude-opus-5": { price: [5, 25, 0.5], adaptive: true, effort: true, fallbacks: true },
  "claude-sonnet-5-5": { price: [2, 10, 0.2], adaptive: true, effort: true, preserved: true, fallbacks: true },
  "claude-sonnet-5": { price: [2, 10, 0.2], adaptive: true, effort: true },
  "claude-sonnet-4-6": { price: [3, 15, 0.3], adaptive: true, effort: true, efforts: ["low", "medium", "high", "max"] },
  "claude-haiku-5-5": { price: [0.1, 0.5, 0.01], adaptive: true, effort: true, preserved: true },
  "claude-haiku-4-5": { price: [1, 5, 0.1] },
};

/** Room for a chat turn's thinking and reply; a call that sets its own cap keeps it (plus the thinking allowance). */
const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;
const DEFAULT_THINKING_ALLOWANCE = 4096;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

type JSONObject = Record<string, NonNullable<unknown>>;
const defined = (o: Record<string, unknown>): JSONObject => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as JSONObject;

/** The request options this provider sends on every call, unless a call sets its own. */
export function anthropicDefaults(cfg: ProviderConfig): JSONObject {
  const s: AnthropicSettings = cfg.anthropic ?? {};
  if (s.effort && !EFFORTS.includes(s.effort)) throw new Error(`Provider "${cfg.name}": effort is one of ${EFFORTS.join(", ")}`);
  const m = MODELS[cfg.model];
  const betweenTools = s.thinking === "between_tools";
  const adaptive = !betweenTools && (s.thinking === "adaptive" || m?.adaptive);
  const thinking = betweenTools
    ? { type: "between_tools" }
    : adaptive
      ? defined({ type: "adaptive", display: s.display, blockBinding: m?.preserved ? { prefixMismatchBehavior: "drop_block" } : undefined })
      : undefined;
  return defined({
    thinking,
    // Anthropic's advice for multi-step tool use is to start at medium; the API's own default is higher.
    effort: s.effort ?? (m?.effort ? "medium" : undefined),
    fallbacks: s.fallbacks === false ? undefined : (s.fallbacks ?? (m?.fallbacks && !betweenTools ? "default" : undefined)),
  });
}

/** The stable prefix's lifetime: an hour unless the provider says 5m. */
const stableTtl = (s: AnthropicSettings) => (s.cacheTtl === "5m" ? "5m" : "1h");

/** A breakpoint; "1h" asks for the hour-long lifetime (a write costs 2x input instead of 1.25x). */
function cacheMark(ttl: "5m" | "1h"): ProviderOptions {
  return { anthropic: { cacheControl: { type: "ephemeral", ...(ttl === "1h" ? { ttl: "1h" } : {}) } } };
}

/**
 * Anthropic reports cache writes by lifetime (usage.cache_creation): the hour-long ones are priced apart.
 * A response without that breakdown (an older proxy) is taken to have written at the stable prefix's lifetime.
 */
export function anthropicTokens(u: ProviderUsage, cfg?: ProviderConfig): Tokens {
  const t = tokensOf(u);
  const raw = (u.raw ?? {}) as { cache_creation?: { ephemeral_1h_input_tokens?: number } };
  const hour = raw.cache_creation?.ephemeral_1h_input_tokens;
  if (typeof hour === "number") return { ...t, cacheWrite1hTokens: Math.min(hour, t.cacheWriteTokens) };
  return cfg && stableTtl(cfg.anthropic ?? {}) === "1h" && t.cacheWriteTokens ? { ...t, cacheWrite1hTokens: t.cacheWriteTokens } : t;
}

/** Between-tools thinking cannot ask the API to drop stale blocks, so edited history goes without them. */
function withoutReasoning(messages: ModelMessage[]): ModelMessage[] {
  return messages.flatMap((m) => {
    if (m.role !== "assistant" || typeof m.content === "string") return [m];
    const content = m.content.filter((p) => p.type !== "reasoning");
    return content.length ? [{ ...m, content }] : [];
  });
}

export const anthropicAdapter: LlmAdapter = {
  kind: "anthropic",
  defaultBaseUrl: "https://api.anthropic.com/v1",
  ownKeys: ["anthropic"],
  // Thinking may come before the word; the probe only needs the call to succeed.
  probeTokens: 64,
  tokens: anthropicTokens,
  build(cfg, { apiKey, fetch }) {
    const defaults = anthropicDefaults(cfg);
    const allowance = defaults.thinking ? (cfg.anthropic?.thinkingAllowance ?? DEFAULT_THINKING_ALLOWANCE) : 0;
    const cap = cfg.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    // No apiKey: the SDK reads ANTHROPIC_API_KEY.
    const model = createAnthropic({ ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}), apiKey, headers: cfg.headers, fetch }).languageModel(cfg.model);
    return wrapLanguageModel({
      model,
      middleware: {
        specificationVersion: "v4",
        transformParams: async ({ params }) => ({
          ...params,
          maxOutputTokens: params.maxOutputTokens == null ? cap : params.maxOutputTokens + allowance,
          providerOptions: { ...params.providerOptions, anthropic: { ...defaults, ...params.providerOptions?.anthropic } as never },
        }),
      },
    });
  },
  efforts(cfg) {
    const m = MODELS[cfg.model];
    const s = cfg.anthropic ?? {};
    if (!m?.effort && !s.effort) return undefined;
    // Between-tools thinking takes no more than high.
    const levels = s.thinking === "between_tools" ? ["low", "medium", "high"] : (m?.efforts ?? EFFORTS);
    return { levels, default: s.effort ?? "medium" };
  },
  pricing(cfg) {
    const m = MODELS[cfg.model];
    if (!m) return undefined;
    const [input, output, cachedInput] = m.price;
    // A cache write costs 1.25× input for the 5-minute TTL, 2× for one hour. Usage says which
    // lifetime each write had (anthropicTokens).
    return { input, output, cachedInput, cacheWrite: input * 1.25, cacheWrite1h: input * 2 } satisfies Pricing;
  },
  prepare(call, cfg): PreparedCall {
    const s = cfg.anthropic ?? {};
    const messages = s.thinking === "between_tools" ? withoutReasoning(call.messages) : call.messages;
    // A call's own effort wins over the provider's.
    const effort = call.effort ? { anthropic: { effort: call.effort } } : undefined;
    if (s.cache === false) return { system: call.system.join(""), messages, ...(call.tools ? { tools: call.tools } : {}), ...(effort ? { providerOptions: effort } : {}) };
    // Render order is tools, system, messages, and a breakpoint caches
    // everything before it. Three of the four allowed: the last tool; the
    // system part just before the one that changes most (the board); and, in a
    // tool loop, the conversation's tail, which each step re-sends and grows.
    // A longer lifetime must come before a shorter one, so the hour-long marks
    // are the first two and the tail's five minutes the last.
    const mark = cacheMark(stableTtl(s));
    const tail = cacheMark("5m");
    const parts = call.system.filter((p) => p.trim());
    const at = Math.max(0, parts.length - 2);
    const system = parts.map((content, i) => ({ role: "system" as const, content, ...(i === at ? { providerOptions: mark } : {}) }));
    const providerOptions = call.loop || effort ? { anthropic: { ...(call.loop ? tail.anthropic : {}), ...effort?.anthropic } } : undefined;
    return { system, messages, ...(call.tools ? { tools: markLastTool(call.tools, mark) } : {}), ...(providerOptions ? { providerOptions } : {}) };
  },
};

/** The same tools, the last carrying the breakpoint; key order is the order they are sent in. */
function markLastTool(tools: ToolSet, mark: ProviderOptions): ToolSet {
  const last = Object.keys(tools).at(-1);
  if (!last) return tools;
  const tool = tools[last]!;
  return { ...tools, [last]: { ...tool, providerOptions: { ...tool.providerOptions, ...mark } } as typeof tool };
}
