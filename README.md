# lenspack

**A dashboard is data, not code.** A language model edits a validated document; the server compiles it against a declared metric catalogue; the renderer is the only code.

**Live demo:** https://lenspack.proto.theflywheel.in — four synthetic packs, a chat that builds the board, drag-and-drop editing, version history.

lenspack is that idea as a library. You describe your data once in a *pack* — entities, dimensions, measures, joins — and any model, any chat, any MCP client can build and edit boards over it without ever writing SQL, JSX or a colour value. What the model cannot express, it cannot break.

```
pack.yaml  ──►  catalogue  ──►  the model names keys  ──►  ops  ──►  board config (JSON)
                    │                                                     │
                    └──────────►  compiler (resolve → plan → print)  ◄────┘
                                          │
         Postgres · DuckDB · SQLite · MySQL · ClickHouse · Elasticsearch
```

## Sixty seconds, zero infrastructure

```bash
git clone https://github.com/theflywheel/lenspack && cd lenspack && pnpm install
pnpm seed commerce ./commerce.duckdb          # 5,000 synthetic orders into a DuckDB file
pnpm demo                                     # http://localhost:5173 — a board you can edit
                                              # (seed more packs; the demo serves every <name>.duckdb it finds)
```

To get the chat panel locally, give the demo any OpenAI-compatible endpoint (the library itself never touches a model key):

```bash
LENSPACK_LLM_BASE_URL=https://openrouter.ai/api/v1 LENSPACK_LLM_API_KEY=… LENSPACK_LLM_MODEL=z-ai/glm-4.5 pnpm demo
```

Or point an MCP client at it and let the model build the board:

```bash
npx lenspack-mcp --pack examples/commerce/pack.yaml --db ./commerce.duckdb
```

```json
{ "mcpServers": { "commerce": { "command": "npx", "args": ["lenspack-mcp", "--pack", "examples/commerce/pack.yaml", "--db", "./commerce.duckdb"] } } }
```

Then: *"Put revenue for the last 30 days as a KPI across the top, weekly revenue below it, and a pie of line revenue by category."* Every step is a validated op; every refusal names the nearest real key.

## What is in the box

| package | what it is | depends on |
|---|---|---|
| `@lenspack/core` | board config schema, the query IR, the eight ops, packing, validation, `nearest()`, in-memory store | zod |
| `@lenspack/spec` | pack loader: YAML/JSON → validated catalogue | core |
| `@lenspack/engine` | the backend-neutral half: resolve (keys, join paths, fan-out refusal, tenancy, time, capability refusals), the `Connector` interface, `run` / `explain` / `checkOps`, cross-entity ratios | core, spec |
| `@lenspack/sql` | `sqlConnector()` and the driver registry: compiler (plan → print) and read-only drivers for **Postgres, DuckDB, SQLite, MySQL/MariaDB and ClickHouse**, chosen by connection URL; cache, SQL board store | engine |
| `@lenspack/elasticsearch` | `elasticsearchConnector()`: the IR as aggregations over plain HTTP — **Elasticsearch 6.x–8.x and OpenSearch**; text→keyword from the mapping; approximate aggregations flagged ≈ | engine |
| `@lenspack/react` | `<BoardProvider>`, `<Board>`, `<FilterBar>`, `<VersionHistory>`, `useBoardOps()`; chart adapters for **recharts, ECharts, shadcn** and a zero-dependency SVG fallback | core, react-grid-layout (chart libraries are optional peers) |
| `@lenspack/mcp` | `boardTools()` — provider-agnostic tool definitions — plus `toVercelAI()`, `toMcp()` and the `lenspack-mcp` CLI | core, spec, engine |
| `@lenspack/serve` | the `lenspack` CLI: `serve` (board API + chat with review, from a `lenspack.yaml`), `check`, `sources`, `dss` | all of the above |
| `@lenspack/dss` | compiles DIGIT DSS `ChartApiConfig.json` into a pack and boards, with a report of what did not translate | core, spec, engine |

## Installing from GitHub Packages

Releases are published to GitHub Packages under the `theflywheel` org as `@theflywheel/lenspack-<name>`: `core`, `spec`, `engine`, `sql`, `elasticsearch`, `react`, `mcp`, `serve`, `dss` and `ccrs`. Point the scope at the registry in your project's `.npmrc`:

```ini
@theflywheel:registry=https://npm.pkg.github.com
```

Installing needs a GitHub token with the `read:packages` scope, even for public packages (`//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}` in `~/.npmrc`, or `NODE_AUTH_TOKEN` in CI). Install under the names the code and these docs use, as npm aliases:

```json
"dependencies": {
  "@lenspack/core": "npm:@theflywheel/lenspack-core@^0.1.0",
  "@lenspack/react": "npm:@theflywheel/lenspack-react@^0.1.0"
}
```

Every import shown here, subpaths included (`@lenspack/react/adapters/shadcn`, `@lenspack/react/styles.css`, `@lenspack/sql/pg`), then works unchanged. The packages depend on each other through the same aliases, so you only list the ones you import.

## Sources

A pack says what the numbers mean; a **connector** says where they live. The
same pack runs on any connector when it names data with `field:` and `where:`
rather than SQL fragments, and CI holds that to account: the `campaign`
example (DIGIT DSS's index shapes, synthetic data) returns identical numbers
from DuckDB and a real Elasticsearch on 77 queries.

A SQL source is a **connection URL**, and its scheme picks the driver:
`postgres://`, `duckdb:`, `sqlite:`, `mysql://` (MariaDB too) or
`clickhouse://`. lenspack sends a driver SQL text and bound parameters,
nothing else; the driver runs it read-only, one statement at a time, under a
timeout and a row cap. Adding a database is `registerDriver()` and a test
suite, with no change to the core. See [docs/drivers.md](docs/drivers.md).

```yaml
# lenspack.yaml — secrets are env: references, never values
sources:
  search: { kind: elasticsearch, url: env:ES_URL, apiKey: env:ES_API_KEY }
  shop:   { url: env:DATABASE_URL }                # postgres://, mysql://, clickhouse://, sqlite:…
  local:  { url: "duckdb:./data/shop.duckdb" }
packs:
  - { pack: ./packs/campaign/pack.yaml, source: search, boards: ./packs/campaign/boards }
store: { kind: duckdb, path: ./data/boards.duckdb }   # boards never live in a source
```

```sh
lenspack sources --config lenspack.yaml     # what each source holds: tables, columns, types, rows
lenspack check   --config lenspack.yaml     # draw every board; exit 1 on any error
lenspack serve   --config lenspack.yaml     # the board API on :8787
```

A search index cannot join, so a dimension on another entity is refused with
the dimensions it *can* group by, unless the pack declares it on both with
`also:`. A ratio across entities (delivered / target) is two aggregates joined
on the group, never a row-level join; a target with no time divides every
period.

### Coming from DIGIT DSS

```sh
lenspack dss ChartApiConfig.json --dashboards MasterDashboardConfig.json --out packs/dss
```

On the 140-chart health config: 124 charts translate (48 exactly, the rest
with notes), 343 drawn numbers become 118 measures, and `report.md` lists
what did not translate (painless scripts, date_range, differences of
measures) and the 13 target/stock numbers DSS stores once per hierarchy level.

## A pack

```yaml
pack: commerce
version: 1
entities:
  orders:
    source: orders
    grain: one row per order
    time: placed_at
    joins:
      - { to: customers, on: orders.customer_id = customers.id, type: many_to_one }
  customers: { source: customers, grain: one row per customer }
dimensions:
  - { key: country, entity: customers, sql: country, synonyms: [market, region] }
  - { key: status,  entity: orders,    sql: status, type: enum }
measures:
  - { key: orders,      entity: orders, agg: count }
  - { key: revenue,     entity: orders, agg: sum, sql: total_cents / 100.0, format: currency }
  - { key: aov,         entity: orders, derived: revenue / orders, format: currency }
  - { key: refund_rate, entity: orders, agg: avg, sql: "CASE WHEN status = 'refunded' THEN 1 ELSE 0 END", format: percent }
```

Humans write the `sql:` fragments and review them in git, portable or per dialect. The model only ever names keys. See [docs/pack-spec.md](docs/pack-spec.md) and [docs/writing-a-pack.md](docs/writing-a-pack.md).

## A query

Four shapes, closed. Every string is a key the pack must know.

```ts
{ kind: "breakdown", dimension: "country", measure: "revenue", limit: 10 }
{ kind: "series",    measure: "orders", grain: "week", by: "channel", time: { last: "12w" } }
{ kind: "value",     measure: "refund_rate", compare: "previous_period", time: { last: "30d" } }
{ kind: "rows",      entity: "orders", columns: ["status", "channel"], limit: 20 }
```

The compiler guarantees, and property tests check, that every identifier in the SQL came from the pack, every value is a bound parameter, the tenant predicate is present whenever an entity declares one, `LIMIT` is always emitted, and **a fan-out is refused rather than computed** — asking for an order-level measure by a dimension that lives across a one-to-many join is a compile error with a hint, not a silently inflated number. See [docs/query-ir.md](docs/query-ir.md).

## What "generic" means here, and how CI proves it

lenspack was extracted from a public-consultation moderation tool where the dashboard logic was hard-wired to one schema. To make sure the abstraction is real rather than claimed, the repository ships five example packs that stress different axes, and CI runs five checks against them:

| pack | what it stresses |
|---|---|
| [`commerce`](examples/commerce) | star schema, money, ratios, percentiles, the fan-out trap |
| [`events`](examples/events) | one wide table, every time grain, `count_distinct`, high cardinality, a per-dialect fragment |
| [`consultation`](examples/consultation) | JSON paths, multilingual text, multi-tenancy, LLM-derived themes and signals as *ordinary* joined dimensions |
| [`tickets`](examples/tickets) | state history, durations, SLA breach as a filtered rate, a funnel |
| [`hcm`](examples/hcm) | a real-world awkward schema (DIGIT HCM shape): epoch-millisecond `BIGINT` times, `isdeleted` on every table, dual keys, JSON in text columns, dotted hierarchies, fan-out on every side |

1. **Every engine, same answer.** Every example board, and every dimension × measure × shape of every pack, runs on Postgres, MySQL, MariaDB, SQLite and ClickHouse and must return DuckDB's numbers. A percentile on a database with no percentile function (MySQL, SQLite) must come back as the documented refusal and nothing else may. Golden files pin the SQL each dialect prints.
2. **One ops suite, four packs.** The core's tests run parametrised over every catalogue.
3. **Zero-domain grep.** CI fails if `packages/*` contains a word from any example domain.
4. **Pack conformance.** Every dimension × measure × query shape compiles, or fails with a documented `ResolveError`; every declared fan-out is refused; tenant injection is present.
5. **The fifth pack.** [docs/writing-a-pack.md](docs/writing-a-pack.md) walks through a new dataset; the target is under an hour with no change under `packages/`.

## Using it in your own app

```ts
import { loadPack, catalogueFrom } from "@lenspack/spec";
import { resolveBoard, sqlStore } from "@lenspack/sql";
import { openPostgres } from "@lenspack/sql/pg";
import { boardTools, toVercelAI } from "@lenspack/mcp";

const pack = await loadPack("./packs/commerce.yaml");
const db = await openPostgres(process.env.DATABASE_URL!);
const store = sqlStore(db); await store.migrate();

// Data for a board (one scan per distinct query):
const data = await resolveBoard(board.config, { pack, executor: db.executor, ctx: { tenant } }, selections);

// Tools for your own agent loop (Vercel AI SDK shown; toMcp() for MCP):
const tools = toVercelAI(boardTools({ pack, executor: db.executor, store, boardId, ctx: { tenant } }));
```

```tsx
import { BoardProvider, Board, FilterBar, VersionHistory } from "@lenspack/react";
import "@lenspack/react/styles.css";

<BoardProvider board={board} catalogue={catalogue} host={{ loadBoardData, applyOps, saveLayout, loadFilterOptions, loadVersions, revertTo }}>
  <FilterBar /> <VersionHistory /> <Board />
</BoardProvider>
```

The renderer never touches a database or a model: everything arrives through the `host` callbacks, so it sits in front of a Next.js route, an Express server or anything else.

### Charting libraries are adapters

A chart widget builds a `ChartSpec` — pivoted rows, series keys, a formatter, a palette of CSS variables — and hands it to whichever adapter the provider holds. The board config never changes; only the library does, and it can change at runtime (try the "charts:" selector on the live demo).

```tsx
import { rechartsAdapter } from "@lenspack/react/adapters/recharts";   // recharts ≥ 3
import { createEchartsAdapter } from "@lenspack/react/adapters/echarts"; // canvas, imperative
import { createShadcnAdapter } from "@lenspack/react/adapters/shadcn";   // your copy of shadcn's chart.tsx
import { svgAdapter } from "@lenspack/react/adapters/svg";               // no dependencies; the default

<BoardProvider charts={rechartsAdapter} …>
<BoardProvider charts={createShadcnAdapter(shadcnChart, { palette: ["var(--chart-1)", "var(--chart-2)"] })} …>
```

Writing your own is one component: `{ name, Chart: ({ spec }: { spec: ChartSpec }) => … }`. Adapters get the spec, never the board config, so "no colours in the config" still holds — a scheme name maps to CSS variables in core, and canvas libraries resolve them with `resolveCssVar()`. The conformance test in `packages/react/test/adapters.test.tsx` runs every adapter through every chart kind.

## Security model

- The model's only outputs are ops and IR, both closed unions validated before anything touches a database.
- No URLs, HTML or colours in any config; text widgets render as text nodes.
- Tenancy is structural: if an entity declares `tenant`, a query without one does not compile.
- Every query runs read-only, one statement at a time, under a statement timeout and a row cap, enforced by the database's driver rather than trusted from the SQL; boards are stored apart from the data.
- **Who is asking** is the deployment's answer, not lenspack's: an `access(request)` hook (or `auth:` in `lenspack.yaml`) names the caller, their tenant, their row scope and whether they may edit. Unknown callers get 401; viewers cannot change boards.
- **Row scope** (`ctx.scope`) narrows every query, filter menus included, on every connector. A number the scope cannot reach is refused (`OUT_OF_SCOPE`), never shown unnarrowed.
- Every change, refused change and denied request is passed to an `audit` hook with the user (`audit: file.jsonl` in the config).
- `run_sql` is off by default; when on, it is one SELECT/WITH, read-only, timeboxed, row-capped, and its results can never become a widget. It bypasses the pack, so on a tenant-scoped pack it is refused unless enabled as `role-scoped`, meaning the database role is the fence.
- Pack `sql` fragments are trusted code. Review them like code.

```yaml
# lenspack.yaml — no auth block: 127.0.0.1 only. `auth: { kind: none }` opens it, on purpose.
auth:
  kind: tokens                     # or: proxy (a login proxy's user header, trusted only with its shared secret)
  users:
    - { user: ops,  token: env:OPS_TOKEN, edit: true }
    - { user: kenya, token: env:KE_TOKEN, tenant: ke, scope: [{ dimension: province, op: in, value: [Nairobi] }] }
audit: ./audit.jsonl
```

More in [docs/security.md](docs/security.md).

## Status

`0.1.0`. The design spec is in [docs/superpowers/specs](docs/superpowers/specs/2026-09-22-lenspack-design.md). Not yet built: rollups/pre-aggregation, catalogue retrieval by embedding (packs with hundreds of metrics should scope `list_metrics` with `q`), warehouse drivers (BigQuery, Snowflake). Contributions, drivers and fifth packs welcome.

## License

Apache-2.0.
