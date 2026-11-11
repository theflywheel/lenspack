# Chat models

The chat that builds boards, its reviewer and the eval suite all talk to a model through a **provider**: a name, a model and the endpoint that serves it. A provider's `kind` picks its **adapter**, the way a source URL's scheme picks a SQL driver. The adapter turns the config into a model and shapes calls for that provider's API. Nothing else in lenspack knows which API a model speaks.

## Configuring providers

Providers come from the environment, as a JSON array in order of preference. The first one that answers its startup probe is the default; the others can be picked in the chat's model menu or by role.

```bash
LENSPACK_LLM_PROVIDERS='[
  {"name": "claude-sonnet-5-5", "kind": "anthropic", "model": "claude-sonnet-5-5", "apiKeyFile": "/etc/lenspack/anthropic.key"},
  {"name": "glm-4.5", "baseUrl": "https://openrouter.ai/api/v1", "apiKeyFile": "/etc/lenspack/openrouter.key", "model": "z-ai/glm-4.5"}
]'
LENSPACK_LLM_ROLES='{"reviewer": "claude-sonnet-5-5", "escalate": "claude-sonnet-5-5"}'   # optional
```

A single OpenAI-compatible provider can still be given as `LENSPACK_LLM_BASE_URL`, `LENSPACK_LLM_API_KEY`, `LENSPACK_LLM_MODEL` (and `LENSPACK_LLM_EXTRA_BODY`, `LENSPACK_LLM_PRICING`).

Providers live in the environment rather than in `lenspack.yaml` because they carry keys and per-deployment prices; the config file describes data.

| field | |
|---|---|
| `name` | how the UI, roles and the usage ledger refer to it; unique (a repeat gets a numbered suffix) |
| `kind` | the adapter: `openai-compatible` (the default) or `anthropic` |
| `model` | the model id the endpoint expects |
| `baseUrl` | the endpoint; required for `openai-compatible`, optional for `anthropic` (a proxy or gateway, ending in `/v1`) |
| `apiKey` / `apiKeyFile` | the key, or a file holding it (read once at startup, so it stays out of unit files) |
| `headers` | extra request headers |
| `pricing` | US$ per million tokens: `{ "input", "output", "cachedInput"?, "cacheWrite"? }`; see below |
| `maxOutputTokens` | the output cap for a call that sets none |
| `extraBody` | `openai-compatible` only: merged into every request body (e.g. OpenRouter's `reasoning`) |
| `anthropic` | `anthropic` only: see below |

A setting that belongs to another kind (`extraBody` on an Anthropic provider, `anthropic` on an OpenAI-compatible one) is refused at startup, so it is never silently ignored.

## The adapters

### `openai-compatible`

Any endpoint that speaks the OpenAI chat-completions API: OpenRouter, vLLM, a model vendor's own gateway. A config written before `kind` existed is this kind and behaves exactly as it did.

### `anthropic`

Claude through Anthropic's Messages API (`@ai-sdk/anthropic`).

- **Key:** `apiKey`, then `apiKeyFile`, then the `ANTHROPIC_API_KEY` environment variable.
- **Endpoint:** `https://api.anthropic.com/v1` unless `baseUrl` names a proxy.
- **Prompt caching** is on by default. The chat re-sends the same tools, the same long system prompt (the pack's catalogue, examples and rules) and a growing conversation on every step of every turn. The adapter puts cache breakpoints on the last tool definition, at the end of the stable part of the system prompt, and on the conversation's tail in a tool loop, so later steps read those tokens from the cache at a tenth of the input price or less. The current board is the last part of the system prompt and sits after the stable breakpoint, so an edit that changes the board leaves the catalogue cached. The reviewer caches its fixed instructions but not the per-turn tail, which no later call would read. No other adapter sees any of this.
- **Thinking and effort.** On models that have it, thinking is adaptive and effort defaults to `medium` (Anthropic's suggested start for multi-step tool use; the API's own default is higher). Thinking counts toward the output cap, so a call that sets its own cap (the reviewer's 4000, the probe's few tokens) gets `thinkingAllowance` tokens on top. A call with no cap gets 16,000.
- **Effort per turn.** The chat takes `?effort=` (for example `POST /api/<pack>/<board>/chat?model=claude-sonnet-5-5&effort=high`). It applies to the chosen model for that turn, and to the heal round when that round uses the same model. A level the model does not take is refused with a 400 that lists the levels it does take. A model with no effort setting ignores the parameter. The reviewer always uses its own configuration. `GET /api` lists each model's `efforts` (`{ "levels": [...], "default": "medium" }`) so a client can offer only those levels. Models without an effort setting have no `efforts` field. The demo's chat panel shows an effort menu beside the model menu for such models and keeps the choice in the URL. Most Claude 5-generation models take `low` to `max`; Sonnet 4.6 has no `xhigh`; `between_tools` thinking goes up to `high`. The effort a call ran at is recorded with it (`effort` in the usage file and in the turn's cost lines) and in the `chat-turn` audit line.
- **Edited history.** On Claude 5.5-generation models a thinking block is valid only in the conversation that produced it, and lenspack's history is edited every turn: the board in the system prompt changes, and older turns fall out of the `historyTurns` window. The adapter asks the API to drop a stale block rather than refuse the request (`block_binding: drop_block`). With `thinking: "between_tools"`, which cannot do that, it leaves earlier thinking out of the history instead.
- **Refusals.** On models that offer it, a turn Claude's safety checks decline is retried server-side on Anthropic's chosen fallback model (`fallbacks: "default"`). A turn that is still declined ends with a line saying so, not in silence.

```jsonc
"anthropic": {
  "effort": "medium",        // low | medium | high | xhigh | max
  "thinking": "adaptive",    // or "between_tools" (Sonnet 5.5's lowest setting)
  "display": "omitted",      // adaptive only: "summarized" or "updates" return thinking text
  "cache": true,             // false: no breakpoints
  "cacheTtl": "5m",          // "1h" keeps entries across longer pauses; writes cost 2x input instead of 1.25x
  "fallbacks": "default",    // false: no server-side retry
  "thinkingAllowance": 4096
}
```

All of it is optional.

### Sonnet, ready to paste

```bash
LENSPACK_LLM_PROVIDERS='[{"name":"claude-sonnet-5-5","kind":"anthropic","model":"claude-sonnet-5-5","apiKeyFile":"/path/to/anthropic.key","pricing":{"input":2,"output":10,"cachedInput":0.2,"cacheWrite":2.5}}]'
```

The `pricing` here is Sonnet 5.5's published rate (US$2 input, $10 output, $0.20 cache read, $2.50 five-minute cache write, per million tokens) and could be left out: the adapter knows it. The startup probe shows in `GET /api` under `models`: `available: true` means the key and model work.

## Adding an adapter

An adapter is an object registered once, before providers are built:

```ts
import { registerLlmAdapter, type LlmAdapter } from "@lenspack/serve";

const mine: LlmAdapter = {
  kind: "my-api",
  defaultBaseUrl: "https://api.example.com/v1", // omit to require baseUrl
  ownKeys: [],                                   // config keys only this kind reads
  build(cfg, { apiKey, fetch }) {                // returns an AI SDK LanguageModel
    return createMyProvider({ baseURL: cfg.baseUrl, apiKey, fetch })(cfg.model);
  },
  pricing: (cfg) => undefined,                   // published prices, if known
  prepare: undefined,                            // reshape calls (cache markers); absent, calls go as written
  efforts: (cfg) => undefined,                   // { levels, default } if the model has an effort setting
};
registerLlmAdapter(mine);
```

`prepare` receives the system prompt in parts, stable first and the part that changes most last, with the messages and tools, and returns what `generateText` / `streamText` take. Callers go through `shapeCall(provider, call)`, which joins the parts into one string when an adapter has no `prepare`, so the adapters that need no shaping receive exactly what they always did. A call's `effort` arrives in `prepare` as `call.effort`. Only an adapter that declares `efforts` is given one.

## Metering

Metering happens at the model, not at the call site. `buildProvider` wraps every provider's model, whatever its adapter, so every call is recorded: chat rounds, the reviewer, the startup probe, evals, the visual judge. A new adapter is metered without writing any metering code. It only declares `pricing(cfg)` for the models it knows, and, if its provider reports usage in an unusual way, `tokens(usage)`.

- **Generate calls** are recorded when they return or throw.
- **Streaming calls** are recorded when their finish part passes, or when they error or are cancelled.
- **Each step of a tool loop** is its own call.

### What a call costs

A call is priced from the provider's `pricing`. Without one, the adapter's table of published prices is used. Without either, the call is counted in tokens and reported as **unpriced**: its record has `usd: null` and `priced: false`, so it never shows as $0. Uncached input, cache reads and cache writes are each charged at their own rate. A cache rate missing from a price is charged as plain input.

### Who a call is for

Attribution comes from a scope that wraps the code making the calls, and it rides through the SDK's tool loop:

```ts
import { withMeter } from "@lenspack/serve";

await withMeter({ role: "build", user, pack, board, turn }, () => streamText({ model: provider.languageModel, ... }));
```

- **Roles:** `build`, `escalate`, `review`, `probe`, `eval`, `judge` and `other`.
- **Effort:** a scope may also name the `effort` its calls run at. The chat sets it for each round and for the review.
- **Nesting:** scopes nest, so a round's `role` sits inside a turn's `user`, `pack`, `board` and `turn`. A scope can also collect its own calls (`collect: []`) and add sinks.
- **No scope:** a call made outside any scope is still counted, as `other`.
- **Where calls go:** every call goes to the process-wide sinks (`addUsageSink`) and to the sinks of the scopes it runs in. Each sink receives a call once.

### Where calls go

A sink is `{ record(call) }`. lenspack ships two.

**The ledger** keeps totals by UTC day, user and pack, with breakdowns by provider and role and each pack's query counts (board loads included). It is served at **`GET /api/_usage`**, for maintainers only because it names every user.

**The usage file** is append-only JSONL with one line per call, so usage survives restarts. Name it in `lenspack.yaml` (the path is relative to the config file):

```yaml
usage: ./usage.jsonl
```

```json
{"at":"2026-11-11T09:12:03.120Z","provider":"claude-sonnet-5-5","model":"claude-sonnet-5-5","kind":"anthropic","role":"build","user":"someone","pack":"ops","board":"overview","turn":"5b0c…","effort":"medium","inputTokens":9120,"cachedInputTokens":8400,"cacheWriteTokens":600,"outputTokens":212,"reasoningTokens":90,"usd":0.005,"priced":true,"ms":2310,"ok":true}
```

At startup the ledger reads today's lines back from the end of the file, so neither the totals nor the budget reset on a restart. A failed call has `"ok": false` and an `error`.

Each chat turn also gets a summary of its own calls, one line per role and provider. The stream carries it as a `data-usage` part; the demo shows it as one muted line under the reply with tokens, dollars and queries. The audit log carries it as the `cost` field of the `chat-turn` line.

```json
{
  "since": "2026-11-11T00:00:04.000Z",
  "total": { "turns": 12, "calls": 30, "failed": 0, "inputTokens": 412000, "cachedInputTokens": 351000, "cacheWriteTokens": 41000, "outputTokens": 5200, "reasoningTokens": 1900, "usd": 0.31, "unpriced": 0 },
  "packs": { "ops": { "queries": 88, "failed": 0, "ms": 5120, "rows": 1400 } },
  "turns": [{ "day": "2026-11-11", "user": "someone", "pack": "ops", "turns": 12, "llm": { "…": "as total" }, "byProvider": { "claude-sonnet-5-5": { "…": "as total" } }, "byRole": { "build": { "…": "as total" }, "review": { "…": "as total" } }, "queries": { "queries": 40, "failed": 0, "ms": 2300, "rows": 610 } }]
}
```

The startup probes have no user or pack, so they appear under `"-"`.

### A budget

Before putting a paid key behind a server other people use, cap the spend:

```yaml
budget:
  usdPerDay: 20          # everyone together, per UTC day
  usdPerUserPerDay: 2    # each signed-in user
```

When today's metered spend reaches a cap, the chat answers **429** with a message saying so and when the budget resets (00:00 UTC). It answers before any model call, and the refusal is audited. Both caps are optional, and there is no budget unless one is set.

- **What counts:** only priced spend. At startup the server warns if a provider has no price, because its calls cannot count toward the budget.
- **Probes:** they have no user, so they count toward the server's cap but never toward a user's.
- **Overshoot:** the check runs before each turn, so the last turn under the cap can finish above it, by at most one turn's cost.
- **Restarts:** with `usage:` set, the budget carries across restarts. Without it, a restart starts the day's count from zero.

### Evals

`pnpm eval` runs in the same scopes: `eval` for the build, `review`, `escalate` for the heal round and `judge` for the visual check. Each task's result in `evals/results/*.json` carries `usage`, with the total and one line per role and provider. The markdown table adds tokens in and out and the cost per model.
