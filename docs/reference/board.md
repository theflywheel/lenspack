# Board format

This page is the full format of a board (a dashboard as a document) and of the ten edit operations that change it.
It is for developers who store, render or edit boards outside the chat. For the idea, read
[Boards and widgets](../concepts/boards.md).

`boardConfigSchema` and `opSchema` in `@lenspack/core` are the source of truth. Nothing in a board is code, SQL,
markup, a URL or a colour value.

## The board

```ts
type BoardConfig = {
  version: 2;                       // the board format's version
  pack: string;                     // the pack it was built against
  packVersion: number;              // that pack's version, 1 or more
  title: string;                    // 1–160 characters
  grid: {
    cols: number;                   // 4–24, default 12
    rowHeight: number;              // 20–120, default 40
    density: "comfortable" | "compact";   // default comfortable: how much air around widgets
    fill: boolean;                  // default false: pack rows, closing gaps and widening each row's last widget
  };
  layout: { i: string; x: number; y: number; w: number; h: number; static?: boolean; fw?: number }[];
  widgets: Record<string, Widget>;  // by widget id
  filters: Filter[];                // the filter bar
};
```

`layout` holds grid positions by widget id. `fw` is the width a widget had before a packed board widened it: the
extra counts as free room, so a widget asked for that row can still sit beside it.

## Widgets

Every widget has a `title` (1–120 characters) and one of four kinds:

| kind | fields |
|---|---|
| `chart` | `chart`: `bar`, `line`, `pie`, `area`, `heatmap` (one measure over two dimensions as shaded cells: columns are a breakdown's dimension or a series' buckets, rows its `by`) or `map` (a points query). `query`. `options`: `legend` (default true) and `colorScheme` (`default` or `sequential`: a name, never a colour; the renderer owns the palette). |
| `kpi` | `query`: a value query, or a series whose latest bucket is drawn with its trend. `format` optional. A summary of the buckets (the mean per day, the total) is a value query whose compute ends with `over_time`. |
| `table` | `query`. `pageSize` 5–200 (default 10): a rows query pages through the source, a breakdown through the groups it fetched. |
| `text` | `body`, up to 2000 characters, drawn as plain text, never as markup. |

A query is any of the five shapes in [Query format](query.md). An older KPI that carried `aggregate` is read as a value
query with an `over_time` step, so saved boards keep working.

## Filters

```ts
type Filter = {
  id: string;
  type: "select" | "search" | "daterange" | "host";
  label: string;
  field: string;          // a dimension key; "time" for a daterange; for host, its dimension or ""
  applies: string[];      // widget ids, at least one
  default?: { months?: number; days?: number; values?: string[] };   // months 1–60, days 1–3660, values 1–100
  note?: string;          // a host filter in words, up to 400 characters
};
```

- A `select` or `search` filter narrows by a dimension the pack has. A `default.values` opens the board narrowed to
  them.
- A `daterange` filter sets the time window of the widgets it applies to. Its `default` is the last N calendar
  months or days up to today, in the pack's time zone.
- A `host` filter is one from the system the board is kept in (a Superset dashboard's own filter bar) that Lenspack
  cannot express. The model sees its `note`; it is kept exactly as the host has it, and can be removed but not
  changed or added.

## Edit operations

A board changes only through these operations. A batch is applied whole or not at all, and a refused batch names the
operation that failed. No operation replaces the widget map, so no sequence of valid operations can empty a board by
accident.

| op | fields |
|---|---|
| `add_widget` | `id` (lowercase letters, digits, `-` and `_`, up to 41 characters), `widget`, `placement` |
| `update_widget` | `id`, `widget` |
| `remove_widget` | `id` |
| `move_widget` | `id`, `placement` |
| `resize_widget` | `id`, `width`, `height` |
| `set_title` | `title` (1–160) |
| `add_filter` | `filter` |
| `update_filter` | `id`, `filter`: replaces a filter in place, keeping its id and position |
| `remove_filter` | `id` |
| `set_layout_mode` | `density`, `fill`, together or separately ("make it compact") |

**Placement** says where, never coordinates: `place` is `top`, `bottom` (the default), `after:<id>` or `below:<id>`;
`width` is `full`, `half` (the default), `third`, `quarter` or a number of columns (1–12, of 12); `height` 1–20.
The server packs the grid, so an overlap cannot be written.

For example, a KPI across the top:

```json
{ "op": "add_widget", "id": "revenue_30d",
  "widget": { "kind": "kpi", "title": "Revenue, last 30 days",
    "query": { "kind": "value", "measure": "revenue", "compare": "previous_period", "time": { "last": "30d" } } },
  "placement": { "place": "top", "width": "quarter" } }
```

Anything can drive a board with the same operations a model uses, typed as JSON: the standalone server takes them at
`POST /api/<pack>/<board>/ops` (see [HTTP API](http-api.md#the-board-api)). A refused operation answers with the reason
and, where one exists, the nearest key ("did you mean …?"). Every accepted batch becomes a new version you can
restore.

---

**Next:** [HTTP API](http-api.md).

**Related:** [Boards and widgets](../concepts/boards.md) · [Dashboard edits](../features/dashboard-edits.md) ·
[Charts](../features/charts.md)
