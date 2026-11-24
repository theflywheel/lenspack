# Overview

**A dashboard is data, not code.**

Declare your data once in a pack. After that a language model can build and edit dashboards over it by naming keys, such as `revenue`, `country` and `refund_rate`, and nothing else. No SQL, no JSX, no colour values. What the pack does not declare, the compiler will not build.

## The binding

Everything a person writes is the pack (`pack.yaml`). A board (`board.json`) is built only from it, through operations. Any charting library can render the board: it never changes, only the renderer does. The charting libraries sit behind one seam (recharts, ECharts, shadcn, and a zero-dependency SVG adapter); see [Using it in your own app](../README.md#using-it-in-your-own-app). [`examples/commerce`](../examples/commerce) has a whole pack in about 40 lines and the operations for its boards in `boards/`.

The model never emits SQL or markup. It emits one of eight operations, and every string in it must already be in the catalogue:

```json
{ "op": "add_widget", "id": "revenue_30d",
  "widget": { "kind": "kpi", "title": "Revenue, last 30 days",
    "query": { "kind": "value", "measure": "revenue",
               "compare": "previous_period",
               "time": { "last": "30d" } } },
  "placement": { "place": "top", "width": "quarter" } }
```

Anything can drive a board with the same eight operations a model emits, typed as JSON. The demo app's API takes them at `POST /api/<pack>/<board>/ops` as `{ "ops": [ … ] }`. A refused operation answers with the reason and, where one exists, the nearest key (`did you mean …?`). For example, `{"op":"set_title","title":"Renamed"}` renames the board. Like every other change, it becomes a new version you can restore from.

## The refusal

A closed vocabulary is only useful if something enforces it.

Ask for something the pack cannot answer and the compiler declines, names the reason, and points at the nearest key that exists. `GET /api/<pack>/explain?q=<query JSON>` asks the running compiler. On the commerce example:

| asked for | the compiler says |
|---|---|
| revenue by country | compiles, and returns the SQL it would run |
| revenue by product category | `FANOUT_REFUSED`: category lives on products, which has many rows per order, so grouping an order-level measure by it would multiply the numbers. It suggests a product-level measure, or a dimension on orders. |
| revenue by contry | `UNKNOWN_DIMENSION`, nearest key `country` |
| median order value | `UNKNOWN_MEASURE`: the pack declares no median, and the answer names the nearest measure that exists |

## Three steps, and only the first is yours

**1. Describe the data once.** Entities, dimensions, measures and the direction of every join. A human writes this and reviews it in git; the model never edits it. The `many_to_one` on a join is what lets the compiler refuse a fan-out later.

```yaml
entities:
  orders:
    source: orders
    grain: one row per order
    time: placed_at
    joins:
      - to: customers
        on: orders.customer_id = customers.id
        type: many_to_one
measures:
  - { key: revenue, entity: orders,
      agg: sum, sql: total_cents / 100.0 }
  - { key: refund_rate, entity: orders,
      agg: avg, sql: "(status = 'refunded')::int" }
```

**2. Point a model at it.** Any MCP client, or the same tools inside your own agent. A small model is enough: on the hardest example pack, five models under 30B parameters pass nine or ten of ten build tasks.

```bash
npx lenspack-mcp --pack packs/commerce.yaml --db ./commerce.duckdb
```

**3. Render it.** The renderer is the only code. It never reaches a database or a model, because data arrives through host callbacks, and the charting library is an adapter you choose.

```tsx
<BoardProvider
  board={board}
  catalogue={catalogue}
  host={host}
  charts={rechartsAdapter}
>
  <FilterBar />
  <Board />
</BoardProvider>
```

## Five shapes of data, one renderer

Each pack stresses a different axis of the abstraction. Each is synthetic, and `pnpm seed <name> ./<name>.duckdb` seeds it. They are also the test suite: every board runs on Postgres and DuckDB in CI, and the results must match.

| pack | board | what it stresses |
|---|---|---|
| [`commerce`](../examples/commerce) | `overview` | A star schema, money and ratios, and a fan-out trap the compiler refuses. |
| [`events`](../examples/events) | `traffic` | One wide table: every time grain, distinct counts, a high-cardinality dimension. |
| [`consultation`](../examples/consultation) | `committee` | Multilingual text with JSON metadata, multi-tenancy, LLM-derived themes as joined dimensions. |
| [`tickets`](../examples/tickets) | `desk` | State history, durations, an SLA breach rate, a funnel read from transitions. |
| [`hcm`](../examples/hcm) | `campaign` | A deliberately awkward registry: epoch-millisecond times, soft deletes, dotted hierarchies. |

In the demo app, `/?example=<pack>&board=<board>` opens one.

## Claims that fail the build when they stop being true

lenspack came out of a consultation tool whose dashboard logic was welded to one schema. These five checks are what keep the abstraction honest now that it is not.

| check | what it holds |
|---|---|
| Two engines, one answer | Every example board runs on Postgres and DuckDB; results must match after normalisation. |
| One ops suite, five packs | The core's tests run parametrised over every catalogue, not just the one it was written for. |
| Zero-domain grep | CI fails if the core or the compiler contains a word from any example domain. |
| Pack conformance | Every dimension × measure × shape compiles or fails with a documented reason; declared fan-outs are refused; tenancy is present. |
| The next pack | Writing a pack for a new dataset takes under an hour and changes nothing under `packages/`. |

## The guarantees

- The model's only outputs are operations and queries: closed unions, validated before anything reaches a database.
- Every identifier in the emitted SQL comes from the pack; every value is a bound parameter; a `LIMIT` is always present.
- Tenancy is structural: an entity that declares a tenant cannot be queried without one, so there is no forgot-to-filter state.
- Raw SQL is off by default. When switched on, it is read-only, timeboxed and capped, and its results can never become a widget.
- No URLs, no markup and no colour values in any board. Text renders as text; a scheme name maps to a CSS variable.

The security model in full: [security.md](security.md).

## The demo app

`pnpm demo` serves the example packs in the board app (`examples/demo`). You can build boards with the chat, drag widgets and restore versions. Its look carries one idea: colour is provenance. A key that the pack declares is always mono and blue, whether in prose, in the metrics reference or in a board title. Something the compiler refuses is always ochre.

## How the code is laid out

The npm packages (`@lenspack/<name>`) sit in four folders under `packages/`, by the job they do:

| folder | what is in it |
|---|---|
| `packages/kernel/` | What every deployment uses: `core` (boards, operations, the query format), `pack` (reading and checking a pack), `policy` (who may see and change what), `engine` (checks a query against the pack and policy, then hands it to a source) and `agent` (the tools a model uses to read numbers and change boards). It never reaches a database or a model provider itself: sources and hosts plug into it. |
| `packages/sources/` | Where data comes from: `sql` (Postgres, DuckDB, SQLite, MySQL/MariaDB, ClickHouse) and `elasticsearch`. |
| `packages/packs/` | Ready-made domain packs, built from another system's own configuration: `dss` and `ccrs`. |
| `packages/hosts/` | The apps and integrations that run Lenspack: `serve` (the `lenspack` command and its server), `superset` (Lenspack inside Apache Superset), `react` (the board components for your own app) and `mcp` (Lenspack as tools for any MCP client). |
