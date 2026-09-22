# lenspack — design spec

Date: 2026-09-22
Status: implemented 2026-09-22 (0.1.0); see README for what is deferred
Origin: extracted from `open-listening/iffy` (`lib/dashboard/*`, `lib/lens-config.ts`, `services/lenses.ts`, `ai/*-tools.ts`, `mcp/server.ts`, `app/dashboard/boards/*`)

## 1. Purpose

A dashboard is data, not code. A language model edits a validated document; the
server compiles it against a declared metric catalogue; the renderer is the only
code. iffy proved this works for one dataset. lenspack makes the same model work
for any dataset by turning the catalogue and the query layer into data.

Success criteria:

- A board authored against one pack renders from Postgres and from DuckDB with
  identical results.
- The core and compiler packages contain no knowledge of any domain (enforced
  by CI, §9.3).
- Writing a pack for a new dataset takes under an hour and touches nothing in
  `packages/`.
- The model can never cause a query the pack did not declare, a row from a
  tenant it cannot see, or a fan-out that silently inflates a number.

Non-goals for v1: a chat UI, an LLM provider integration, rollup/pre-aggregation
management, warehouse dialects beyond Postgres and DuckDB, the LLM extraction
pipeline that produces iffy's "signals".

## 2. Packages

Five packages in a pnpm monorepo. Dependencies point one way only.

| package           | contents                                                                                     | depends on             |
|-------------------|----------------------------------------------------------------------------------------------|------------------------|
| `@lenspack/core`  | board config schema, query IR types, ops, packing, validation, `nearest()`, `summarise()`, `BoardStore` interface + in-memory impl | zod only               |
| `@lenspack/spec`  | pack loader: YAML/JSON parse, schema validation, ref resolution, `catalogueFrom(pack)`       | core, zod, yaml        |
| `@lenspack/sql`   | resolve → plan → print; `postgres` and `duckdb` printers; `Executor` interface; `pg` and `duckdb` adapters; SQL `BoardStore` | core, spec             |
| `@lenspack/react` | `<BoardProvider>`, `<Board>`, grid, widget renderers, filter bar, version history, `useBoardOps()` | core, react, react-grid-layout, recharts |
| `@lenspack/mcp`   | `boardTools()` factory, `toVercelAI()` / `toMcp()` adapters, MCP server CLI (stdio + streamable HTTP) | core, spec, sql, @modelcontextprotocol/sdk |

`core` must remain importable in a browser and must never import a database
driver, React, or an LLM SDK.

## 3. The pack spec

A pack is one YAML (or JSON) document. Humans write it; it is reviewed in git;
the model only ever names keys from it.

```yaml
pack: commerce
version: 1
entities:
  orders:
    source: public.orders          # table or view; views preferred
    grain: one row per order        # documentation, surfaced to the model
    time: placed_at                 # default time column for series/value
    tenant: tenant_id               # optional; when present it is mandatory in every query
    joins:
      - to: customers
        on: orders.customer_id = customers.id
        type: many_to_one
  customers:
    source: public.customers
    grain: one row per customer
dimensions:
  - key: country
    label: Country
    entity: customers
    sql: country_code
    type: string                    # string | number | boolean | time | enum
    synonyms: [market, region]      # retrieval only
    hint: ISO-3166 alpha-2 of the shipping address.
  - key: placed_at
    label: Order date
    entity: orders
    sql: placed_at
    type: time
    grains: [day, week, month, quarter, year]
  - key: metadata_district          # JSON path example (consultation pack)
    entity: submissions
    json: [metadata, district]      # printer chooses ->> or json_extract_string
    type: string
measures:
  - key: revenue
    label: Revenue
    entity: orders
    agg: sum                        # count | count_distinct | sum | avg | min | max | median | p90
    sql: total_cents / 100.0
    format: currency
    verified: true
  - key: refund_rate
    entity: orders
    agg: avg
    sql: (status = 'refunded')::int # rate = average over base rows, never avg of avgs
    format: percent
    verified: true
  - key: aov
    entity: orders
    derived: revenue / orders       # ratio of two measures on the same entity
    format: currency
```

Rules enforced by `@lenspack/spec` at load time:

- `key`s are unique across dimensions and measures; `[a-z][a-z0-9_]*`.
- `entity` on every dimension and measure must exist.
- Every `join.on` references exactly the two entities named.
- `sql`, `json`, `derived` are mutually exclusive on a dimension/measure.
- `derived` may reference only measures on the same entity.
- `verified` defaults to `true` for a key in the pack file (the review that
  merged it is the verification); a proposal written by the model starts
  `false`. Unverified items are loadable and compilable but excluded from the
  model's tool surface (§7).
- The `sql` fragment is opaque to lenspack: it is inlined verbatim by the
  printer. It is trusted because it comes from the pack, never from a request.

`catalogueFrom(pack)` yields `{ dimensions, measures, entities }` with labels,
hints, synonyms, types, grains, and `verified` flags, and is the single input
to validation and to `list_metrics`.

## 4. Query IR

Closed union. Every string is a key that must exist in the catalogue; there is
no free-text field.

```ts
type Query =
  | { kind: "breakdown"; dimension: string; measure: string; limit: number; sort?: "asc"|"desc"; time?: TimeRange; filters?: Filter[] }
  | { kind: "series";    measure: string; grain: Grain; by?: string; time?: TimeRange; filters?: Filter[] }
  | { kind: "value";     measure: string; compare?: "previous_period"; time?: TimeRange; filters?: Filter[] }
  | { kind: "rows";      entity: string; columns: string[]; limit: number; orderBy?: { key: string; dir: "asc"|"desc" }; time?: TimeRange; filters?: Filter[] };

type Filter    = { dimension: string; op: "eq"|"neq"|"in"|"gte"|"lte"|"between"|"contains"; value: Scalar | Scalar[] };
type TimeRange = { last: `${number}${"h"|"d"|"w"|"m"}` } | { from: string; to: string };   // ISO-8601
type Grain     = "hour"|"day"|"week"|"month"|"quarter"|"year";
```

Mapping from iffy's five kinds: `lens → breakdown`; `volume → series(responses, day)`;
`overall → value`; `themes → breakdown(theme, priority)`; `signal → series` on a
measure the consultation pack declares from extraction columns.

`limit` is validated to `[1, 500]` for `rows`, `[2, 50]` for `breakdown`.
`series.by` yields at most 12 series (top by measure); the rest are dropped,
never bucketed as "other", to keep every number attributable.

## 5. Compiler (`@lenspack/sql`)

```
resolve : (Query, Pack, Ctx) → BoundPlan | ResolveError
plan    : BoundPlan → Ast
print   : (Ast, Dialect) → { sql: string; params: unknown[] }
```

`Ctx = { tenant?: string; now: Date }`.

**resolve** checks every key against the catalogue, chooses the measure's
entity as the root, finds the join path from root to each dimension's entity,
and produces a plan with all identifiers already bound to pack objects.
Fragments (`sql`, `filter`) may be given per dialect
(`{ postgres: …, duckdb: … }`); the printer picks the one for its engine.
`ResolveError` carries `{ code, key, nearest }` where `nearest` is the closest
catalogue key by edit distance — the same mechanism `ops.ts` uses for widget IDs.

**plan** builds an AST: select list, root source, join list, where (filters +
time range + tenant), group by, order by, limit. Rates and averages are
computed at root-row grain. `previous_period` compiles to two aggregates over
shifted ranges in one statement. `derived` measures expand to the ratio of
their operands' aggregates (`NULLIF` on the denominator).

**print** owns every dialect difference: identifier quoting, parameter
placeholders (`$n` vs `?`), JSON access (`->>` vs `json_extract_string`),
`date_trunc` and week start, casts, `percentile_cont` vs `quantile_cont`,
`count(distinct)`. Nothing above `print` mentions a dialect.

### 5.1 Invariants (each has a property test)

1. Every identifier in emitted SQL originates from the pack. No request string
   is ever interpolated.
2. Every request value is a bound parameter.
3. If the root entity declares `tenant`, the tenant predicate is present, or
   `resolve` fails with `TENANT_REQUIRED`. Callers cannot opt out.
4. `LIMIT` is always emitted and never exceeds the configured cap.
5. Read-only transaction and statement timeout are applied by the `Executor`,
   not expressed in SQL.
6. **Fan-out is refused.** A dimension may reach its entity from the measure's
   root entity only along `many_to_one` joins. Any `one_to_many` step on that
   path is `FANOUT_REFUSED`. v1 does not auto-rewrite to a pre-aggregated
   subquery; this is the safe default and can be relaxed later.
7. A rate measured over the whole corpus and the same rate per group compute
   over identical base rows; the only difference is the group by.

### 5.2 Executor and cache

```ts
interface Executor { execute(sql: string, params: unknown[], opts: { timeoutMs: number; readOnly: true }): Promise<Row[]> }
```

Adapters: `pgExecutor(pool)` (node-postgres; `SET TRANSACTION READ ONLY`,
`statement_timeout`), `duckdbExecutor(db)` (`@duckdb/node-api`; read-only
connection, interrupt on timeout).

`cachedExecutor(inner, cache)` keys on `(pack, packVersion, hash(Query), tenant)`;
default cache is in-memory LRU with TTL; interface allows Redis.

Rollups are out of scope for v1, but a `breakdown`/`series` plan already
exposes the `(entity, measure, dimension, grain)` tuple a rollup would key on.

## 6. Board config and ops (`@lenspack/core`)

Board config `version: 2`:

- adds `pack: string` and `packVersion: number`;
- `query` is the §4 IR;
- widgets, filters, grid, layout, placement-as-intent, packing, text-as-text,
  named colour schemes: unchanged from iffy;
- kpi `aggregate` (`sum|avg|max|min|count|last`) applies only when the KPI's
  query is a `series`.

`validateConfig(config, catalogue)` takes the catalogue as an argument.
`ops.ts` ports verbatim: `add_widget`, `update_widget`, `remove_widget`,
`move_widget`, `resize_widget`, `set_title`, `add_filter`, `remove_filter`,
plus `applyOps(config, ops, catalogue)` and `nearest()`.

`migrateKeys(config, { from, to })` renames metric keys across a board when a
pack renames one; it is a function, not an op.

`BoardStore`:

```ts
interface BoardStore {
  get(id): Promise<Board>;                 // Board = { id, pack, config, version, updatedAt }
  list(): Promise<BoardSummary[]>;
  create(pack, title): Promise<Board>;
  patch(id, ops, expectedVersion): Promise<Board>;   // new immutable version; optimistic concurrency
  versions(id): Promise<BoardVersion[]>;
  revertTo(id, version): Promise<Board>;   // creates a new version copying the old config
}
```

`core` ships `memoryStore()`; `sql` ships `sqlStore(executor)` using two tables
(`boards`, `board_versions`). Auth and tenancy around the store are the host
application's concern; lenspack never reads a session.

## 7. AI surface (`@lenspack/mcp`)

`boardTools({ pack, executor, store, options })` returns an array of
`{ name, description, inputSchema: ZodObject, execute(args, ctx) }`.
`toVercelAI(tools)` and `toMcp(tools)` adapt without changing behaviour.

Design carried over from iffy: tool arguments are flat scalars (nested
arguments were corrupted by weaker models); the server assembles ops; the
board is presented to the model through `summarise(config)`, a compact
row-per-widget text view, not JSON.

| tool              | behaviour |
|-------------------|-----------|
| `list_metrics`    | verified dimensions/measures with label, hint, type, grains, synonyms. `q` narrows by substring/synonym; an embedding retriever is a pluggable option, not a dependency. |
| `query`           | runs one IR query; returns rows and the compiled SQL. |
| `explain`         | compiles without executing; returns SQL and the resolved plan. |
| `get_board`       | `summarise(config)`. |
| `add_widget`, `update_widget`, `move_widget`, `resize_widget`, `remove_widget`, `add_filter`, `remove_filter`, `rename_board` | each validates, applies one op via the store, returns the new summary or a `ResolveError` with `nearest`. |
| `run_sql`         | **disabled unless `options.runSql = true`.** SELECT/WITH only by shape; executed read-only with timeout; may reference only the pack's entity sources; results are ephemeral and cannot be attached to a widget. |
| `propose_measure` | writes `{ key, entity, agg, sql, rationale, verified: false }` to `options.proposals` (a `ProposalStore`, default file-backed). A human promotes it by editing the pack. |

Not carried from iffy: `draftSignal`, `testSignal`, `saveSignal`, `signalTrend`
(extraction pipeline), `calculate` (unneeded).

MCP CLI:

```
npx @lenspack/mcp --pack ./packs/commerce.yaml --db postgres://… [--tenant t1] [--run-sql]
npx @lenspack/mcp --pack ./packs/events.yaml   --db ./events.duckdb --http 8787
```

## 8. Renderer (`@lenspack/react`)

Ported from `app/dashboard/boards/[boardId]/{grid,board-client,filter-bar,versions}.tsx`
and `components/ui/chart.tsx`, with Next.js coupling removed.

```tsx
<BoardProvider board={board} catalogue={catalogue}
               loadWidgetData={(query, filters) => …}
               applyOps={(ops) => …}>
  <Board widgets={{ chart: MyChart }} />   {/* optional overrides per widget kind */}
  <FilterBar /> <VersionHistory />
</BoardProvider>
```

- `useBoardOps()` exposes `apply`, `undo`, `pending`, so any chat or command
  palette can drive edits.
- Layout drag/resize emits `move_widget`/`resize_widget` ops through the same
  path as the model's edits.
- Palettes are CSS variables (`--lp-series-1..8`, `--lp-sequential-1..8`);
  configs keep naming schemes, never colours.
- Widget data loading is per widget with an abort signal; errors render inline
  with the `ResolveError.nearest` hint when present.

## 9. Examples and the genericity proof

### 9.1 Packs

Each example: `pack.yaml`, deterministic `seed.ts` (seeded PRNG; writes to
Postgres or DuckDB via the executor), `boards/*.json`, `README.md` listing the
questions it answers.

| pack           | shape it stresses | notable content |
|----------------|-------------------|-----------------|
| `commerce`     | star schema, money, ratios, fan-out trap | customers, products, orders, order_items; `revenue`, `aov` (derived), `refund_rate`, `units`; `order_items → orders` is `one_to_many` and must be refused for order-grain measures |
| `events`       | time grains, cardinality, distinct counts | ~2M pageviews in DuckDB (~200k in CI); `sessions = count_distinct(session_id)`, `bounce_rate`; `path` high-cardinality dimension; hour→year grains |
| `consultation` | JSON paths, multilingual text, LLM-derived columns, joined pseudo-dimensions | submissions (`metadata` JSON), extractions, themes, assignments; Hindi/English/Marathi synthetic text; `flagged_rate`, `redaction_rate`, `mean_severity`, `signal_*` measures; `theme` is an ordinary dimension on a joined entity. Synthetic only — never real consultation data |
| `tickets`      | state transitions, durations, percentiles, funnels | tickets + status_history; `median_time_to_resolve` (`percentile_cont` vs `quantile_cont`), `sla_breach_rate`, backlog `series`, status funnel `breakdown` |

### 9.2 Boards

Two or three per pack, saved as JSON, used as fixtures by §9.3.

### 9.3 CI checks that define "generic"

1. **Two engines, same answer.** Every example board compiles and runs on
   Postgres and DuckDB; results match golden JSON after normalisation.
2. **One ops suite, four packs.** The ported `dashboard-ops` tests run
   parametrised over every pack's catalogue.
3. **Zero-domain grep.** CI fails if `packages/core` or `packages/sql` contains
   any word from a domain list (`order`, `revenue`, `customer`, `pageview`,
   `session`, `district`, `submission`, `signal`, `theme`, `ticket`, `sla`,
   `moderation`, …) outside test fixtures.
4. **Pack conformance.** For each pack: every dimension × measure × query
   shape either compiles or fails with a documented `ResolveError`; every
   declared fan-out path is refused; tenant injection is present on every
   tenant-bearing entity.
5. **Fifth-pack exercise.** `docs/writing-a-pack.md` walks through a new
   dataset; the target (under an hour, no changes under `packages/`) is stated
   and re-checked at each release.

## 10. Testing and evals

- Unit and property tests with vitest + fast-check for §5.1.
- Postgres via a CI service container; DuckDB in-process.
- Golden-result fixtures per board per engine.
- Type-check and lint in CI; publish via changesets.
- `evals/`: a golden set of natural-language requests → expected ops per pack.
  Runs only with an API key set; reports op-validity rate, first-attempt
  success, and semantic correctness. Not part of the default CI gate.

## 11. Security model

- The model's only outputs are ops and IR; both are closed unions validated by
  zod before anything touches a database.
- No URLs, no HTML, no colour values in any config.
- Tenant predicate is structural (§5.1.3).
- `run_sql` is opt-in, read-only, timeboxed, shape-checked, and its results
  can never become a widget.
- Pack `sql` fragments are trusted code and must be reviewed like code.

## 12. Repository and publishing

- Repo: `github.com/theflywheel/lenspack`. npm scope `@lenspack` (org to be
  created on npm before first publish).
- License: Apache-2.0.
- Layout: `packages/{core,spec,sql,react,mcp}`, `examples/{commerce,events,consultation,tickets}`,
  `evals/`, `docs/`.
- pnpm workspaces, tsup, vitest, changesets; ESM only; Node ≥ 22; TypeScript 5.
- Docs: README (thesis, 60-second quickstart on DuckDB), `docs/pack-spec.md`,
  `docs/query-ir.md`, `docs/security.md`, `docs/writing-a-pack.md`.

## 13. Migration path for iffy

Out of scope for this spec, but the design must not preclude it: a
`consultation` pack authored against iffy's real tables (`records`,
`signal_extractions`, `analysis_assignments`, `analysis_themes`, `signals`),
with `latestCompletedRunId()` expressed as a view, and a one-off `migrateKeys`
run from iffy's v1 board configs to v2.

## 14. Open decisions

- Name `lenspack` and Apache-2.0 are provisional pending the user's confirmation.
- Whether `run_sql` ships in the MCP CLI at all, or only in the factory.

## 15. Build order

The plan should follow these milestones; each leaves the repo green and usable.

1. **M1 — vertical slice on DuckDB.** `core` (ported schema/ops/tests, IR,
   `memoryStore`), `spec` (loader + `catalogueFrom`), `sql` (resolve/plan/print
   with the DuckDB printer only, `duckdbExecutor`), `examples/commerce` (pack,
   seed, one board), zero-domain grep, conformance suite for one pack. Proves
   the abstraction on one dataset with zero infrastructure.
2. **M2 — second engine, two more shapes.** Postgres printer + `pgExecutor`,
   `sqlStore`, golden two-engine test, `examples/events` and `examples/tickets`
   (percentile seam, distinct counts, fan-out refusal covered).
3. **M3 — AI surface and the origin domain.** `mcp` (`boardTools`, adapters,
   CLI), `propose_measure` + `ProposalStore`, `examples/consultation` (JSON
   paths, joined `theme` dimension), `evals/` golden set.
4. **M4 — renderer, docs, publish.** `react` port, example Next.js demo,
   `docs/*`, changesets, first `0.1.0` publish under `@lenspack`.
