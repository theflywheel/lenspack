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

To use a dataset as it is, without editing it in Superset, see
[Setting it all up in `superset.yaml`](#setting-it-all-up-in-supersetyaml).

**Nothing in a dataset stops Lenspack starting.** A metric with no name or SQL, or a column with no name, is left
out. A groupable column with the same name as a saved metric becomes `<name>_value` (the metric keeps the name).
Each change is one warning line in the log and in the settings API (`warnings`).

## The overlay

What Superset has no field for comes from `overlay:` in `superset.yaml`: the pack's `description` and `instructions`, a
`timeZone`, entity names and `entities` settings, `hints` and `labels` for keys, `hierarchies`, `examples` (written per
language if you like; see [Languages](../../features/languages.md#suggested-questions-in-several-languages)), `geo` for
maps, `mapStyle`, and `panel` (`float` or `dock`, the chat's starting form). `exclude`, `notDimensions` and `measures`
are described [below](#setting-it-all-up-in-supersetyaml).

```yaml
overlay:
  description: Orders, customers and products for the shop.
  timeZone: Europe/Lisbon
  instructions: Revenue is after refunds. Weeks start on Monday.
  hierarchies: { place: [country, city] }
  examples:
    - question: Orders by country last month
      query: { kind: breakdown, dimension: country, measure: orders, time: { period: month, offset: -1 } }
```

## Setting it all up in `superset.yaml`

Everything Lenspack needs can be said in `superset.yaml`, with no change to Superset's datasets. That matters when the
people running Lenspack can't edit datasets in Superset, or when the dashboards depend on the datasets as they are.
A dataset that has only a row count and lets every column be grouped would otherwise give a pack with dozens of
dimensions and one measure per dataset. Three overlay keys fix that.

### Columns the pack never uses

`overlay.exclude` names columns the pack never turns into anything, on any dataset, whatever Superset's flags say:

```yaml
overlay:
  exclude:
    columns: [customer_name, loyalty_code, latitude, longitude]
    datasets: [staff_shifts]      # optional: whole datasets, by id or table name
```

- A column is matched by name, in any case (`CustomerName` matches `customername`), or by its key (`customer_name`).
- An excluded column is never a dimension, a measure, a map's coordinates or a time column. No query can read it, so
  no answer, explain card or sample row can show it.
- A dashboard filter on an excluded column stays on the dashboard, but it is not passed to the chat: its value never
  reaches the model, a saved answer or the usage records. "How this was worked out" says that a dashboard filter on a
  field the assistant does not use was not applied, without naming the field or its value. The model is told about
  such a filter without its column name, its default values or its own name (it is "Filter on a field this assistant
  does not use"; Superset keeps its real name).
- A Superset chart the assistant keeps as it is (see below) is described to the model without naming an excluded
  column: a chart split by, filtered on or mapped from one says "a field this assistant does not use". Chart titles
  and Markdown notes are shown as their authors wrote them.
- The exclusion wins over `notDimensions` and `measures`: a measure that reads an excluded column is refused.
- Superset itself is unchanged: its charts can still group by the column.
- With `hostPolicy: superset`, a row-level security rule on an excluded column can't be applied by Lenspack, so the
  dataset is kept from the people it applies to (Lenspack fails closed). Keep such rules on columns the pack uses.

### Columns that are not dimensions

`overlay.notDimensions` names columns that Superset lets you group by but that are amounts or counts, so the pack does
not make them dimensions:

```yaml
overlay:
  notDimensions: [quantity, basket_value]
```

The startup log warns when a column that a measure adds up is still a dimension.

### Measures from columns

`overlay.measures` adds base measures from a dataset's columns:

```yaml
overlay:
  measures:
    - { dataset: orders, name: items_sold, agg: sum, column: quantity, label: { en: Items sold, fr: Articles vendus } }
    - { dataset: orders, name: customers, agg: count_distinct, column: customer_id }
    - { dataset: orders, name: delivered_orders, agg: count, where: [{ column: status, op: eq, value: delivered }] }
    - { dataset: orders, name: largest_basket, agg: max, column: basket_value, format: currency }
```

| key | what it is |
|---|---|
| `dataset` | one of the datasets in `datasets:`, by id, table name or entity key |
| `name` | the measure's key |
| `agg` | `sum`, `count`, `count_distinct`, `min` or `max` |
| `column` | the column it reads; `count` without one counts rows |
| `where` | optional conditions on the rows: `{ column, op, value }`, `op` one of `eq`, `neq`, `in`, `gt`, `gte`, `lt`, `lte`, `exists`, `missing` |
| `label`, `hint` | text, or text per language |
| `format` | `number` (default), `percent`, `currency` or `compact` |

- Superset computes each one as an **ad hoc metric**, the kind its own metric editor makes. Lenspack sends the
  aggregate and the column (or, with `where`, the aggregate over the rows the conditions keep, written from the
  checked column names with the values quoted). Superset puts it in its query for the dataset, so the person's
  dataset access, Superset's row-level security and the pack's own scope apply exactly as for a saved metric.
- A chart the chat makes with one is saved in Superset with that ad hoc metric, and a chart someone makes in Superset
  with the same aggregate of the same column reads back as the measure.
- Keep these to simple base measures. Rates, shares and changes come from Lenspack's compute step (see
  [Computed charts](computed-charts.md)), never from a measure.
- Each one is checked against the dataset as Superset describes it. A dataset not listed, a column that isn't there,
  an excluded column, an aggregate not in the list, a sum of a text column or a key already taken leaves that measure
  out with a warning in the log and in the settings API (`warnings`). Lenspack still starts.

### Labels in several languages

`overlay.labels` and `overlay.hints` take text, or text per language:

```yaml
overlay:
  labels:
    region: { en: Region, fr: Région }
```

The English text (else the first) is the key's label. The other languages become words the chat also knows the key
by, so a question asked in French finds it.

### A worked example

A shop's two datasets, `orders` and `returns`, each have one saved metric, a row count, and every column groupable.
Nobody can edit them. This `superset.yaml` is the whole setup:

```yaml
datasets: [orders, returns]
dashboards: [12]
scope:
  - { dimension: campaign, op: eq, value: 2026-spring }
language: { default: fr, board: fr }
overlay:
  pack: shop
  description: Orders and returns for the spring campaign.
  exclude:
    columns: [customer_name, loyalty_code, latitude, longitude]
  notDimensions: [quantity, basket_value]
  measures:
    - { dataset: orders, name: items_sold, agg: sum, column: quantity, label: { en: Items sold, fr: Articles vendus } }
    - { dataset: orders, name: customers, agg: count_distinct, column: customer_id, label: { en: Customers, fr: Clients } }
    - { dataset: orders, name: delivered_orders, agg: count, where: [{ column: status, op: eq, value: delivered }], label: { en: Delivered orders, fr: Commandes livrées } }
  labels:
    region: { en: Region, fr: Région }
  examples:
    - question: { en: Items sold by region, fr: Articles vendus par région }
      query: { kind: breakdown, dimension: region, measure: items_sold, limit: 10 }
```

What it gives:

- dimensions from the groupable text columns, without the personal ones or the amounts;
- three measures beside the row counts, computed by Superset under each person's own access;
- every answer for the spring campaign only (see
  [Row scope and tenancy](../../access/scope-and-tenancy.md#pinning-every-answer-in-superset)), and a question on
  `returns`, which has no `campaign` column, refused rather than answered for every campaign;
- suggested questions in French.

A change to `superset.yaml` takes effect when Lenspack restarts.

## Numbers, from Superset

Lenspack asks Superset's chart-data API (`/api/v1/chart/data`) for every number, so a metric means the same in the
chat as on the dashboard, and Superset's row-level security applies. There are no joins, because a Superset chart
reads one dataset. Shares, the "Other" group and extra measures are worked out by Lenspack afterwards.

**Time zones.** Superset cuts time into days with no time zone. A dataset whose time column holds calendar dates
(`DATE`, or ClickHouse's `Date` and `Date32`) needs none: the catalogue marks it `type: date`, its days, weeks and
months are drawn in a pack with any `timeZone`, and a window is sent as the dates it holds in that zone ("the last 7
days" ends today in the pack's zone). In a pack outside UTC, a series over a time column with a time of day is
refused, and the refusal says what works: a date column, or a pack that keeps UTC. Lenspack says this at start-up
too: a warning in the log and in the settings API's `warnings` names each dataset and column it affects, so it is
not found one question at a time.

## Dashboards are boards

Lenspack reads a dashboard as a board: charts become widgets, markdown blocks become text widgets, and the layout
becomes the grid. A chart Lenspack cannot say exactly (custom SQL filters, ad hoc metrics other than the simple ones
below, a heatmap shaded per row or column) is kept as Superset's: a widget the model can move, resize or remove but
not rewrite. So is a chart whose dataset is not in `datasets:`, and the chat cannot answer questions from that dataset.

**Ad hoc metrics.** Charts made in Superset often use an ad hoc metric rather than a saved one. One that is a single
plain aggregate is read as the pack measure with the same aggregation and column, a saved metric or an overlay
measure (a saved metric first): `SUM(col)`, `COUNT(*)` (or ClickHouse's `count()`), `COUNT(col)`,
`COUNT(DISTINCT col)`, `MIN(col)`, `MAX(col)` and `AVG(col)`, in any case, with spaces or a quoted column
(`` `col` ``, `"col"`), and the same aggregates made in Superset's own metric editor. So a tile with
`SUM(quantity)` reads as the saved metric `items_sold` whose SQL is `SUM(quantity)`, and the chat can answer about it.
Anything else (`SUM(a) / NULLIF(COUNT(*), 0)`, a `CASE`, an aggregate of a column Superset computes from an
expression, or one no measure matches) stays Superset's. A chart's simple filters on a dimension (`=`, `!=`, `IN`,
`NOT IN`, `>=`, `<=`) are read as the widget's filters; a custom SQL filter stays Superset's.

**Notes.** A board holds no URLs, but Superset draws a markdown block with links. So a note Lenspack writes or
changes is made plain before it is saved: a link becomes its text, and HTML and bare web or e-mail addresses are not
drawn as tags or links. Bold, lists and the rest of the formatting are kept. A markdown block someone wrote in Superset
keeps its text while Lenspack leaves the note unchanged.

**Superset stays the record.** `supersetBoards` wraps a board store: reads pick up edits made in Superset, every
Lenspack change is sent to Superset before it counts, and a change Superset refuses is undone. `pushBoard` sends only
what changed: `POST`/`PUT /api/v1/chart`, then the dashboard's layout, title and filters. Lenspack's version history
is the undo Superset lacks; today it is kept in memory (see [Stores](../../architecture/stores.md)).

**Tabs and columns.** A dashboard's layout is read from the top down, through tabs (top-level, inside the grid, or
inside other tabs) and columns, so the board lists every chart Superset draws, tab after tab. The chat is told what is
on each tab and which tab the viewer has open (the overlay sends it with each message). On a dashboard with tabs or
columns Lenspack keeps the layout and changes it in place (`layout.ts`):

- a new chart goes on the tab of the widget its placement names (`after:` or `below:`), else at the top or bottom of
  the viewer's tab, else where Superset puts charts that have no place: the first top-level tab, or the grid when the
  tabs sit inside it. Never under the grid that top-level tabs leave behind, where Superset draws nothing;
- a resize changes the chart where it is (a row then wider than 12 columns wraps onto a new row in place);
- a removal takes out that one placement (a chart placed in two tabs keeps the other) and any row it empties;
- a restore puts a removed chart back where it was: the same chart, unless Lenspack made it, in its tab and row;
- **a move is refused**, with a message saying to move the chart in Superset. Moving charts between rows and tabs
  needs a board that knows tabs, which is not built yet. Tabs themselves are made, renamed and removed in Superset.

Before each save, Lenspack checks that Superset can still draw the whole dashboard. If an edit would break it, nothing
is saved and the chat says so. Problems the dashboard already had are logged and left as they are. `placeCharts` puts
charts a layout does not draw where Superset draws them; use it whenever a layout gains charts outside Lenspack's edits
(a copy of a dashboard). A saved edit is kept apart by the tab the viewer had open, so "add a chart here" lands on that
tab.

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
metric, rows A to Z, one scale across the grid. Lenspack won't make a heatmap with weeks or months on an axis, because
Superset can't draw one over some databases (ClickHouse refuses the query it sends). Use a day or date-label column
instead.

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
