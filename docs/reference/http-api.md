# HTTP API

This page lists the HTTP routes Lenspack's servers answer: the board API, speech, usage, the admin API and the routes
the Superset host adds. It is for developers who call Lenspack from their own code or scripts. Every route checks the
caller's sign-in and rights first; see [Access and policy](../access/README.md).

All bodies are JSON unless said otherwise. Errors answer `{ "error": "…" }` with a status code. A pack or board the
caller may not open answers `404`, the same as one that is not there.

## Health

`GET /healthz` answers `{ "ok": true, … }` without sign-in. Use it for liveness checks.

## The board API

Under `/api`, on the standalone server (`lenspack serve`, the demo) and, below its `publicPath`, the Superset host.

| route | what it does |
|---|---|
| `GET /api` | the packs the caller may open, each with its boards, whether chat is on, the models, speech settings and, when signed in, `me` (`user`, `edit`, `maintain`, `usage`) |
| `GET /api/<pack>` | the pack's description, instructions, boards and catalogue as the caller may see it |
| `GET /api/<pack>/pack` | the pack file (`{ yaml }`); `403` for a caller some keys are hidden from |
| `GET /api/<pack>/explain?q=<query JSON>` | compiles one query without running it: the native query it would send, or the refusal |
| `POST /api/<pack>/boards` | a new board owned by the caller: `{ title?, config?, temporary? }` (temporary boards are for previews and evals, deleted after) |
| `GET /api/<pack>/<board>` | the board as the caller may see it. `?include=data,options` adds the widget data and filter options in one response |
| `GET /api/<pack>/<board>/data` | every widget's data under the current selections |
| `GET /api/<pack>/<board>/page?widget=<id>&page=<n>` | one page of a table's rows |
| `GET /api/<pack>/<board>/options?field=<dimension>` | the values a filter can pick |
| `GET /api/<pack>/<board>/suggestions?lang=` | the most-asked questions on this board by people with the same access: `{ "suggestions": ["…"] }` |
| `GET /api/<pack>/<board>/versions` | the board's versions |
| `POST /api/<pack>/<board>/ops` | applies edit operations: `{ "ops": [ … ] }`. See [Board format](board.md#edit-operations) |
| `POST /api/<pack>/<board>/layout` | saves a dragged layout: `{ layout, summary? }` |
| `POST /api/<pack>/<board>/share` | `{ "shared": true }` shares an owned board with others who may open the pack, `false` stops |
| `POST /api/<pack>/<board>/revert` | `{ "version": <n> }` restores a version as a new one |
| `POST /api/<pack>/<board>/copy` | makes the caller's own copy, as they are shown it: `{ title? }` |
| `DELETE /api/<pack>/<board>` | deletes an owned board |
| `POST /api/<pack>/<board>/chat` | one chat turn, answered as a stream. See [Stream parts](stream-parts.md) |

Selections from the filter bar travel as query parameters on the data routes. Every route but `GET` needs the edit
right, except a chat turn: a read-only caller may still ask questions, and the chat's edit tools refuse. Who may edit
which board is in [Rights](../access/rights.md#boards-have-owners).

A chat turn takes the conversation (`messages`) and optional settings. Query parameters choose models for the turn:
`?model=<provider>`, `?review=off`, `?escalate=<provider>`. See [Chat models](../operating/models.md).

## Speech

`POST /api/_stt` takes a raw audio body (up to 10 MB) and answers the text for the person to check before sending:
`{ text, model, …, clip }`. The `clip` id goes with the chat request that sends the text, so the turn's cost includes
the clip.

- `?language=<code>`: a hint. A transcript in another language's script answers `422 { "error": "wrong_script" }`.
- `?expected=en,fr&fallback=fr`: no hint, but the reader's languages. A transcript in none of their scripts is tried
  once more with the fallback; still wrong, `422 { "error": "unsure_language" }`.
- `503` when no transcription key is set, `429` over the budget, `413` for a clip too long.

See [Voice](../features/voice.md#the-route).

## Telemetry

`POST /api/_telemetry` takes the browser's events (a thumbs up or down, an answer left early); it answers 404 when the
`telemetry` switch is off. Admins read the records at `<prefix>/telemetry` and the switchboard at
`<prefix>/telemetry/checklist`, changed with `PUT <prefix>/settings/telemetry`. Every route and its rules are in
[Telemetry](../features/telemetry.md).

## Usage

`GET /api/_usage`, for callers with the usage right: what chat has cost since the server started, with the budget
caps when set. See [Costs](../operating/costs.md#metering).

## The admin API

For admins only, under the host's admin prefix: `/_lenspack` on the standalone server, `/_superset` inside Superset
(through Superset: `/lenspack/_superset`). A person who is not an admin gets `403`, and the attempt is written to the
audit log. The admin panel itself is at `<prefix>/admin/`; see [The admin panel](../features/admin-panel.md).

The panel's own data, on both hosts:

| route | what it does |
|---|---|
| `<prefix>/admin/api/packs`, `…/overview` | the packs, and the Overview board |
| `<prefix>/admin/api/definitions`, `…/questions`, `…/proposals` | definitions, open questions and the model's pack proposals. See [Definitions and open questions](../concepts/definitions.md) |
| `<prefix>/admin/api/runs`, `…/review` | the daily review's runs and settings. See [Review](../features/review.md#the-daily-review) |
| `<prefix>/admin/api/settings` | the switches and the review settings; `POST …/settings/features` changes switches. See [Feature switches](../operating/switches.md) |
| `<prefix>/admin/api/usage` | the usage board's data |

The Superset host's settings, beside the panel:

| route | what it does |
|---|---|
| `GET /_superset/info` | what the chat panel needs to know: speech, languages, switches (any signed-in person) |
| `GET /_superset/settings` | every setting, for admins |
| `PUT /_superset/settings/features`, `…/cache`, `…/queue`, `…/speech`, `…/language` | changes those settings. See [Feature switches](../operating/switches.md) |
| `GET /_superset/settings/speech/models` | the transcription models on offer |
| `GET /_superset/turns`, `GET /_superset/audit` | recent turns and the audit log |

### Saved answers and the queue

`GET <prefix>/cache`: totals since the store was started, the queue right now, the last refresh, and every entry.

```jsonc
{
  "stats": { "since": "2026-11-26T08:00:00.000Z", "turns": 120, "hits": { "t1": 40, "t2": 31, "t3": 9, "t4": 12 }, "misses": 28, "savedUsd": 1.92 },
  "queue": { "running": 3, "waiting": 0, "editsWaiting": 0, "turnSeconds": 11.5 },  // turnSeconds: recent average model turn
  "prewarm": { "at": "2026-11-26T06:30:04.000Z", "reason": "schedule", "pack": null, "entries": 24, "refreshed": 21, "rewritten": 2, "skipped": 1, "failed": 0, "spentUsd": 0.0011, "modelCalls": 2 },  // or null
  "entries": [
    {
      "id": "k3j9x2", "board": "overview", "question": "How many orders shipped today?",
      "variants": ["orders shipped today?"],          // other wordings served from it
      "kind": "answer",                                // or "edit"
      "hits": 14, "lastHit": "2026-11-26T09:41:00.000Z", "createdAt": "2026-11-25T07:02:00.000Z",
      "pinned": false, "tierCounts": { "t1": 6, "t2": 5, "t3": 0, "t4": 3 }, "dataAsOf": "2026-11-26T09:41:00.000Z",
      "lang": "en", "asks7d": 15                        // the question's language, and asks in the last 7 days
    }
  ]
}
```

- `POST <prefix>/cache/<id>/pin`, `/unpin`, `/evict`: answers `{ "ok": true, "id": "<id>", "action": "pin" }`, or
  `404` for an unknown id. Each is written to the audit log. A pinned entry does not expire and is never pushed out
  when the store is full.
- `GET <prefix>/cache/suggestions?board=<id>`: the most-asked questions on a board, across every scope:
  `{ "board": "<id>", "suggestions": ["…"] }`. Optional `lang` and `limit` (8 by default).
- `GET <prefix>/cache/chart-candidates`: questions asked often that no chart on their board answers:
  `{ "candidates": [{ "id", "board", "question", "variants", "asks", "lastHit", "query": { "kind": "value", "measure": "…" } }] }`,
  most asked first. Optional `minAsks` (3) and `days` (14).
- `GET <prefix>/cache/boards`: how often each board changed, for settled boards:
  `{ "boards": [{ "board", "edits7d", "edits30d", "edits90d", "lastEdit", "settled" }] }`.
- `POST <prefix>/cache/prewarm`: refreshes now, and answers when done: `{ "ok": true, "run": { … } }` (`run` is
  `null` when saved answers are off).
- `POST <prefix>/cache/data-changed`, with an optional body `{ "pack": "<name>" }`: for a data pipeline to call after
  a load. Answers `202 { "ok": true, "scheduled": true }` at once; the refresh runs a few seconds later, and several
  calls close together make one refresh.

Inside Superset, the settings are read and changed with the other settings: `GET /_superset/settings` includes
`cache` (with `prewarm`) and `queue`; `PUT …/settings/cache` and `PUT …/settings/queue` take any of their settings
(`prewarm` as a partial object). See [Saved answers](../features/saved-answers.md) and [Busy hours](../features/busy-hours.md).

## Superset routes

Inside Superset, the plugin adds routes to Superset itself, and the Lenspack server adds a few of its own.

**Added to Superset by the plugin** (`lenspack_superset.py`):

| route | what it does |
|---|---|
| `/lenspack/…` | forwards to the Lenspack server, with the signed identity of the person asking |
| `GET /api/v1/lenspack/identity-key` | the key Lenspack checks signed identities with |
| `GET /api/v1/lenspack/access?user=&datasets=&dashboards=` | a person's dataset access, row-level security and dashboard access, for Lenspack's own account only |
| `GET /api/v1/lenspack/version` | Superset's version, read by the server at start (admins and Lenspack's own account) |
| `POST /api/v1/lenspack/bootstrap` | the one-time step that makes Lenspack's own account |
| `/ai-assistant/` | the settings page, with its `chat`, `speech`, `speech-hold`, `language` and `features` forms |

**On the Lenspack server**, below `publicPath`: the board API above (a dashboard is the board `superset-<id>`), the
admin API under `/_superset`, `/_superset/bind?dashboard=<id>` (ties the chat to a dashboard Superset checked) and
`/_superset/dashboards` (the dashboards this person may open). How identity is signed and checked is in
[Who is asking](../hosts/superset/identity.md).

## MCP over HTTP

`lenspack-mcp --http` serves the Model Context Protocol's streamable HTTP transport, with a bearer token. See
[MCP server](../hosts/mcp.md#http).

---

**Next:** [Command line](cli.md).

**Related:** [Stream parts](stream-parts.md) · [Access and policy](../access/README.md) ·
[The standalone server](../hosts/serve.md)
