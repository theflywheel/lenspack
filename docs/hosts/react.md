# React

This page shows how to draw Lenspack boards inside your own React app, and how to plug in the chart library you
already use. It is for front-end developers.

`@lenspack/react` is the renderer: a grid, the widgets, a filter bar and version history. It never reaches a
database or a model: everything arrives through **host callbacks** you write, so it sits in front of a Next.js
route, an Express server, the Lenspack board API, or anything else.

## Draw a board

```tsx
import { BoardProvider, Board, FilterBar, VersionHistory } from "@lenspack/react";
import "@lenspack/react/styles.css";

<BoardProvider board={board} catalogue={catalogue}
  host={{ loadBoardData, applyOps, saveLayout, loadWidgetPage, loadFilterOptions, loadVersions, revertTo }}>
  <FilterBar /> <VersionHistory /> <Board />
</BoardProvider>
```

The host callbacks (`BoardHost`):

| callback | required | what it does |
|---|---|---|
| `loadBoardData(config, selections)` | yes | rows for every widget, for example from `resolveBoard()` on your server |
| `applyOps(ops)` | no | apply edit operations and return the new board (a new version) |
| `saveLayout(layout, summary)` | no | save a drag or resize as a version of its own |
| `loadWidgetPage(id, page, selections)` | no | one page of a table widget's rows |
| `loadFilterOptions(field)` | no | the values for a filter control |
| `loadVersions()`, `revertTo(version)` | no | the version history and restoring from it |

Leave out the write callbacks and the board is read-only. `useBoard()`, `useBoardOps()`, `useFilters()` and
`useVersions()` give your own components the same state.

## On your server

```ts
import { loadPack, catalogueFrom } from "@lenspack/pack";
import { resolveBoard, sqlConnector, sqlStore } from "@lenspack/sql";
import { openPostgres } from "@lenspack/sql/pg";

const pack = await loadPack("./packs/commerce.yaml");
const db = await openPostgres(process.env.DATABASE_URL!);
const connector = sqlConnector(db.executor);
const store = sqlStore(db); await store.migrate();

// Data for a board (one scan per distinct query), narrowed to the caller:
const data = await resolveBoard(board.config, { pack, connector, ctx: { tenant } }, selections);
```

Or point the callbacks at a running `lenspack serve` and its [HTTP API](../reference/http-api.md#the-board-api).

## Chart libraries are adapters

A chart widget builds a `ChartSpec` (pivoted rows, series keys, a formatter, a palette of CSS variables) and hands it
to whichever adapter the provider holds. The board never changes; only the library does, and the provider can swap
it at run time.

```tsx
import { svgAdapter } from "@lenspack/react/adapters/svg";             // no dependencies; the default
import { rechartsAdapter } from "@lenspack/react/adapters/recharts";   // recharts 3 or later

<BoardProvider charts={rechartsAdapter} …>
```

Any other library (ECharts, Chart.js, Vega, your design system's chart component) is an adapter you write, and it is
one component: `{ name, Chart: ({ spec }: { spec: ChartSpec }) => … }`. Adapters get the spec, never the board, so
"no colours in the board" still holds: a scheme name maps to CSS variables, and canvas libraries resolve them with
`resolveCssVar()`. Add yours to the conformance test in `packages/hosts/react/test/adapters.test.tsx`, which runs
every adapter through every chart kind. `lazyAdapter()` loads an adapter only when a chart first draws.

## Maps and heatmaps

A map (a `points` query) is Lenspack's own `MapChart`, the same under every adapter: points in Web Mercator fitted to
their extent, a legend, tooltips and the series colours, on a plain latitude and longitude grid. There is no basemap
by default. `<BoardProvider mapTiles={{ url: "https://tiles.example.org/{z}/{x}/{y}.png", attribution: "© …" }}>`
puts XYZ raster tiles under the points; use a tile service whose terms allow it (not tile.openstreetmap.org for
anything beyond light personal use).

A heatmap is Lenspack's own `HeatmapChart`, also the same under every adapter, on eight steps of
`--lp-heat-1..8` (by default the sequential scale, faintest to `--lp-sequential-1`). `--lp-sequential-1` is the
colour with the most ink against the page in either theme, so a host's dark theme flips the sequential scale, as the
default stylesheet does.

## One script tag

For a page with no build of its own, `board.js` bundles React, the renderer and the SVG charts in one script, with
its styles in `board.css`. The build writes both into `@lenspack/serve`'s `web/admin` folder; `lenspack serve` serves
them inside its admin panel (to admins only), so to use them on a page of your own, host the two files yourself:

```html
<link rel="stylesheet" href="/static/board.css">
<script src="/static/board.js"></script>
<div id="board"></div>
<script>LenspackBoard.mount(document.getElementById("board"), { api: "/api/commerce/overview" });</script>
```

`mount(el, { api, editable, onError })` draws the board the board API at `api` serves. Lenspack's admin panel draws
its usage board this way.

---

**Next:** [MCP](mcp.md).

**Related:** [Board format](../reference/board.md) · [Charts, maps and heatmaps](../features/charts.md) ·
[Write a host](../extending/write-a-host.md)
