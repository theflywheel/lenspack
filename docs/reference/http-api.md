# HTTP API

This page lists the HTTP routes Lenspack's servers answer: the board API, speech, usage, the admin API and the routes
the Superset host adds. It is for developers who call Lenspack from their own code or scripts. Every route checks the
caller's sign-in and rights first; see [Access and policy](../access/README.md).

All bodies are JSON unless said otherwise. Errors answer `{ "error": "…" }` with a status code. A pack or board the
caller may not open answers `404`, the same as one that is not there.

## Health

`GET /healthz` answers `{ "ok": true, … }` without sign-in, on `lenspack serve` and the Superset host (the demo has
none). Use it for liveness checks. `GET /readyz` answers `200 { "ready": true }` when the server can answer requests,
else `503 { "ready": false, "reason": "…" }` (the Superset host, while it is still starting: until it has reached
Superset, read the datasets and dashboards and been given the identity key; the reason says which step it is on and
when it tries again). Use it for readiness checks. While the Superset host is starting, every other route answers
`503 { "error": "…", "code": "starting" }` with a `Retry-After` header.

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
| `GET /api/<pack>/<board>/turn?key=<key>` | what one of the caller's own chat turns did, by the key its chat request sent: `{ version, turn: { state, from, to, changes, reply } }`, where `version` is the board's version now. `404` (still with `version`) when no turn is known under the key. See [Dashboard edits](../features/dashboard-edits.md#when-the-reply-is-cut-off) |
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

A chat turn takes the conversation (`messages`) and optional settings. `turnKey`, a key the client makes for each
question (8 to 64 letters, digits, `-` or `_`), makes asking again safe: the same key again is answered from what the
first asking did, without a model call, and its edits are not made twice. Query parameters choose models for the turn:
`?model=<provider>`, `?effort=<level>` (one of the levels `GET /api` lists for that model; another level answers
`400`), `?review=off`, `?escalate=<provider>`. See [Chat models](../operating/models.md).

### Examples

These run against `lenspack serve` over the `commerce` example pack, with `auth: { kind: none }`. Long SQL is cut
short (`…`).

**Compile a query without running it.** The query goes in `q`, as JSON:

```bash
curl -sG localhost:8787/api/commerce/explain \
  --data-urlencode 'q={"kind":"breakdown","dimension":"country","measure":"revenue","limit":5}'
```

```json
{ "ok": true, "source": "duckdb",
  "sql": "SELECT \"customers\".\"__d_country\" AS \"group\", sum(\"orders\".\"__m_revenue\") AS \"value\", count(*) AS \"n\"\nFROM (SELECT *, … FROM \"orders\") AS \"orders\"\nLEFT JOIN (SELECT *, … FROM \"customers\") AS \"customers\" ON \"orders\".\"customer_id\" = \"customers\".\"id\"\nGROUP BY …\nLIMIT 5",
  "native": "…the same SQL…", "entities": ["orders", "customers"], "approximate": false }
```

A query the pack cannot answer comes back as a refusal, with its [code](errors.md), the reason and the nearest key:

```bash
curl -sG localhost:8787/api/commerce/explain \
  --data-urlencode 'q={"kind":"breakdown","dimension":"category","measure":"revenue"}'
```

```json
{ "ok": false, "code": "FANOUT_REFUSED",
  "error": "\"category\" lives on \"products\", which has many rows per \"orders\" row; grouping a orders-level measure by it would multiply the numbers. Measure one of these instead: units, item_revenue. Or keep the measure and group by a dimension on \"orders\": status, channel.",
  "nearest": "units", "key": "category" }
```

**Edit a board.** Make a board, then add a widget to it:

```bash
curl -s -X POST localhost:8787/api/commerce/boards -H 'content-type: application/json' -d '{"title":"Shop"}'
# {"id":"b_ssm7b0d3","version":1}

curl -s -X POST localhost:8787/api/commerce/b_ssm7b0d3/ops -H 'content-type: application/json' -d '{"ops":[
  {"op":"add_widget","id":"revenue_by_country","placement":{"place":"top","width":"half","height":6},
   "widget":{"kind":"chart","chart":"bar","title":"Revenue by country",
             "query":{"kind":"breakdown","dimension":"country","measure":"revenue","limit":5}}}]}'
```

```json
{ "ok": true,
  "board": { "id": "b_ssm7b0d3", "pack": "commerce", "version": 2, "owner": "anonymous", "shared": false,
    "updatedAt": "2026-11-26T09:54:23.536Z",
    "config": { "version": 2, "pack": "commerce", "packVersion": 1, "title": "Shop",
      "grid": { "cols": 12, "rowHeight": 40, "density": "comfortable", "fill": false },
      "layout": [{ "i": "revenue_by_country", "x": 0, "y": 0, "w": 6, "h": 6 }],
      "widgets": { "revenue_by_country": { "title": "Revenue by country", "kind": "chart", "chart": "bar",
        "query": { "kind": "breakdown", "dimension": "country", "measure": "revenue", "limit": 5, "sort": "desc" },
        "options": { "legend": true, "colorScheme": "default" } } },
      "filters": [] } } }
```

An edit that fails a check answers `{ "ok": false, "opIndex": <n>, "error": "…", "hint": "<nearest key>" }`, and the
board does not change.

**Ask a question.** The body is the conversation in the AI SDK's message format. The answer is a stream of
server-sent events; its parts are listed in [Stream parts](stream-parts.md).

```bash
curl -N -X POST 'localhost:8787/api/commerce/b_ssm7b0d3/chat?effort=low' -H 'content-type: application/json' -d '{
  "messages": [{ "id": "m1", "role": "user", "parts": [{ "type": "text", "text": "Revenue by country, last 30 days" }] }]}'
```

A server with no chat model answers `{"error":"Chat is not configured on this server (LENSPACK_LLM_PROVIDERS)"}`.

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
`telemetry` switch is off. Admins read the records at `<prefix>/telemetry`, and what's recorded and the metrics worked out from it at
`<prefix>/telemetry/checklist`; fields are switched with `PUT <prefix>/settings/telemetry`. Every route and its rules are in
[Telemetry](../features/telemetry.md).

## Usage

`GET /api/_usage`, for callers with the usage right: what chat has cost since the server started, with the budget
caps when set. See [Costs](../operating/costs.md#metering).

The Superset host answers the same at `GET /_superset/usage`, an admin route, so an
[admin API key](../access/admin-api.md) can read spend without a Superset session (through Superset:
`/lenspack/_admin/usage`). It is read-only and for admins only; an admin who may not see user names gets the same
totals with no one named. `GET /api/_usage` itself stays closed to a key, as the chat and the data are.

What both return:

| field | what it is |
|---|---|
| `since` | when the count began (the oldest call read back from today's usage file, else the server's start) |
| `total` | since then: answers (`turns`), model calls, tokens and priced spend (`usd`), and calls with no price (`unpriced`) |
| `turns` | one row per day (UTC), person (`user`) and pack: answers, spend (`llm`), spend by model, role and effort, and the queries they ran |
| `packs` | every query each pack ran, board loads and chat tools alike |
| `budget` | when a cap is set: the caps (`usdPerDay`, `usdPerUserPerDay`), today (`day`), today's spend (`spent`) and each person's (`users`) |
| `limits` | when a question limit is set: the limits, who is at one or was refused today (`people`), and how many people were counted today |

## The admin API

For admins only, under the host's admin prefix: `/_lenspack` on the standalone server, `/_superset` inside Superset
(through Superset: `/lenspack/_superset`). A person who is not an admin gets `403`, and the attempt is written to the
audit log. Inside Superset, an [admin API key](../access/admin-api.md) (`Authorization: Bearer <key>`) reaches the
same routes at `/lenspack/_admin/<route>` through Superset with no Superset session, or at `/_admin/<route>` and
`/_superset/<route>` on Lenspack's own address. `GET <prefix>/whoami` says who the caller is and what they may do,
changing nothing. The admin panel itself is at `<prefix>/admin/`; see [The admin panel](../features/admin-panel.md).

The panel's own data, on both hosts:

| route | what it does |
|---|---|
| `<prefix>/admin/api/packs`, `…/overview` | the packs, and the Overview board |
| `<prefix>/admin/api/definitions`, `…/questions`, `…/proposals` | definitions, open questions and the model's pack proposals. See [Definitions and open questions](../concepts/definitions.md) |
| `<prefix>/admin/api/runs`, `…/review` | the daily review's runs and settings. See [Review](../features/open-questions.md#the-daily-review) |
| `<prefix>/admin/api/settings` | the switches, the review settings and the assistant's name; `POST …/settings/features` changes switches and `POST …/settings/brand` the name. See [Feature switches](../operating/switches.md) and [Naming the assistant](../features/naming.md) |
| `<prefix>/admin/api/usage` | the usage board's data |

The Superset host's settings, beside the panel:

| route | what it does |
|---|---|
| `GET /_superset/info` | what the chat panel needs to know: speech, languages, switches (any signed-in person) |
| `GET /_superset/settings` | every setting, for admins, with the `revision` they are at (also the `ETag`). Every settings change takes `If-Match` with it, and answers `409` (`code: "changed-elsewhere"`) when what it changes moved since. See [Changes made elsewhere](../hosts/superset/settings.md#changes-made-elsewhere) |
| `GET /_superset/settings/revision` | the settings' revision, the last change (section, who, when) and the pack's version, for an open admin page to notice changes made elsewhere |
| `PUT /_superset/settings/features`, `…/cache`, `…/queue`, `…/speech`, `…/language`, `…/chat`, `…/telemetry` | changes those settings. What each one takes is in [Settings and switches](../hosts/superset/settings.md#the-routes-behind-it) |
| `PUT /_superset/settings/brand` | the assistant's name, button label, per-language words, icon and "Powered by" line; `null` hands a field back. See [Naming the assistant](../features/naming.md) |
| `PUT /_superset/settings/personal`, `…/edit-scope` | personal-dashboard limits and where the chat may edit. See [Personal dashboards](../features/personal-dashboards.md#routes) |
| `GET`, `PUT /_superset/settings/tabs`; `GET /_superset/tabs`; `DELETE /_superset/tabs/<dashboard>/<tab>` | the tab rules, the tabs made through the chat with their makers, and an admin deleting one. See [Tabs on dashboards](../features/tabs.md#routes) |
| `GET /_superset/settings/speech/models` | the transcription models on offer |
| `GET`, `PUT /_superset/settings/pack`; `POST …/pack/validate`, `…/pack/revert`, `…/pack/reset`; `GET …/pack/versions`, `…/pack/versions/<n>`, `…/pack/diff`, `…/pack/export` | the pack's runtime parts (labels, measures, example questions and the rest): read, check, change, go back, reset to the config, compare versions and export as YAML. Admins. See [Changing the pack while it runs](../hosts/superset/pack-runtime.md) |
| `GET /_superset/turns`, `GET /_superset/audit` | recent turns and the audit log |
| `GET /_superset/usage` | what chat has cost: today, since the count began, by day and by person, with the caps and question limits; the same as `GET /api/_usage` (see [Usage](#usage)) |

### Saved answers and the queue

`GET <prefix>/cache`: totals since the store was started, the queue right now, the last refresh, and every entry.
`t1` to `t4` count answers by [tier](../features/saved-answers.md#the-tiers-cheapest-first): exact replay, plan
replay, slots and router. While saved answers are switched off, `on` is `false` and `entries` is empty; `stored`
still says how many are on disk, so they can be cleared.

```jsonc
{
  "on": true, "stored": 1,
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
- `POST <prefix>/cache/clear`: removes every saved answer at once and writes the file straight away, whether saved
  answers are on or off: `{ "ok": true, "removed": 12 }`. Written to the audit log (`cache clear`).
- `GET <prefix>/cache/suggestions?board=<id>`: the most-asked questions on a board, across every scope:
  `{ "board": "<id>", "suggestions": ["…"] }`. Optional `lang` and `limit` (8 by default). Empty while saved answers
  are off, as are `chart-candidates` and `boards`.
- `GET <prefix>/cache/chart-candidates`: questions asked often that no chart on their board answers: `{ "candidates": [{
  "id", "board", "question", "variants", "asks", "lastHit", "query": { "kind": "value", "measure": "…" } }] }`, most
  asked first. Optional `minAsks` (3) and `days` (14).
- `GET <prefix>/cache/boards`: how often each board changed, for settled boards:
  `{ "boards": [{ "board", "edits7d", "edits30d", "edits90d", "lastEdit", "settled" }] }`.
- `POST <prefix>/cache/prewarm`: refreshes now, and answers when done: `{ "ok": true, "run": { … } }` (`run` is
  `null` when saved answers are off).
- `POST <prefix>/cache/data-changed`, with an optional body `{ "pack": "<name>" }`: for a data pipeline to call after
  a load. Answers `202 { "ok": true, "scheduled": true }` at once; the refresh runs a few seconds later, and several
  calls close together make one refresh.

Inside Superset, the settings are read and changed with the other settings: `GET /_superset/settings` includes `cache`
(with `prewarm`) and `queue`; `PUT …/settings/cache` and `PUT …/settings/queue` take any of their settings (`prewarm` as
a partial object). See [Saved answers](../features/saved-answers.md) and [Busy hours](../features/busy-hours.md).

## Superset routes

Inside Superset, the plugin adds routes to Superset itself, and the Lenspack server adds a few of its own.

**Added to Superset by the plugin** (`lenspack_superset.py`):

| route | what it does |
|---|---|
| `/lenspack/…` | forwards to the Lenspack server, with the signed identity of the person asking |
| `GET /api/v1/lenspack/identity-key` | the key Lenspack checks signed identities with (admins and Lenspack's own account) |
| `GET /api/v1/lenspack/access?user=&datasets=&dashboards=` | a person's dataset access, row-level security and dashboard access (admins and Lenspack's own account) |
| `GET /api/v1/lenspack/version` | Superset's version, read by the server at start (admins and Lenspack's own account) |
| `POST /api/v1/lenspack/bootstrap` | the one-time step that makes Lenspack's own account (admins only) |
| `/ai-assistant/` | the settings page, with its `chat`, `speech`, `speech-hold`, `language` and `features` forms |

**On the Lenspack server**, below `publicPath`: the board API above (a dashboard is the board `superset-<id>`), the
admin API under `/_superset`, `/_superset/bind?dashboard=<id>` (ties the chat to a dashboard Superset checked) and
`/_superset/dashboards` (the dashboards this person may open), and the personal-dashboard and saved-layout routes
under `/_superset/my` (listed in [Personal dashboards](../features/personal-dashboards.md#routes)). How identity is
signed and checked is in [Who is asking](../hosts/superset/identity.md).

## MCP over HTTP

`lenspack-mcp --http` serves the Model Context Protocol's streamable HTTP transport, with a bearer token. See
[MCP server](../hosts/mcp.md#http).

---

**Next:** [Command line](cli.md).

**Related:** [Stream parts](stream-parts.md) · [Access and policy](../access/README.md) ·
[The standalone server](../hosts/serve.md)
