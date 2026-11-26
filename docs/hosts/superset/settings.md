# Settings and switches in Superset

This page covers what a Superset admin can change on a running Lenspack: the settings page, its routes, the
switches, and what happens when Lenspack cannot save. It is for Superset admins.

## The settings page

**Settings → Manage → AI assistant** (`/ai-assistant/`) is for Superset admins. It holds the chat and speech
models, languages, switches, spend, cost per answer and the audit log, and links to the
[admin panel](../../features/admin-panel.md) (`/lenspack/_superset/admin/`). On Superset 6.1 it has its own page
frame with a link back to Superset, light or dark as Superset is; on 5.0 it sits inside Superset's server-drawn page.

Values set here are kept in `settings.json` beside the board state and win over the config file and the
environment. A page holding an old copy picks up a change on its next dashboard load.

## Voice and language

`speech.model` (default `mistralai/voxtral-mini-transcribe-3-0`), `speech.holdMs` (2000), `speech.maxSeconds` (60)
and `language.default` (`auto`), `language.titles` (`board`), `language.board` (`en`) in `superset.yaml` are
defaults. An admin changes them on the settings page. What they do is in [Voice](../../features/voice.md) and
[Languages](../../features/languages.md).

## The routes behind it

Reads and writes need a Superset admin's signed identity (see [Who is asking](identity.md)).

| route | what it does |
|---|---|
| `GET /_superset/settings` | everything below, each with its value, default and source. Includes `speech` {enabled, keyFrom, model, defaultModel, source, holdMs, defaultHoldMs, holdMsRange, writable}, `language` {default, titles, board, options, defaults, source, writable} and `features` {values, defaults, source, options, writable} |
| `GET /_superset/settings/speech/models` | the provider's transcription models with a price per minute (cached an hour) |
| `PUT /_superset/settings/speech` | any of `{model, holdMs}`; a field left out is kept, `null` puts it back to the default |
| `PUT /_superset/settings/language` | any of `{default, titles, board}`; `null` resets a field |
| `PUT /_superset/settings/features` | any of `{<switch>: true \| false \| null}`; `null` drops the admin's value |
| `PUT /_superset/settings/cache` | any of `{enabled, ttlHours, router, maxEntries, freshMinutes, prewarm}` for [saved answers](../../features/saved-answers.md); `null` resets a field |
| `PUT /_superset/settings/queue` | any of `{maxConcurrent, maxWaiting, maxWaitSeconds}` for [busy hours](../../features/busy-hours.md) |
| `GET /_superset/cache` and below | saved answers: stats, queue, last refresh, entries, pin, unpin, evict, suggestions, chart candidates, settled boards |
| `POST /_superset/cache/prewarm`, `POST /_superset/cache/data-changed` | refresh the most-asked saved answers now, or a few seconds after a data load |
| `GET /_superset/audit?month=YYYY-MM&limit=N` | the audit log |

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
deployment's `context:` section tags boards, datasets and roles with a campaign, campaign type and country, for
reading usage by them (see [Telemetry](../../features/telemetry.md#tagging-records-with-your-own-context)):

```yaml
context:
  superset-1: { campaign: Spring sale }
  "role:Sales-North": { country: Country A }
```

Admins read the records at `/_superset/telemetry`. What is recorded is switched item by item on the admin panel's
Telemetry tab (`/lenspack/_superset/admin/#telemetry`), which is also the checklist at
`/_superset/telemetry/checklist`. Question text, transcript text, kept recordings and device detail start off. The AI
assistant settings page keeps how long records and recordings are kept, and the consent notice. See
[Telemetry](../../features/telemetry.md).

## When Lenspack cannot save

When the state directory cannot be written (a full disk, a read-only mount), the assistant keeps working:

- dashboards still bind and answer, with the links between widgets and charts kept in memory (the log says so
  once) until a save works again;
- a settings write changes nothing and gets `503` with the reason ("Lenspack can't save settings: the disk is full.
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

**Related:** [Feature switches](../../operating/switches.md) · [The admin panel](../../features/admin-panel.md)
