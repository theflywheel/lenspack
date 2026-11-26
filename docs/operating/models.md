# Chat models

This page covers how to give Lenspack models: providers, the roles a model can play in a turn, and the two adapters
that ship. It is for operators. To add an adapter for another API, see [Add a model provider](../extending/model-adapter.md).

The chat that builds boards, its reviewer and the eval suite all talk to a model through a **provider**: a name, a model and the endpoint that serves it. A provider's `kind` picks its **adapter**, the way a source URL's scheme picks a SQL driver. The adapter turns the config into a model and shapes calls for that provider's API. Nothing else in Lenspack knows which API a model speaks.

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
| `pricing` | US$ per million tokens: `{ "input", "output", "cachedInput"?, "cacheWrite"?, "cacheWrite1h"? }`; see below |
| `maxOutputTokens` | the output cap for a call that sets none |
| `extraBody` | `openai-compatible` only: merged into every request body (e.g. OpenRouter's `reasoning`) |
| `anthropic` | `anthropic` only: see below |

A setting that belongs to another kind (`extraBody` on an Anthropic provider, `anthropic` on an OpenAI-compatible one) is refused at startup, so it is never silently ignored.

## Roles

A deployment can name different models for different parts of a turn:

| role | what it does | chosen by |
|---|---|---|
| builder | answers and makes the edits | the chat's model menu (`?model=`), else the first provider that answers its probe |
| `reviewer` | checks each edit against the request before it is saved | `?review=off` turns it off for a turn; else `LENSPACK_LLM_ROLES.reviewer`; else the builder |
| `escalate` | runs the fix round after a material finding | `?escalate=`; else `LENSPACK_LLM_ROLES.escalate`; else the builder |
| `router` | the small model that matches a new wording to a saved answer | `LENSPACK_LLM_ROLES.router`; see [Saved answers](../features/saved-answers.md) |
| daily review | reads the day's turns once a day | the review's settings (`claude-opus-5-5` by default); see [Daily review](../features/review.md#the-daily-review) |

The roles are parts of a chat turn. The builder (the model picked for the turn) makes the edits. The reviewer, a second call, checks them against the request before anything is saved, and marks each finding material (the board would mislead whoever reads it: wrong or double-counted numbers, a title that claims what the query does not do, a required filter missing, the wrong widget changed) or minor. A material finding gets one fix round on the escalation model (the builder when no role names one) and a second check; if the change is still wrong, nothing from the turn is saved and the reply says the board was left as it was. Minor findings are saved and mentioned in one sentence in the reply. With the reviewer switched off, edits are saved as they are made. While the reviewer is on, the edits a turn makes are drafts until it ends: the chat panel shows each as a draft, the audit log records each as a `chat-edit` line ending `→ draft v3` (the number it would have if saved), and one `chat-save` line then says which versions the turn saved, or that it saved none. The `chat-turn` line repeats this as `outcome` (`saved`, `left unchanged` or `not saved`) and `saved` (the version numbers).

A turn is reviewed when the board gained a version, or when it gained none but the reply may say it did: the model tried an edit (which was refused) or its reply says it added, removed, renamed or moved something, in any of the chat's languages. A question answered with no edit is not reviewed. The reply describes the board as the turn left it. Words the model writes before its first edit, and the whole answer to a question, appear as they are written. Words after an edit wait for the reviewer: they appear when the edit stands, and are replaced by the fix round's words when it does not, so a reply never says "I added the chart" and then "I removed the chart I added".

Where it already runs, the reviewer also checks that an answer said which reading it used when a question could be read two ways. A turn with an unstated or wrong reading is logged as an open question for an admin. With the `clarify` switch on, the builder gets a `clarify` tool to ask the user which reading they mean, with quick-reply buttons, or to say which one it used. A separate, optional daily review (the `daily-review` role, off by default and capped per run) reads the day's turns and proposes changes to the definitions. See [Daily review, open questions and definitions](../features/review.md).

## The adapters

### `openai-compatible`

Any endpoint that speaks the OpenAI chat-completions API: OpenRouter, vLLM, a model vendor's own gateway. A config written before `kind` existed is this kind and behaves exactly as it did.

### `anthropic`

Claude through Anthropic's Messages API (`@ai-sdk/anthropic`).

- **Key:** `apiKey`, then `apiKeyFile`, then the `ANTHROPIC_API_KEY` environment variable.
- **Endpoint:** `https://api.anthropic.com/v1` unless `baseUrl` names a proxy.
- **Prompt caching** is on by default. The chat re-sends the same tools, the same long system prompt (the pack's catalogue, examples and rules) and a growing conversation on every step of every turn. The adapter puts cache breakpoints on the last tool definition, at the end of the stable part of the system prompt, and on the conversation's tail in a tool loop, so later steps read those tokens from the cache at a tenth of the input price or less. The tools and the stable system prompt are kept for an hour, so a question asked a while after the last one still reads them from the cache; the tool loop's tail, which nothing reads after the turn, is kept for five minutes. Saved answers, which skip the model altogether for repeated questions, are described in [Saved answers](../features/saved-answers.md). The current board is the last part of the system prompt and sits after the stable breakpoint, so an edit that changes the board leaves the catalogue cached. The reviewer caches its fixed instructions but not the per-turn tail, which no later call would read. No other adapter sees any of this.
- **Thinking and effort.** On models that have it, thinking is adaptive and effort defaults to `medium` (Anthropic's suggested start for multi-step tool use; the API's own default is higher). Thinking counts toward the output cap, so a call that sets its own cap (the reviewer's 4000, the probe's few tokens) gets `thinkingAllowance` tokens on top. A call with no cap gets 16,000.
- **Effort per turn.** The chat takes `?effort=` (for example `POST /api/<pack>/<board>/chat?model=claude-sonnet-5-5&effort=high`). It applies to the chosen model for that turn, and to the fix round when that round uses the same model. A level the model does not take is refused with a 400 that lists the levels it does take. A model with no effort setting ignores the parameter. The reviewer always uses its own configuration. `GET /api` lists each model's `efforts` (`{ "levels": [...], "default": "medium" }`) so a client can offer only those levels. Models without an effort setting have no `efforts` field. The demo's chat panel shows an effort menu beside the model menu for such models and keeps the choice in the URL. Most Claude 5-generation models take `low` to `max`; Sonnet 4.6 has no `xhigh`; `between_tools` thinking goes up to `high`. The effort a call ran at is recorded with it (`effort` in the usage file and in the turn's cost lines) and in the `chat-turn` audit line.
- **Edited history.** On Claude 5.5-generation models a thinking block is valid only in the conversation that produced it, and Lenspack's history is edited every turn: the board in the system prompt changes, and older turns fall out of the `historyTurns` window. The adapter asks the API to drop a stale block rather than refuse the request (`block_binding: drop_block`). With `thinking: "between_tools"`, which cannot do that, it leaves earlier thinking out of the history instead.
- **Refusals.** On models that offer it, a turn Claude's safety checks decline is retried server-side on Anthropic's chosen fallback model (`fallbacks: "default"`). A turn that is still declined ends with a line saying so, not in silence.

```jsonc
"anthropic": {
  "effort": "medium",        // low | medium | high | xhigh | max
  "thinking": "adaptive",    // or "between_tools" (Sonnet 5.5's lowest setting)
  "display": "omitted",      // adaptive only: "summarized" or "updates" return thinking text
  "cache": true,             // false: no breakpoints
  "cacheTtl": "1h",          // the tools and stable prompt; "5m" for every breakpoint (writes cost 1.25x input instead of 2x)
  "fallbacks": "default",    // false: no server-side retry
  "thinkingAllowance": 4096
}
```

All of it is optional.

### Sonnet, ready to paste

```bash
LENSPACK_LLM_PROVIDERS='[{"name":"claude-sonnet-5-5","kind":"anthropic","model":"claude-sonnet-5-5","apiKeyFile":"/path/to/anthropic.key","pricing":{"input":2,"output":10,"cachedInput":0.2,"cacheWrite":2.5,"cacheWrite1h":4}}]'
```

The `pricing` here is Sonnet 5.5's published rate (US$2 input, $10 output, $0.20 cache read, $2.50 five-minute cache write, $4 one-hour cache write, per million tokens) and could be left out: the adapter knows it. The startup probe shows in `GET /api` under `models`: `available: true` means the key and model work.

## Keys at a glance

| variable | used for |
|---|---|
| `LENSPACK_LLM_PROVIDERS` | the providers, as a JSON array |
| `LENSPACK_LLM_ROLES` | which provider plays which role |
| `LENSPACK_LLM_BASE_URL`, `LENSPACK_LLM_API_KEY`, `LENSPACK_LLM_MODEL`, `LENSPACK_LLM_EXTRA_BODY`, `LENSPACK_LLM_PRICING` | a single OpenAI-compatible provider |
| `ANTHROPIC_API_KEY` | the `anthropic` adapter's key when a provider names none; alone, it offers Claude Sonnet 5.5, Opus 5.5 and Haiku 5.5 |
| `LENSPACK_STT_API_KEY`, else `OPENROUTER_API_KEY` | speech to text (see [Voice](../features/voice.md)) |

---

**Next:** [Costs and budgets](costs.md).

**Related:** [Turns](../concepts/turns.md#models-in-a-turn) · [The life of a turn](../architecture/life-of-a-turn.md) ·
[Add a model provider](../extending/model-adapter.md)
