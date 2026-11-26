# Stream parts

This page lists what a chat turn sends back while it runs. It is for developers writing their own chat client
against `POST /api/<pack>/<board>/chat`.

A chat turn answers as a stream in the Vercel AI SDK's UI message stream format (server-sent events), so its client
libraries (`useChat`, `readUIMessageStream`) read it as they are. Besides the standard parts (text, reasoning, tool
calls and their results, `finish`), Lenspack adds its own `data-*` parts.

| part | when | data |
|---|---|---|
| `data-round` | a model round starts | `{ round, builder, effort? }`: which model is building, and with what effort |
| `data-status` | while the reviewer reads the edits (every 10 seconds; transient) | `{ phase: "reviewing" }` |
| `data-review` | the reviewer has checked a round's edits | `{ round, reviewer, … }`: its verdict and findings, each marked material or minor. See [The reviewer](../features/dashboard-edits.md#the-reviewer) |
| `data-clarify` | the model asked a question with ready answers | `{ question, options }`: the quick replies to show as buttons. See [Clarify](../features/open-questions.md#clarify) |
| `data-reuse` | the answer came from a saved answer | the saved-answer line (`tier`, the money saved, how fresh the data is). See [Saved answers](../features/saved-answers.md) |
| `data-queue` | the turn is waiting, or turned away | waiting (transient, not kept in the message): `{ state: "waiting", reason: "busy" \| "edit", position, etaSeconds }`; turned away: `{ state: "full", why: "full" \| "timeout", retryAfterSeconds }`, followed by the same message as text so any client can show it. See [Busy hours](../features/busy-hours.md) |
| `data-answer-card` | the turn read data | the answer card behind "How this was worked out": each data call in plain words, the measures behind each figure, the SQL that ran and the rows. The browser keeps it beside the conversation and never sends it back. See [How this was worked out](../features/explain.md) |
| `data-usage` | at the end of every turn | `{ total, models, queries, summary }`: tokens and dollars by role and provider, the queries the tools ran, and a one-line summary. See [Costs](../operating/costs.md#metering) |

A transient part is shown while the turn runs and not stored in the message.

Telemetry reads some of these parts in the browser to fill one record per turn. See
[Telemetry](../features/telemetry.md).

---

**Next:** [Refusal codes](errors.md).

**Related:** [HTTP API](http-api.md#the-board-api) · [Turns](../concepts/turns.md) ·
[The life of a turn](../architecture/life-of-a-turn.md)
