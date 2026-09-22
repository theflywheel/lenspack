# lenspack

**A dashboard is data, not code.** A language model edits a validated document; the server compiles it against a declared metric catalogue; the renderer is the only code.

**Live demo:** https://lenspack.proto.theflywheel.in — four synthetic packs, editable boards, version history.

lenspack is that idea as a library. You describe your data once in a *pack* — entities, dimensions, measures, joins — and any model, any chat, any MCP client can build and edit boards over it without ever writing SQL, JSX or a colour value. What the model cannot express, it cannot break.

```
pack.yaml  ──►  catalogue  ──►  the model names keys  ──►  ops  ──►  board config (JSON)
                    │                                                     │
                    └──────────►  compiler (resolve → plan → print)  ◄────┘
                                          │
                                 Postgres │ DuckDB
```

## Sixty seconds, zero infrastructure

```bash
git clone https://github.com/theflywheel/lenspack && cd lenspack && pnpm install
pnpm seed commerce ./commerce.duckdb          # 5,000 synthetic orders into a DuckDB file
pnpm demo                                     # http://localhost:5173 — a board you can edit
                                              # (seed more packs; the demo serves every <name>.duckdb it finds)
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
| `@lenspack/sql` | compiler (resolve → plan → print) for **Postgres** and **DuckDB**, read-only executors, cache, SQL board store | core, spec |
| `@lenspack/react` | `<BoardProvider>`, `<Board>`, `<FilterBar>`, `<VersionHistory>`, `useBoardOps()` | core, react-grid-layout, recharts |
| `@lenspack/mcp` | `boardTools()` — provider-agnostic tool definitions — plus `toVercelAI()`, `toMcp()` and the `lenspack-mcp` CLI | core, spec, sql |

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
  - { key: refund_rate, entity: orders, agg: avg, sql: "(status = 'refunded')::int", format: percent }
```

Humans write the `sql:` fragments and review them in git. The model only ever names keys. See [docs/pack-spec.md](docs/pack-spec.md) and [docs/writing-a-pack.md](docs/writing-a-pack.md).

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

lenspack was extracted from a public-consultation moderation tool where the dashboard logic was hard-wired to one schema. To make sure the abstraction is real rather than claimed, the repository ships four example packs that stress different axes, and CI runs five checks against them:

| pack | what it stresses |
|---|---|
| [`commerce`](examples/commerce) | star schema, money, ratios, percentiles, the fan-out trap |
| [`events`](examples/events) | one wide table, every time grain, `count_distinct`, high cardinality, a per-dialect fragment |
| [`consultation`](examples/consultation) | JSON paths, multilingual text, multi-tenancy, LLM-derived themes and signals as *ordinary* joined dimensions |
| [`tickets`](examples/tickets) | state history, durations, SLA breach as a filtered rate, a funnel |

1. **Two engines, same answer.** Every example board runs on Postgres and DuckDB; results must match.
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

## Security model

- The model's only outputs are ops and IR, both closed unions validated before anything touches a database.
- No URLs, HTML or colours in any config; text widgets render as text nodes.
- Tenancy is structural: if an entity declares `tenant`, a query without one does not compile.
- `run_sql` is off by default; when on, it is one SELECT/WITH, read-only, timeboxed, row-capped, and its results can never become a widget.
- Pack `sql` fragments are trusted code. Review them like code.

More in [docs/security.md](docs/security.md).

## Status

`0.1.0`. The design spec is in [docs/superpowers/specs](docs/superpowers/specs/2026-09-22-lenspack-design.md). Not yet built: rollups/pre-aggregation, catalogue retrieval by embedding (packs with hundreds of metrics should scope `list_metrics` with `q`), warehouse dialects. Contributions and fifth packs welcome.

## License

Apache-2.0.
