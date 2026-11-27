# Settings and switches in Superset

This page covers what an admin can change on a running Lenspack: the settings page, its routes, the switches, and
what happens when Lenspack cannot save. It is for Superset admins. Who counts as an admin is Lenspack's `auth.admins`
rule, by default Superset's Admin role (see [Who is asking](identity.md#who-may-administer)).

## The settings page

**Settings → Manage → AI assistant** (`/ai-assistant/`) opens for anyone Lenspack calls an admin, Superset admin or
not; Lenspack refuses it to anyone else, Superset admins included. Its menu entry shows to Superset's admins and to
Lenspack's admins (see [The menu entry](../../features/admin-panel.md#the-menu-entry)). What the page shows depends on
`admin.surface` (see [Where the admin pages are](../../features/admin-panel.md#where-the-admin-pages-are)). It holds the chat and speech
models, languages, switches, spend, cost per answer and the audit log, and links to the
[admin panel](../../features/admin-panel.md) (`/lenspack/_superset/admin/`, or below `LENSPACK_PATH`). Its menu
entry and heading say the assistant's name once it has one (see
[Naming the assistant](../../features/naming.md#superset)), and so does the page's text. On Superset 6.1 it has its own page
frame with a link back to Superset, light or dark as Superset is; on 5.0 it sits inside Superset's server-drawn page.

Values set here are kept in `settings.json` beside the board state and win over the config file and the
environment. Which options can change here, which can only be narrowed and which stay in the deploy config is in one
table on [What can change without a redeploy](runtime.md). A page holding an old copy picks up a change on its next dashboard load. Changes to the pack itself
(labels, measures, example questions and the rest of the overlay's runtime parts) are kept as versions in
`pack-layer.json`; see [Changing the pack while it runs](pack-runtime.md).

## Voice and language

`speech.model` (default `mistralai/voxtral-mini-transcribe-3-0`), `speech.holdMs` (2000), `speech.maxSeconds` (60)
and `language.default` (`auto`), `language.titles` (`board`), `language.board` (`en`) in `superset.yaml` are
defaults. An admin changes them on the settings page. What they do is in [Voice](../../features/voice.md) and
[Languages](../../features/languages.md).

## The routes behind it

Reads and writes need an admin's signed identity, by the `auth.admins` rule (see [Who is asking](identity.md)).

| route | what it does |
|---|---|
| `GET /_superset/settings` | everything below, each with its value, default and source. Includes `speech` {enabled, keyFrom, model, defaultModel, source, holdMs, defaultHoldMs, holdMsRange, writable}, `language` {default, titles, board, options, defaults, source, writable} and `features` {values, defaults, source, options, writable} |
| `GET /_superset/settings/speech/models` | the provider's transcription models with a price per minute (cached an hour) |
| `PUT /_superset/settings/speech` | any of `{model, holdMs, maxSeconds}`; a field left out is kept, `null` puts it back to the default |
| `PUT /_superset/settings/language` | any of `{default, titles, board}`; `null` resets a field |
| `PUT /_superset/settings/features` | any of `{<switch>: true \| false \| null}`; `null` drops the admin's value |
| `PUT /_superset/settings/cache` | any of `{enabled, ttlHours, router, maxEntries, freshMinutes, prewarm}` for [saved answers](../../features/saved-answers.md); `null` resets a field |
| `PUT /_superset/settings/queue` | any of `{maxConcurrent, maxWaiting, maxWaitSeconds}` for [busy hours](../../features/busy-hours.md) |
| `PUT /_superset/settings/chat` | `{model, effort}`: the chat model used when the panel asks for none, and its reasoning effort; `{model: null}` goes back to the default |
| `PUT /_superset/settings/telemetry` | any of `{"telemetry", "fields.<field>": true \| false \| null, "categories.<category>": true \| false, "retentionDays": n}`; turning on a privacy-sensitive field also needs `"confirm": true`, or the answer is `409` and nothing changes. See [Telemetry](../../features/telemetry.md#privacy-sensitive-fields) |
| `GET /_superset/cache` and below | saved answers: stats, queue, last refresh, entries, pin, unpin, evict, suggestions, chart candidates, settled boards |
| `POST /_superset/cache/prewarm`, `POST /_superset/cache/data-changed` | refresh the most-asked saved answers now, or a few seconds after a data load |
| `PUT /_superset/settings/brand` | any of `{name, buttonLabel, i18n, icon, poweredBy}` ([naming the assistant](../../features/naming.md)); `null` hands a field back to the deployment |
| `PUT /_superset/settings/personal` | any of `{maxDashboardsPerUser, maxSavedConfigsPerUser}` for [personal dashboards](../../features/personal-dashboards.md); `null` resets |
| `PUT /_superset/settings/edit-scope` | any of `{scope: "superset" \| "own", adminsExempt}`; `null` resets |
| `PUT /_superset/settings/budget` | any of `{usdPerDay, usdPerUserPerDay}` in US dollars (`0`: no cap); `null` hands a cap back to the deploy config |
| `PUT /_superset/settings/models` | `{offered: [<model names>], roles: {reviewer, escalate, router}}`: which of the deployment's models answer, and which plays each role; `null` resets |
| `PUT /_superset/settings/audit` | `{retentionDays}`: from 30 (or the deploy config's own, if shorter) to 3650; `null` resets |
| `PUT /_superset/settings/history` | `{historyTurns}`: 1 to 50; `null` resets |
| `PUT /_superset/settings/explain` | `{sql: true \| false \| null}`: whether "How this was worked out" shows the SQL |
| `PUT /_superset/settings/context` | `{context: {…}}`: the telemetry labels as a whole, or `{context: null}` for the deploy config's |
| `PUT /_superset/settings/panel` | `{panel: "float" \| "dock" \| null}`: how the chat opens |
| `PUT /_superset/settings/admin-surface` | `{surface: "split" \| "superset" \| "separate" \| null}`: where the admin pages are |
| `GET /_superset/settings/pack` | the pack's runtime parts as they run (description, instructions, labels, hints, measures, examples, notDimensions, hierarchies, exclusions), the version in force and where each part comes from. See [Changing the pack while it runs](pack-runtime.md) |
| `POST /_superset/settings/pack/validate`, `PUT /_superset/settings/pack` | check, or save, a change: `{ yaml }` (all the runtime parts) or `{ fields }` (only those named; `null` hands one back to the config), with an optional `why` and the `version` read. A change that adds a problem is refused with nothing changed |
| `GET /_superset/settings/pack/versions`, `…/versions/<n>`, `…/diff?from=&to=` | the pack's versions, newest first, one of them, or what differs between two |
| `POST /_superset/settings/pack/revert`, `POST /_superset/settings/pack/reset` | `{ version }`: go back to a version; `{ fields }` (or `{}` for all): hand parts back to the config |
| `GET /_superset/settings/pack/export` | the whole overlay as it runs, as YAML for `superset.yaml` |
| `GET /_superset/turns?limit=N` | the newest chat turns with their cost, and the totals for today and the last 7 days |
| `GET /_superset/audit?month=YYYY-MM&limit=N` | the audit log |
| `GET /_superset/telemetry`, `GET /_superset/telemetry/checklist` | the usage records and the switchboard. See [Telemetry](../../features/telemetry.md#reading-it) |

`/_superset/info` is for every signed-in user and returns what the chat panel needs, including `features` (the
effective switches) and the example questions. The whole list of routes is in
[HTTP API](../../reference/http-api.md#superset-routes).

## Switches

Every switch from [Feature switches](../../operating/switches.md) applies in Superset. In the `features` part of
`GET /_superset/settings`, `defaults` is what the deployment says without the admin, `source` is `default`,
`config`, `env` or `settings` per switch, and `options` gives each switch's label and help text. The page can turn
back on a switch the environment set off; `null` hands it back to the environment.

The `overlay`, `spaceHold`, `languageMenu`, `markdown`, `inPlaceRefresh` and `newChat` switches are enforced by
the page; the rest by the server.

## Usage telemetry

Each chat turn, transcription and client event (a thumbs up or down, an answer left early) leaves a record in
`telemetry.jsonl` in the state directory. The record holds the user and the role names the plugin signs. The
deployment's `context:` section tags boards, datasets and roles with your own labels (the fields are named `campaign`,
`campaignType` and `country`), for reading usage by them (see
[Telemetry](../../features/telemetry.md#tagging-records-with-your-own-context)):

```yaml
context:
  superset-1: { campaign: Spring sale }
  "role:Sales-North": { country: Country A }
```

Admins read the records at `/_superset/telemetry`. What is recorded is switched field by field on the admin panel's
Telemetry tab (`/lenspack/_superset/admin/#telemetry`), which also shows the metrics worked out from the records; both
come from `/_superset/telemetry/checklist`. Question words, transcript words, recordings and device detail start off. The AI
assistant settings page keeps how long records and recordings are kept, and the consent notice. See
[Telemetry](../../features/telemetry.md).

## When Lenspack cannot save

When the state directory cannot be written (a full disk, a read-only mount), the assistant keeps working:

- dashboards still bind and answer, with the links between widgets and charts kept in memory (the log says so
  once) until a save works again;
- a settings write changes nothing and gets `503` with the reason ("The assistant's server can't save settings: the disk is full.
  Nothing was changed.").

Files are written whole (a temporary file renamed into place), and an unreadable board-state file is set aside as
`*.unreadable-<time>` instead of stopping the server. See [What Lenspack keeps on disk](../../operating/state.md).

## When a query fails

The model hears the reason, not the deployment's addresses. An unreachable data source becomes "The data source is
unreachable" with one of: connection refused, host not found, no connection, connection dropped, sign-in refused,
or Superset is unavailable. A slow one becomes "did not answer in time". Any other error keeps its wording with URLs,
hosts, ports and IP addresses taken out. The raw error goes to the server log.

---

**Next:** [Versions](versions.md).

**Related:** [What can change without a redeploy](runtime.md) · [Feature switches](../../operating/switches.md) ·
[The admin panel](../../features/admin-panel.md)
