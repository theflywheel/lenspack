import { readFileSync } from "node:fs";

import { type LanguageModel, type ModelMessage, type SystemModelMessage, type ToolSet, generateText } from "ai";

import { anthropicAdapter } from "./adapters/anthropic";
import { openAICompatibleAdapter } from "./adapters/openai-compatible";
import { type Pricing, type ProviderUsage, type Tokens, meterModel, withMeter } from "./metering";

// Model providers for the chat, in order of preference. Configured as JSON so
// several can coexist and the eval suite can score them against each other:
//   LENSPACK_LLM_PROVIDERS='[{"name":"glm-5.3-flash","baseUrl":"…","apiKey":"…","model":"glm-5.3-flash"}, …]'
// A single LENSPACK_LLM_BASE_URL / _API_KEY / _MODEL (/ _PRICING) still works.
//
// A provider's `kind` picks its adapter, the way a source URL's scheme picks
// a SQL driver: the adapter turns the config into a model and shapes calls
// for that provider's API. Nothing else in lenspack knows which API a model
// speaks. Without a kind, a provider is OpenAI-compatible, as before.

export type ProviderConfig = {
  name: string;
  /** Which adapter builds it. Default "openai-compatible". */
  kind?: string;
  /** Required unless the adapter has a default endpoint. */
  baseUrl?: string;
  apiKey?: string;
  apiKeyFile?: string; // read at startup; keeps secrets out of unit files
  model: string;
  headers?: Record<string, string>;
  /** US$ per million tokens ({ input, output, cachedInput?, cacheWrite? }). Unset: the adapter's published price, else tokens are metered and cost is reported as unpriced. */
  pricing?: Pricing;
  /** Output token cap for a call that sets none. */
  maxOutputTokens?: number;
  /** openai-compatible only: merged into every request body (e.g. OpenRouter `reasoning`). */
  extraBody?: Record<string, unknown>;
  /** anthropic only: thinking, effort, prompt caching, refusal fallback. */
  anthropic?: AnthropicSettings;
};

export type AnthropicSettings = {
  /** How hard the model works; it also governs thinking. Default "medium" on models that take it. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** "adaptive" (the default on models that have it) or "between_tools" (Sonnet 5.5's lowest setting). */
  thinking?: "adaptive" | "between_tools";
  /** Whether adaptive thinking text comes back. Default "omitted". */
  display?: "omitted" | "summarized" | "updates";
  /** Prompt-cache breakpoints on tools, the stable system prompt and a tool loop's tail. Default true. */
  cache?: boolean;
  /** How long a cache entry lives. "1h" doubles the write price. Default "5m". */
  cacheTtl?: "5m" | "1h";
  /** Server-side retry of a refused turn on Anthropic's chosen fallback model. Default "default" where the model has it; false turns it off. */
  fallbacks?: "default" | false;
  /** Thinking counts toward the output cap, so a cap a caller wrote for the answer gets this many tokens on top. Default 4096. */
  thinkingAllowance?: number;
};

/** A call before it is shaped for a provider: the system prompt in parts, stable first, the changing part last. */
export type CallParts = {
  system: string[];
  messages: ModelMessage[];
  tools?: ToolSet;
  /** The messages will be extended and sent again (a tool loop), so caching their tail pays. */
  loop?: boolean;
  /** A per-call effort, one of the provider's `efforts.levels`; adapters without effort ignore it. */
  effort?: string;
};

/** The effort levels a provider takes, and the one it uses when a call names none. */
export type Efforts = { levels: string[]; default: string };

export type ProviderOptions = NonNullable<Parameters<typeof generateText>[0]["providerOptions"]>;

/** What generateText / streamText take, ready to spread into the call. */
export type PreparedCall = { system: string | SystemModelMessage[]; messages: ModelMessage[]; tools?: ToolSet; providerOptions?: ProviderOptions };

export type BuildContext = {
  /** From apiKey or apiKeyFile; undefined lets the adapter fall back to its own environment variable. */
  apiKey?: string;
  /** In place of the global fetch: tests, proxies. */
  fetch?: typeof fetch;
};

export type LlmAdapter = {
  kind: string;
  /** Where requests go when the config names no baseUrl. Absent, baseUrl is required. */
  defaultBaseUrl?: string;
  /** ProviderConfig keys only this adapter reads; a config of another kind that sets one is refused, not silently ignored. */
  ownKeys?: (keyof ProviderConfig)[];
  build(cfg: ProviderConfig, ctx: BuildContext): Exclude<LanguageModel, string>;
  /**
   * Metering. Every model an adapter builds is wrapped by buildProvider, so
   * each call is recorded and priced with no work here. These two only say
   * what the defaults cannot know: the published prices of the models it
   * knows (a config's own pricing wins), and, for a provider that reports
   * usage oddly, how its usage maps to tokens.
   */
  pricing?(cfg: ProviderConfig): Pricing | undefined;
  tokens?(usage: ProviderUsage): Tokens;
  /** The effort levels this provider's model takes; absent, it has no effort setting and a call's effort is ignored. */
  efforts?(cfg: ProviderConfig): Efforts | undefined;
  /** Shapes a call for this provider (prompt-cache breakpoints). Absent, the system parts are joined and the call goes as written. */
  prepare?(call: CallParts, cfg: ProviderConfig): PreparedCall;
  /** Output tokens the availability probe allows; default 8. */
  probeTokens?: number;
};

const ADAPTERS = new Map<string, LlmAdapter>();

/** Adds an adapter, or replaces the one of the same kind. */
export function registerLlmAdapter(adapter: LlmAdapter) {
  ADAPTERS.set(adapter.kind, adapter);
}

export function llmAdapters(): LlmAdapter[] {
  return [...ADAPTERS.values()];
}

/** The adapter for a kind; an unknown kind is an error naming the known ones. */
export function llmAdapter(kind = "openai-compatible"): LlmAdapter {
  const adapter = ADAPTERS.get(kind);
  if (!adapter) throw new Error(`No LLM adapter of kind "${kind}"; registered: ${[...ADAPTERS.keys()].join(", ")}`);
  return adapter;
}

registerLlmAdapter(openAICompatibleAdapter);
registerLlmAdapter(anthropicAdapter);

export type Provider = ProviderConfig & {
  kind: string;
  languageModel: LanguageModel;
  available: boolean | null;
  latencyMs?: number;
  error?: string;
  /** Present when the adapter shapes calls; use shapeCall rather than calling it directly. */
  prepare?: (call: CallParts) => PreparedCall;
  probeTokens?: number;
  efforts?: Efforts;
};

/**
 * Names are the identifier, so they must be unique and are best written as
 * the model alone ("glm-5.3-flash"). Two providers serving the same model
 * from different hosts get a numbered suffix rather than silently shadowing
 * each other.
 */
function uniqueNames(configs: ProviderConfig[]): ProviderConfig[] {
  const seen = new Map<string, number>();
  return configs.map((c) => {
    const n = (seen.get(c.name) ?? 0) + 1;
    seen.set(c.name, n);
    return n === 1 ? c : { ...c, name: `${c.name} ${n}` };
  });
}

export function providersFromEnv(env = process.env): ProviderConfig[] {
  if (env.LENSPACK_LLM_PROVIDERS) return uniqueNames(JSON.parse(env.LENSPACK_LLM_PROVIDERS) as ProviderConfig[]);
  if (env.LENSPACK_LLM_BASE_URL && env.LENSPACK_LLM_API_KEY) {
    return [
      {
        name: env.LENSPACK_LLM_MODEL ?? "default",
        baseUrl: env.LENSPACK_LLM_BASE_URL,
        apiKey: env.LENSPACK_LLM_API_KEY,
        model: env.LENSPACK_LLM_MODEL ?? "gpt-4o-mini",
        extraBody: env.LENSPACK_LLM_EXTRA_BODY ? (JSON.parse(env.LENSPACK_LLM_EXTRA_BODY) as Record<string, unknown>) : undefined,
        pricing: env.LENSPACK_LLM_PRICING ? (JSON.parse(env.LENSPACK_LLM_PRICING) as Pricing) : undefined,
      },
    ];
  }
  return [];
}

/** A setting meant for another adapter would be dropped without a word; say so at startup instead. */
function refuseForeignKeys(cfg: ProviderConfig, adapter: LlmAdapter) {
  for (const other of ADAPTERS.values()) {
    if (other === adapter) continue;
    for (const key of other.ownKeys ?? []) {
      if (cfg[key] !== undefined && !adapter.ownKeys?.includes(key)) throw new Error(`Provider "${cfg.name}": ${key} is for ${other.kind} providers, and this one is ${adapter.kind}`);
    }
  }
}

/** `fetch` replaces the global one for this provider's requests (tests, proxies); it is not part of a JSON config. */
export function buildProvider({ fetch, ...cfg }: ProviderConfig & { fetch?: typeof globalThis.fetch }): Provider {
  const adapter = llmAdapter(cfg.kind);
  refuseForeignKeys(cfg, adapter);
  if (!cfg.baseUrl && !adapter.defaultBaseUrl) throw new Error(`Provider "${cfg.name}": a ${adapter.kind} provider needs a baseUrl`);
  const apiKey = cfg.apiKey ?? (cfg.apiKeyFile ? readFileSync(cfg.apiKeyFile, "utf8").trim() : undefined);
  const pricing = cfg.pricing ?? adapter.pricing?.(cfg);
  const languageModel = meterModel(adapter.build(cfg, { apiKey, fetch }), { provider: cfg.name, model: cfg.model, kind: adapter.kind, pricing, tokens: adapter.tokens });
  const prepare = adapter.prepare ? (call: CallParts) => adapter.prepare!(call, cfg) : undefined;
  return { ...cfg, kind: adapter.kind, apiKey: undefined, pricing, languageModel, available: null, prepare, probeTokens: adapter.probeTokens, efforts: adapter.efforts?.(cfg) };
}

/** The call as this provider wants it. Without an adapter hook, exactly the call as written, the system prompt joined. */
export function shapeCall(p: Pick<Provider, "prepare">, call: CallParts): PreparedCall {
  return p.prepare ? p.prepare(call) : { system: call.system.join(""), messages: call.messages, ...(call.tools ? { tools: call.tools } : {}) };
}

/** A tiny completion, so a provider that cannot serve the model is known before anyone asks it to build a board. */
export async function probe(p: Provider, timeoutMs = 20_000): Promise<Provider> {
  const started = Date.now();
  try {
    await withMeter({ role: "probe" }, () => generateText({ model: p.languageModel, prompt: "Reply with the single word: ok", maxOutputTokens: p.probeTokens ?? 8, abortSignal: AbortSignal.timeout(timeoutMs) }));
    return { ...p, available: true, latencyMs: Date.now() - started, error: undefined };
  } catch (e) {
    return { ...p, available: false, latencyMs: Date.now() - started, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  }
}

export function publicView(p: Provider) {
  return { name: p.name, kind: p.kind, model: p.model, available: p.available, latencyMs: p.latencyMs, error: p.error, priced: !!p.pricing, ...(p.efforts ? { efforts: p.efforts } : {}) };
}

/**
 * The effort a call to this provider runs at: the one asked for, else the
 * provider's default; undefined for a provider with no effort setting. An
 * effort the provider does not take is an error naming the ones it does.
 */
export function effortFor(p: Pick<Provider, "name" | "efforts">, wanted?: string | null): string | undefined {
  if (!p.efforts) return undefined;
  if (!wanted) return p.efforts.default;
  if (!p.efforts.levels.includes(wanted)) throw new Error(`effort "${wanted}" is not one ${p.name} takes: ${p.efforts.levels.join(", ")}`);
  return wanted;
}

// Calls that only look: a step of these beside a failure made no progress.
const READS = new Set(["get_board", "list_metrics", "list_values", "explain"]);

/**
 * Stops a tool loop that is going nowhere: when the last `n` steps each had a
 * refused or unparseable tool call and nothing but reads succeeded, the model
 * is retrying the same wrong idea and the turn should end so it can explain.
 */
export function stopOnRepeatedRefusals(n = 3) {
  type Step = { toolResults: { toolName?: string; output?: unknown }[]; content?: { type: string }[] };
  const refused = (o: { output?: unknown }) => {
    const v = o.output as { applied?: boolean; ok?: boolean } | undefined;
    return v?.applied === false || v?.ok === false;
  };
  return ({ steps }: { steps: Step[] }) => {
    if (steps.length < n) return false;
    return steps.slice(-n).every((st) => {
      const outs = st.toolResults ?? [];
      const failed = outs.some(refused) || (st.content ?? []).some((c) => c.type === "tool-error");
      return failed && outs.every((o) => refused(o) || READS.has(o.toolName ?? ""));
    });
  };
}
