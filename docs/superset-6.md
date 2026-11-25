# What Superset 6 could add to Lenspack

Lenspack works with Superset 6.1 and 5.0 ([packages/hosts/superset/README.md](../packages/hosts/superset/README.md#superset-versions)
lists the differences). This page looks at what Superset 6.0 and 6.1 add that could make the assistant able to do
more, and what each would take. Nothing here is built yet.

Effort: **small** is a few days inside the Superset package; **medium** touches the board model or the chat's
tools as well; **large** is a new piece of the system.

Several of these sit behind Superset feature flags marked "development" in 6.1, which means Superset itself does
not consider them finished. Building on those now would tie Lenspack to an interface that may still change.

## Worth doing next

### Viewer-chosen group-by and grain in the filter bar

Superset 6.1's filter bar holds "chart customizations" beside the filters: a **dynamic group-by** (the viewer picks
which column the charts break down by), a **time grain** picker, a **time column** picker, and a switch for
**deck.gl map layers**. They are saved in the dashboard's `json_metadata.chart_customization_config`, next to the
native filters.

- **What the assistant could do:** "let people switch these charts between region and district", "add a weekly or
  monthly switch". It could also read them, so that it knows a chart is currently grouped by what the viewer
  picked rather than by what was saved.
- **Effort:** medium. They read and write like native filters (a target dataset and column, the charts in scope, a
  default), which Lenspack already handles. The board model needs a new kind of control.
- **Recommendation:** do it. It answers a common request without a new chart per breakdown. Today Lenspack keeps
  these settings untouched when it writes a dashboard.

### Matching the deployment's theme

Superset 6 is themed through Ant Design 5 tokens (`THEME_DEFAULT`, `THEME_DARK`, and themes admins can manage in
the interface), and it hands the active theme to the page. The chat button and window follow light or dark from
the page's background colour; they do not pick up the deployment's brand colour or font.

- **What it could do:** the chat would look like part of the deployment: its accent colour, font and corner
  radius taken from the theme.
- **Effort:** small (the overlay reads the theme from the page's bootstrap data).
- **Recommendation:** do it with the next round of chat polish.

## Worth doing when the feature settles

### Comparing with a fixed past period

`DATE_RANGE_TIMESHIFTS_ENABLED` lets a chart compare with a date range ("1 to 7 January 2026") as well as a
relative shift ("1 week ago"), and `TABLE_V2_TIME_COMPARISON_ENABLED` adds period comparison to tables. Both are
development flags.

- **What it could do:** "compare this round with the first round", where rounds are date ranges, not "N weeks
  ago". Lenspack's change-over-time steps (difference, percentage change) use relative shifts today.
- **Effort:** small to medium: a new form of time comparison in the compute step, written as Superset's
  `time_compare`.
- **Recommendation:** wait until the flag leaves development, then add it.

### Small multiples (Matrixify)

`MATRIXIFY` (development) draws one chart as a grid of small charts, one per value of a dimension in rows and
columns.

- **What it could do:** "one chart per district", "a grid of regions by month", without a chart per value.
- **Effort:** medium: a new widget option, and reading it back.
- **Recommendation:** wait for the flag to settle.

### Table V2 (AG Grid)

`AG_GRID_TABLE_ENABLED` (development) adds a table chart (`ag-grid-table`) with server-side paging, sorting and
column filters.

- **What it could do:** large row lists that page through all rows instead of stopping at a row limit.
- **Effort:** small for writing it; medium to read back every setting.
- **Recommendation:** keep writing the standard `table` until Superset makes this one standard.

### Folders of metrics and columns

`DATASET_FOLDERS` (development) groups a dataset's metrics and columns into folders in the chart builder.

- **What it could do:** the pack could take the folders as groups of measures and dimensions, which helps the
  model choose among many similar metrics.
- **Effort:** small.
- **Recommendation:** read them once the flag settles.

### Reports with filters

`ALERT_REPORTS_FILTER` (testing) lets a scheduled report carry filters.

- **What it could do:** "email me this dashboard for my district every Monday".
- **Effort:** medium: a new tool, and care over who may schedule what.
- **Recommendation:** a good candidate once deployments run 6.1 with reports set up.

### Lenspack as a Superset extension

`ENABLE_EXTENSIONS` (development) is Superset's own way to add screens, panels and backend routes without
overriding templates. Lenspack now loads its button through `tail_js_custom_extra.html`, which 6.1 still
supports.

- **What it could do:** nothing new for people asking questions; it would make installing Lenspack an official,
  supported step and could give the chat a proper place in Superset's layout.
- **Effort:** medium to large.
- **Recommendation:** prototype it once the flag leaves development; keep the template until then.

## Not needed now

### Per-group summaries saved as ordinary charts

The question: can a figure such as "average deliveries per day in each ward, counting days with none as 0" be
saved as an ordinary Superset chart, computed by Superset?

Superset's post-processing steps are the same in 6.1 as in 5.0: aggregate, pivot, resample, rolling, cumulative,
difference, compare, contribution, rank, sort, rename, flatten, histogram, box plot and a few more. Resampling
can fill missing days with 0 on a table that has one column per ward, but no step then averages each column over
time and returns one row per ward, so the chain cannot end in that figure. A pivot table's "average" counts only
the days that have rows, so empty days are skipped rather than counted as 0. The one change in 6.1 is that
percentages of a total can be taken against the total of all rows, not only the rows shown.

- **Ways to get it:** a virtual dataset in Superset (SQL that joins a calendar so empty days are rows), which works
  on 5 and 6 but means the assistant creating datasets, a step that needs an admin's say; or Lenspack's own
  compute step, as now, which answers in the chat and in Lenspack boards but is not a Superset-native chart.
- **Recommendation:** keep such figures in Lenspack's compute step. Revisit if Superset adds a step that
  aggregates over time per group.

### Superset's MCP service

Superset 6.1 ships an optional MCP service (`apache-superset[fastmcp]`, run as its own process) with tools to
list and read charts, dashboards and datasets, get chart data, generate dashboards and run SQL Lab queries. In
production it takes a signed token per user, so its queries run as that user, with that user's permissions and
row-level security.

- **What it could do:** it overlaps with what Lenspack does through Superset's REST API, without the pack's checks
  (one definition per measure, known dimensions, validated queries) that make the assistant's answers reliable.
  Its per-user tokens are the one real gain: queries would run as the person asking, with Superset applying their
  row-level security itself, where today Lenspack applies the rules it reads (`hostPolicy: superset`).
- **Effort:** large.
- **Recommendation:** watch it. Reconsider if deployments start running it, mainly for running queries as the
  signed-in user.

### Background tasks

6.1 has a task framework (`/api/v1/task`) for long-running work with progress and cancelling.

- **What it could do:** rebuild many boards, or run long checks, without holding a request open.
- **Recommendation:** not needed; Lenspack's own work is short.

### Smaller items

- **Gantt chart** (`gantt_chart`): bars from a start to an end date per row. Useful for campaign schedules if a
  pack has start and end columns. Medium effort (a new widget kind); wait for a pack that needs it.
- **Chart timestamps** (`show_chart_timestamps` in a dashboard's settings): shows when each chart's data was
  fetched. Small effort as a board option; low priority.
- **Drill to detail and drill by in embedded dashboards** (6.0): viewers of an embedded board can drill down.
  Nothing for Lenspack to do.
- **OpenStreetMap basemap** (6.0) and **`/version`** (6.1): Lenspack uses both since the change that added
  Superset 6.1 support.
