# Datasets and dashboards

This page explains how Lenspack builds its pack from Superset's datasets, reads numbers through Superset, and keeps
boards in step with Superset dashboards. It is for Superset admins choosing datasets and anyone wondering why a
chart is kept as Superset's.

## The pack, from datasets

`datasets:` in `superset.yaml` lists the datasets Lenspack may use, by id or by table name. At start-up
`packFromDatasets` turns them into a pack:

- a **dataset** becomes an entity;
- its **saved metrics** become measures (`sql: { superset: <metric_name> }`), so the chat uses Superset's own
  definition;
- its **groupable columns** become dimensions. A column with the same name on several datasets becomes one
  dimension shared by all of them.

Hints come from Superset's descriptions. Keep numeric columns that are only measured (amounts, counts) not
groupable in Superset: a groupable numeric column becomes a dimension, which confuses the chat about what to add up.

**Nothing in a dataset stops Lenspack starting.** A metric with no name or SQL, or a column with no name, is left
out. A groupable column with the same name as a saved metric becomes `<name>_value` (the metric keeps the name).
Each change is one warning line in the log and in the settings API (`warnings`).

## The overlay

What Superset has no field for comes from `overlay:` in `superset.yaml`: the pack's `description` and
`instructions`, a `timeZone`, entity names and `entities` settings, `hints` and `labels` for keys, `hierarchies`,
`examples` (written per language if you like; see [Languages](../../features/languages.md#suggested-questions-in-several-languages)),
`geo` for maps, `mapStyle`, and `panel` (`float` or `dock`, the chat's starting form).

```yaml
overlay:
  description: Orders, customers and stock for the shop.
  timeZone: Europe/Lisbon
  instructions: Revenue is after refunds. Weeks start on Monday.
  hierarchies: { place: [region, district, store] }
  examples:
    - question: Orders by region last month
      query: { kind: breakdown, dimension: region, measure: orders, time: { period: month, offset: -1 } }
```

## Numbers, from Superset

`supersetConnector` turns a resolved query into Superset query objects and runs them through
`/api/v1/chart/data`, so a metric means the same in both, and Superset's row-level security applies. There are no
joins (a Superset chart reads one dataset); share, Other and further measures are composed by the engine as usual.

**Time zones.** Superset cuts time into days with no time zone. A dataset whose time column holds calendar dates
(`DATE`, or ClickHouse's `Date` and `Date32`) needs none: the catalogue marks it `type: date`, its days, weeks and
months are drawn in a pack with any `timeZone`, and a window is sent as the dates it holds in that zone ("the last 7
days" ends today in the pack's zone). In a pack outside UTC, a series over a time column with a time of day is
refused, and the refusal says what works: a date column, or a pack that keeps UTC.

## Dashboards are boards

`dashboardToBoard` reads a dashboard: charts become widgets, markdown becomes text, and `position_json` becomes
the grid. A chart Lenspack cannot say exactly (custom SQL filters, ad hoc metrics, a heatmap shaded per row or
column) is kept as Superset's: a widget the model can move, resize or remove but not rewrite.

**Superset stays the record.** `supersetBoards` wraps a board store: reads pick up edits made in Superset, every
Lenspack change is sent to Superset before it counts, and a change Superset refuses is undone. `pushBoard` sends only
what changed: `POST`/`PUT /api/v1/chart`, then the dashboard's layout, title and filters. Lenspack's version history
is the undo Superset lacks; today it is kept in memory (see [Stores](../../architecture/stores.md)).

**Tabs and columns.** On a dashboard with tabs or columns, the existing layout is kept and new widgets are added
below it.

> **Coming soon.** Edits on dashboards with tabs. The layout is read from the top down, through tabs (top-level,
> inside the grid, or inside other tabs) and columns, so the board lists every chart Superset draws. The chat is told
> what is on each tab and which tab the viewer has open. Lenspack then changes the layout in place: a new chart goes
> on the tab of the widget its placement names, else on the viewer's tab; a resize changes the chart where it is; a
> removal takes out that one placement; a restore puts a chart back in its tab and row. **A move is refused**, with a
> message saying to move the chart in Superset; tabs themselves are made, renamed and removed in Superset. Before
> every save the whole layout is checked, and a layout that would break is not saved. A saved edit is kept apart by
> the tab the viewer had open, so "add a chart here" lands on that tab.

**Gaps.** A previous-period KPI is drawn by Superset without its comparison.

## The filter bar

A dashboard's native filters (`json_metadata.native_filter_configuration`) are read as board filters:

- a value filter (`filter_select`) on a column the pack has as a dimension becomes a `select`;
- a time range (`filter_time`) becomes a `daterange`;

each with the charts its scope covers and the value it is set to by default, so the chat can say what the dashboard
is filtered to.

Every other filter stays exactly as Superset has it and is shown to the model as "Superset-only filter: <name>",
with what it does: a numeric range, a time grain or time column picker, a value filter on a column outside the pack,
one that excludes the values picked or picks its first value, one reading several datasets, or a time range default
other than "last N days or months".

The chat can add, change (label, charts, default) and remove filters, and remove a Superset-only one, but never
rewrite one. Writing back changes only the filters the board changed; every other key, section heading and filter
is kept as it was. What a viewer has picked is sent with each chat question (see
[Filters](../../concepts/filters.md#2-a-boards-filter-bar)). On Superset 6.1 the filter bar also holds "chart
customizations" and a timestamp switch; Lenspack leaves both untouched.

## Heatmaps

A heatmap widget is Superset's `heatmap_v2`: a breakdown's dimension on `x_axis`, its split as `groupby`, one saved
metric, rows A to Z, one scale across the grid. A heatmap over time is refused before the change (capability
`timeHeatmap: false`): Superset sorts a time axis by the raw column while grouping by its weeks or months, which
ClickHouse refuses (Postgres accepts it), so use a breakdown over a day or date label column instead.

## Maps

A dataset with one numeric `latitude`/`lat` column and one `longitude`/`lon`/`lng`/`long` column becomes an entity
with a location. `overlay.geo` names other columns per entity, dataset id or table, or turns detection off with
`false`.

A `map` widget is Superset's `deck_scatter`: `spatial` latlong on those columns, `dimension` for the colour, a saved
metric as `point_radius_fixed` for the size (Superset groups by location), the label in `js_columns`, `row_limit`,
and `mapbox_style` from `overlay.mapStyle`. The default style is Superset's own for its version (see
[Versions](versions.md)). The query that draws the points is saved with the chart, so Superset's reports and
`GET /api/v1/chart/<id>/data` get the same points as the dashboard; Lenspack reads them through
`/api/v1/chart/data`.

A `deck_scatter` made in Explore reads back as a map when every setting maps: latlong on the entity's location
columns, a fixed or saved-metric radius, a dimension colour, at most one dimension in `js_columns`, no time grain and
no JavaScript; otherwise it stays Superset's. Shaded areas (`deck_polygon`) are not done: they need boundary shapes
in a dataset column.

---

**Next:** [Computed charts](computed-charts.md).

**Related:** [Charts, maps and heatmaps](../../features/charts.md) · [Packs](../../concepts/packs.md) ·
[Dashboard edits](../../features/dashboard-edits.md)
