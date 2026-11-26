# Costs and budgets

This page covers what Lenspack spends on models, how every call is metered, where the figures go, and how to cap a
day's spend. It is for operators and whoever pays the model bill.

## Where the money goes

Every chat turn that reaches a model costs money: the builder's rounds, the reviewer when the turn edited, a fix
round when the reviewer found a problem, and a small-model call when a question is matched to a saved answer.
Transcriptions cost per minute of audio. The daily review, when on, costs up to its cap per run. Lenspack spends less
in three ways:

- **[Saved answers](../features/saved-answers.md)** answer repeated questions with no model call; their page has an
  estimate of what they save.
- **Prompt caching** (below) makes the long, unchanging part of every call cheap.
- **Turning parts off**: the reviewer costs a call per edit; voice costs per minute; see
  [Feature switches](switches.md).

The chat shows each turn's cost under the reply (the `turnCost` switch hides it), and admins see spend on the usage
board and at `GET /api/_usage`.

## Metering

Metering happens at the model, not at the call site. `buildProvider` wraps every provider's model, whatever its adapter, so every call is recorded: chat rounds, the reviewer, the startup probe, evals. A new adapter is metered without writing any metering code. It only declares `pricing(cfg)` for the models it knows, and, if its provider reports usage in an unusual way, `tokens(usage)`.

- **Generate calls** are recorded when they return or throw.
- **Streaming calls** are recorded when their finish part passes, or when they error or are cancelled.
- **Each step of a tool loop** is its own call.

### What a call costs

A call is priced from the provider's `pricing`. Without one, the adapter's table of published prices is used. Without either, the call is counted in tokens and reported as **unpriced**: its record has `usd: null` and `priced: false`, so it never shows as $0. Uncached input, cache reads and cache writes are each charged at their own rate. When the provider reports how many writes were for the one-hour cache (Anthropic does), those are charged at `cacheWrite1h` and the rest at `cacheWrite`. A cache rate missing from a price is charged as plain input, and a missing `cacheWrite1h` as `cacheWrite`.

### Who a call is for

Attribution comes from a scope that wraps the code making the calls, and it rides through the SDK's tool loop:

```ts
import { withMeter } from "@lenspack/serve";

await withMeter({ role: "build", user, pack, board, turn }, () => streamText({ model: provider.languageModel, ... }));
```

- **Roles:** `build`, `escalate`, `review`, `reuse` (the small calls that match a question to a saved answer or rewrite its reply; see [Saved answers](../features/saved-answers.md)), `probe`, `eval`, `judge` and `other`.
- **Effort:** a scope may also name the `effort` its calls run at. The chat sets it for each round and for the review.
- **Nesting:** scopes nest, so a round's `role` sits inside a turn's `user`, `pack`, `board` and `turn`. A scope can also collect its own calls (`collect: []`) and add sinks.
- **No scope:** a call made outside any scope is still counted, as `other`.
- **Where calls go:** every call goes to the process-wide sinks (`addUsageSink`) and to the sinks of the scopes it runs in. Each sink receives a call once.

### Where calls go

A sink is `{ record(call) }`. Lenspack ships two.

**The ledger** keeps totals by UTC day, user and pack, with breakdowns by provider, role and (where a call recorded one) effort, and each pack's query counts (board loads included). It is served at **`GET /api/_usage`**, for maintainers only because it names every user. On an open server (`auth: { kind: none }`) everyone counts as a maintainer. The demo shows it on its Usage page, from the profile menu.

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
  "turns": [{ "day": "2026-11-11", "user": "someone", "pack": "ops", "turns": 12, "llm": { "…": "as total" }, "byProvider": { "claude-sonnet-5-5": { "…": "as total" } }, "byRole": { "build": { "…": "as total" }, "review": { "…": "as total" } }, "byEffort": { "claude-sonnet-5-5": { "medium": { "…": "as total" } } }, "queries": { "queries": 40, "failed": 0, "ms": 2300, "rows": 610 } }],
  "budget": { "usdPerDay": 20, "usdPerUserPerDay": 2, "day": "2026-11-11", "spent": 0.31, "users": { "someone": 0.31 } }
}
```

`budget` is there only when one is set (below): the caps, and today's priced spend against them, the server's and each user's.

The startup probes have no user or pack, so they appear under `"-"`.

## A budget

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

## Evals

`pnpm eval` runs in the same scopes: `eval` for the build, `review`, and `escalate` for the heal round. Each task's result in `evals/results/*.json` carries `usage`, with the total and one line per role and provider. The markdown table adds tokens in and out and the cost per model.

## Prompt caching

Separate from saved answers, the Anthropic adapter marks the parts of every call that do not change (the tools, the pack's catalogue and rules) for Anthropic's prompt cache. These are now kept for **one hour** instead of five minutes, so a question that comes in 20 minutes after the last one still reads them from the cache at a tenth of the input price. Writing to the one-hour cache costs twice the input price (five-minute writes cost 1.25 times), so it pays for itself after about two reads. The part that grows during one turn (the conversation inside a tool loop) keeps the five-minute cache, since nothing reads it after the turn. `cacheTtl: "5m"` in the provider's `anthropic` settings goes back to five minutes everywhere. Metering charges one-hour and five-minute cache writes each at their own price, from the breakdown Anthropic reports. See [Chat models](models.md#anthropic).


---

**Next:** [Feature switches](switches.md).

**Related:** [Chat models](models.md) · [Saved answers](../features/saved-answers.md) · [The admin panel](../features/admin-panel.md)
