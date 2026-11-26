# Charts, maps and heatmaps

This page lists the kinds of widget a board can hold and what each needs from the pack and the source. It is for
people building boards and pack authors who want a chart to be possible.

## The widgets

| widget | draws | query it takes |
|---|---|---|
| **kpi** | one number, optionally with a trend line and the previous period beside it | `value` |
| **chart: bar** | a measure per group, optionally split or stacked | `breakdown`, `series` |
| **chart: line, area** | a measure over time, optionally split by a dimension | `series` |
| **chart: pie** | each group's share | `breakdown` |
| **chart: heatmap** | one measure over two dimensions, shaded | `breakdown` with a split (`by`) |
| **chart: map** | one dot per location, coloured and sized | `points` |
| **table** | rows, or groups with several measures, a page at a time (5 to 200 rows a page, 10 by default) | `rows`, `breakdown` |
| **text** | a note, drawn as plain text, up to 2,000 characters | none |

A widget names a colour **scheme** (`default` or `sequential`), never a colour: each renderer maps the scheme to its
own palette. Widths are `full`, `half`, `third`, `quarter` or a number of the grid's 12 columns. See
[Board format](../reference/board.md).

## Heatmaps

A heatmap takes a breakdown's dimension on one axis and its split on the other, one measure, rows A to Z and one
scale across the grid. The `heatmap` switch turns new heatmaps off; existing ones stay.

A heatmap over time (weeks or months on an axis) is refused on sources that cannot sort such an axis correctly,
including Superset over ClickHouse. Use a breakdown over a day or date label column instead.

## Maps

A map needs an entity with a location: a `geo` block naming numeric latitude and longitude columns. Each row (or
each group of rows at the same place) is a dot, coloured by a dimension and sized by a measure, with a label. The
`maps` switch turns map queries off; existing maps stay.

- **In the board app and React**, dots draw on a plain background by default, or on map tiles from a tile server
  you may use (`MapTiles`).
- **In Superset**, a map is Superset's point map (`deck_scatter`), so Superset's reports draw the same dots. A
  dataset with columns named like `latitude`/`lat` and `longitude`/`lon`/`lng`/`long` gets a location by itself.
  The basemap differs by version: OpenStreetMap streets on Superset 6.1, Mapbox on 5.0 (which needs Superset's
  `MAPBOX_API_KEY`). See [Superset versions](../hosts/superset/versions.md).
- Shaded areas (choropleths) are not done: they need boundary shapes in the data.

## Charts a source keeps differently

Inside Superset, every widget is saved as an ordinary Superset chart. A chart Lenspack cannot express exactly
(custom SQL filters, ad hoc metrics, a heatmap shaded per row or column) is kept as Superset's: the assistant can
move, resize or remove it but not rewrite it. A previous-period KPI is drawn by Superset without its comparison.
Computed widgets have their own rules: see [Computed charts in Superset](../hosts/superset/computed-charts.md).

## Renderers

The same board draws in any renderer: the board app, Superset's own charts, or your React app with a chart library
through an adapter. Two adapters ship: a zero-dependency SVG one (the default) and one for Recharts; another
chart library is one more adapter. See [React](../hosts/react.md).

---

**Next:** [Personal dashboards and saved layouts](personal-dashboards.md) (coming soon), or
[Daily review, open questions and definitions](review.md).

**Related:** [Boards and widgets](../concepts/boards.md) · [Board format](../reference/board.md) ·
[Datasets and dashboards in Superset](../hosts/superset/datasets-and-dashboards.md)
