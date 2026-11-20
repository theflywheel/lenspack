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

Gaps: board filters are not yet written as Superset native filters; a previous-period KPI is drawn by Superset
without its comparison; tabs and columns in a dashboard are kept, and new widgets are added below them.
