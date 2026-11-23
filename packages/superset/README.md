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
  `position_json` becomes the grid. A chart lenspack cannot say exactly (a heatmap, custom SQL filters, ad hoc
  metrics) is kept as Superset's: a text widget the model can move, resize or remove but not rewrite.
  `pushBoard` sends only what changed: `POST`/`PUT /api/v1/chart`, then the dashboard's layout and title.
- **Superset stays the record.** `supersetBoards` wraps any `BoardStore`: reads pick up edits made in Superset,
  every lenspack change is sent to Superset before it counts, and a change Superset refuses is undone. Lenspack's
  version history is the undo Superset lacks.

`bin/serve.ts` runs the board API plus two ways to show the chat: beside the dashboard (`/superset/<id>`, an
iframe) or inside Superset (`/overlay.js`, loaded by one script tag in Superset's documented-overridable
`tail_js_custom_extra.html`). See `superset-demo/` in the lab repo for a stock Superset 5.0 setup.

## Voice and languages

The chat panel has a mic and a language menu (Auto, English, Français, हिन्दी), remembered per browser.

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

Writes need the header `x-lenspack-settings-token: $LENSPACK_SETTINGS_TOKEN`: every path is also reachable
by signed-in Superset users through the proxy, and only the admin-only settings page holds the token.
Without the variable, settings are read-only. They persist in `settings.json` beside the board state.

Gaps: board filters are not yet written as Superset native filters; a previous-period KPI is drawn by Superset
without its comparison; tabs and columns in a dashboard are kept, and new widgets are added below them.
