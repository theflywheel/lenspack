# @lenspack/superset

Apache Superset as a lenspack backend, without forking Superset.

- **Catalogue from Superset.** `packFromDatasets` turns datasets into a pack: a dataset is an entity, its saved
  metrics are measures (`sql: { superset: <metric_name> }`), its groupable columns are dimensions (a column on
  several datasets becomes one conformed dimension). Hints come from Superset's descriptions; an `Overlay` adds
  what Superset has no field for (instructions, examples, hierarchies, entity names).
- **Numbers from Superset.** `supersetConnector` compiles a resolved query into Superset query objects and runs
  them through `/api/v1/chart/data`, so a metric means the same in both and Superset's row-level security applies.
  No joins (a chart reads one dataset); share, Other and further measures are composed by the engine as usual.
- **Dashboards are boards.** `dashboardToBoard` reads a dashboard: charts become widgets, markdown becomes text,
  `position_json` becomes the grid. A chart lenspack cannot say exactly (custom SQL filters, ad hoc metrics, a
  heatmap shaded per row or column) is kept as Superset's: a text widget the model can move, resize or remove but
  not rewrite.
- **Heatmaps.** A heatmap widget is Superset's `heatmap_v2`: a breakdown's dimension on `x_axis`, its split as
  `groupby`, one saved metric, rows A to Z, one scale across the grid. A heatmap over time is refused before the
  change (capability `timeHeatmap: false`): Superset 5 sorts a time axis by the raw column while grouping by its
  buckets, which the database refuses, so use a breakdown over a day or date label column instead.
- **Maps.** A dataset with one numeric `latitude`/`lat` column and one `longitude`/`lon`/`lng`/`long` column
  becomes an entity with a location (`overlay.geo` names other columns per entity, dataset id or table, or turns
  detection off with `false`). A `map` widget is Superset's `deck_scatter`: `spatial` latlong on those columns,
  `dimension` for the colour, a saved metric as `point_radius_fixed` for the size (Superset groups by location),
  the label in `js_columns`, `row_limit`, and `mapbox_style` from `overlay.mapStyle` (default
  `mapbox://styles/mapbox/light-v9`; Superset 5.0 takes Mapbox styles only and the basemap needs Superset's
  `MAPBOX_API_KEY`). Lenspack reads a map's points through `/api/v1/chart/data` (`deck_scatter` itself renders
  through `explore_json`, which refuses a token). A `deck_scatter` made in Explore reads back as a map when every
  setting maps: latlong on the entity's location columns, a fixed or saved-metric radius, a dimension colour, at
  most one dimension in `js_columns`, no time grain and no JavaScript; otherwise it stays Superset's. Shaded areas
  (`deck_polygon`) are not done: they need boundary shapes in a dataset column.
  `pushBoard` sends only what changed: `POST`/`PUT /api/v1/chart`, then the dashboard's layout and title.
- **Superset stays the record.** `supersetBoards` wraps any `BoardStore`: reads pick up edits made in Superset,
  every lenspack change is sent to Superset before it counts, and a change Superset refuses is undone. Lenspack's
  version history is the undo Superset lacks.

`bin/serve.ts` runs the board API and the chat inside Superset (`/overlay.js`, loaded by one script tag in
Superset's documented-overridable `tail_js_custom_extra.html`). The deployment side is one Python file,
`lenspack_superset.py` in [egovernments/innovations `nl-dashboard/`](https://github.com/egovernments/innovations/tree/nl-dashboard/superset-lenspack/nl-dashboard),
loaded by `superset_config.py`.

## Who is asking

Browsers never reach this server directly. Superset forwards `/lenspack/...` to it for signed-in users and adds
`x-lenspack-identity`: base64url JSON `{u, a, d, e, v, t}` (user, Superset admin, the dashboard the request is about,
whether Superset lets them edit and view it, signed-at) and an HMAC-SHA256 of it. The key is derived from
Superset's `SECRET_KEY` on the Superset side; this server fetches it on start
(`GET /api/v1/lenspack/identity-key`, allowed to admins and its own account). A request without a valid
signature less than five minutes old is not signed in (401). Only `overlay.js`, `chat.js`, `chat.css` and
`/healthz` are public.

- **Edits** follow `LENSPACK_EDIT_POLICY` (or `editPolicy` in the config). `superset`, the default: whoever
  Superset lets edit that dashboard, its owners with `can_write` on Dashboard and admins. Everyone else who can
  view it may still ask questions; the chat's edit tools then answer "you can view this dashboard but not edit it
  in Superset", which the model passes on. `signed-in`: anyone signed in may edit (the behaviour before). The
  `boardEdits` off switch (below) comes first: off, nobody edits through the chat, admins included.
- **Settings** writes and the audit log need a Superset admin.
- **Its own account.** On first start it signs in once as a Superset admin (`SUPERSET_ADMIN_USERNAME`, default
  `admin`, and `SUPERSET_ADMIN_PASSWORD`) and calls `POST /api/v1/lenspack/bootstrap`, which makes the
  `lenspack` user (Admin role: it edits dashboards it doesn't own, which Superset allows only owners and admins).
  The generated password stays in `superset-account.json` (mode 600) in the state directory; after that the admin
  password can be removed. `LENSPACK_SUPERSET_PASSWORD` (with `superset.username`) uses an account you manage
  instead.
- **Audit log.** Board changes, refused and denied requests, chat turns and settings changes, each with the
  Superset user, one JSON line each in `audit.jsonl` in the state directory. On the first write of a month the
  previous month moves to `audit-YYYY-MM.jsonl`; months older than 90 days are deleted (`audit.retentionDays`,
  `LENSPACK_AUDIT_RETENTION_DAYS`; `audit: false` turns it off). It is the durable record: the usage figures
  (`GET /api/_usage`) are kept in memory and reset on restart. Admins read it with
  `GET /_superset/audit?month=YYYY-MM&limit=N`, and on the AI assistant page.

Inside Superset the chat opens as a floating window or as a side panel; the gear chooses. The window opens at
the top right, below Superset's menu bar, with room under it: drag it by its header, and resize it with the
grip in its bottom-left corner (down and left, the top-right corner staying put) or from its left and top
edges. Size and position are remembered per browser.

## Voice and languages

The chat panel has a mic and a language menu (Auto, English, Français, हिन्दी), remembered per browser. The
overlay's own words (its button, gear menu and grip) and the suggested questions follow the same language. A
suggested question may be written per language, with one query for all of them:

```yaml
overlay:
  examples:
    - question: { en: Zero-dose share by LGA, fr: Part des enfants zéro dose par LGA }
      query: { kind: breakdown, dimension: lga, measure: zero_dose_pct, limit: 10 }
```

The model sees the English wording (else the first) as a worked example; a language an example doesn't have
shows its English. `/_superset/info` returns `examplesByLang`, and `examples` for `?lang=` (English by default).

- **Mic.** Click to start and click again to stop, or hold the button and release to stop. Holding Space for
  2 s (`speech.holdMs`, 500–3000; each user can pick their own in the menu) also talks, even while typing
  in the panel: a shorter press types a space, and the mic button fills up to show the hold. Space is left
  alone in Superset's own fields, on buttons and other controls, during IME composition and with a modifier. Recording shows a timer and a level meter and stops at `speech.maxSeconds`
  (60). The clip goes to `POST /api/_stt` on this server, which sends it to an OpenAI-style transcription
  endpoint (OpenRouter by default); the text lands in the input to check before sending. Browsers allow the
  mic only on https pages or localhost.
- **Language.** Auto sends no language hint (the model detects it) and the chat replies in whatever language
  the user wrote or spoke. A picked language is the speech hint, the reply language and the panel's own
  words. Without a pick, the panel follows Superset's language when one was chosen there (Superset's
  bootstrap `common.locale`; its default, English, does not count), else the deployment default.
- **New chat.** The pencil button in the header clears the conversation for this board (the board itself,
  settings and language prefs are untouched). The model starts over but still hears of later edits, and an
  Undo note brings the conversation back for five seconds. It is disabled while a turn or the mic is busy.
- **Titles.** New board and widget titles are written in the board's language (`language.board`, English by
  default) whatever language the user speaks, or in the reply's language with `language.titles: speaker`.
- **Key.** `LENSPACK_STT_API_KEY`, else `OPENROUTER_API_KEY`, on this server only. Without one the mic is
  hidden and `/api/_stt` answers 503. Transcriptions are metered (role `speech`) and count against the budget.

`speech.model` (default `mistralai/voxtral-mini-transcribe-3-0`), `speech.holdMs` (2000) and `language.{default,titles,board}` in the
config are defaults. An admin can change them on a running server from Superset's Settings → AI assistant
page, which calls:

| | |
|---|---|
| `GET /_superset/settings` | includes `speech` {enabled, keyFrom, model, defaultModel, source, holdMs, defaultHoldMs, holdMsRange, writable} and `language` {default, titles, board, options, defaults, source, writable} |
| `GET /_superset/settings/speech/models` | the provider's transcription models with a per-minute price (cached an hour) |
| `PUT /_superset/settings/speech` | any of `{model, holdMs}`; a field left out is kept, `null` puts it back to the default |
| `PUT /_superset/settings/language` | any of `{default, titles, board}`; `null` resets a field |
| `PUT /_superset/settings/features` | any of `{<switch>: true \| false \| null}` (below); `null` drops the admin's value |

Reads and writes need a Superset admin's signed identity (above). Settings persist in `settings.json` beside
the board state.

When the state directory can't be written (disk full, read-only mount), the assistant keeps working: dashboards
still bind and answer, with the links between widgets and charts kept in memory (the log says so once) until a
save works again. A settings write changes nothing and gets `503` with the reason ("Lenspack can't save
settings: the disk is full. Nothing was changed."). Files are written whole (a temporary file renamed into
place), and an unreadable board-state file is set aside as `*.unreadable-<time>` instead of stopping the server.

When a query fails, the model hears the reason, not the deployment's addresses: an unreachable data source
becomes "The data source is unreachable (connection refused | host not found | no connection | connection
dropped | sign-in refused | Superset is unavailable)", a slow one "did not answer in time", and any other error
keeps its wording with URLs, hosts, ports and IP addresses taken out. The raw error goes to the server log.

## Off switches

Each part of the assistant can be turned off; all are on by default. A switch's value comes from, lowest first:
the default (on), `features:` in the config, `LENSPACK_FEATURES`, then an admin on the settings page. The page
can turn a switch the environment set back on; `null` hands it back to the environment.

```yaml
features: { voice: false, reviewer: false }      # in the config
```
```sh
LENSPACK_FEATURES="voice=off,maps=on"             # or "-voice,+maps", or a JSON object
```

| switch | off means | enforced by |
|---|---|---|
| `overlay` | no Ask Lenspack button or panel on any dashboard | the page |
| `voice` | no mic; `/api/_stt` answers 503 | the server (the key is withheld) |
| `spaceHold` | holding Space doesn't talk; the mic button still does | the page |
| `languageMenu` | no language picker; the deployment's default language applies, and a pick saved earlier is ignored | the page |
| `markdown` | replies as plain text | the page |
| `inPlaceRefresh` | after a change the page reloads instead of redrawing the dashboard | the page |
| `newChat` | no New chat button | the page |
| `boardEdits` | the chat answers questions only, for everyone, admins included; edit tools say edits are turned off | the server |
| `heatmap` | new heatmaps are refused (existing ones stay) | the server |
| `maps` | map queries are refused (existing deck_scatter charts stay in Superset) | the server |
| `reviewer` | no second model call checking each change | the server |

`/_superset/info` returns `features` (the effective booleans) for the page. `GET /_superset/settings` returns
`features: {values, defaults, source, options, writable}`: `defaults` is what the deployment says without the
admin, `source` is `default`, `config`, `env` or `settings` per switch, and `options` gives each switch's label
and help text. A page holding an old copy picks up a change on its next dashboard load.

Gaps: board filters are not yet written as Superset native filters; a previous-period KPI is drawn by Superset
without its comparison; tabs and columns in a dashboard are kept, and new widgets are added below them.
