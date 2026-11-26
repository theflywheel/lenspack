# Lenspack

**A dashboard is data, not code.**

Declare your data once in a pack. After that a language model can answer questions over it, and build and edit
dashboards, by naming keys such as `revenue`, `country` and `refund_rate`, and nothing else. No SQL, no JSX, no
colour values. What the pack does not declare, the compiler will not build.

People get a chat on their dashboards: inside Apache Superset, in Lenspack's own board app, in your React app, or in
any MCP client. They ask in their own words, or by voice, and every answer shows how it was worked out.

**[Documentation](docs/README.md)** · **[Live demo](https://lenspack.proto.theflywheel.in)** · Apache-2.0

```
pack.yaml  ──►  catalogue  ──►  the model names keys  ──►  edits  ──►  board (JSON)
                    │                                                     │
                    └──────────►  compiler (resolve → plan → print)  ◄────┘
                                          │
         Postgres · ClickHouse · DuckDB · SQLite · MySQL · Elasticsearch · Superset
```

## The refusal

A closed vocabulary is only useful if something enforces it. Ask for something the pack cannot answer and the
compiler declines, names the reason, and points at the nearest key that exists. On the commerce example:

| asked for | the compiler says |
|---|---|
| revenue by country | compiles, and returns the SQL it would run |
| revenue by product category | `FANOUT_REFUSED`: an order has many products, so grouping order revenue by category would count orders more than once. It offers line revenue instead |
| revenue by contry | `UNKNOWN_DIMENSION`, nearest key `country` |
| median order value | `UNKNOWN_MEASURE`: the pack declares no median, and the answer names the nearest measure that exists |

A mistake becomes a refusal, never a wrong number. The model never writes SQL, and never writes to your data.

## Three steps, and only the first is yours

**1. Describe the data once.** Entities, dimensions, measures and the direction of every join. A person writes this
and reviews it in git; the model never edits it. The `many_to_one` on a join is what lets the compiler refuse a
fan-out later.

```yaml
entities:
  orders:
    source: orders
    grain: one row per order
    time: placed_at
    joins:
      - { to: customers, on: orders.customer_id = customers.id, type: many_to_one }
measures:
  - { key: revenue, entity: orders, agg: sum, sql: total_cents / 100.0 }
  - { key: refund_rate, entity: orders, agg: avg, sql: "CASE WHEN status = 'refunded' THEN 1 ELSE 0 END" }
```

**2. Point a model at it.** The chat inside Superset or Lenspack's own server, any MCP client, or the same tools
inside your own agent. A small, cheap model does most turns; a stronger one can check its edits.

**3. Render it.** The renderer is the only code. It never reaches a database or a model, because data arrives through
host callbacks, and the charting library is an adapter you choose.

## Sixty seconds, no infrastructure

```bash
git clone https://github.com/theflywheel/lenspack && cd lenspack && pnpm install
pnpm seed commerce ./commerce.duckdb      # 5,000 made-up orders in a DuckDB file
pnpm demo                                 # http://localhost:5173: a board you can edit
```

Give it a model for the chat (any OpenAI-compatible endpoint, or Claude):

```bash
LENSPACK_LLM_BASE_URL=https://openrouter.ai/api/v1 LENSPACK_LLM_API_KEY=… LENSPACK_LLM_MODEL=z-ai/glm-4.5 pnpm demo
```

Then ask: *"Put revenue for the last 30 days as a KPI across the top, weekly revenue below it, and a pie of line
revenue by category."* The [Quick start](docs/getting-started/quickstart.md) goes on from here.

## Where it runs

- **[Inside Apache Superset](docs/hosts/superset/README.md)** 6.1 or 5.0: one Python file in Superset's config and one
  Lenspack server. Who sees what follows Superset's own roles and row-level security.
- **[On its own](docs/hosts/serve.md):** `lenspack serve` reads a config file, connects to your databases and serves
  the board app, the chat and an admin panel, with sign-in and per-role access rules.
- **[In your React app](docs/hosts/react.md):** the board components, with your own callbacks for data and edits.
- **[In any MCP client](docs/hosts/mcp.md):** `lenspack-mcp` gives a model the same board tools, for one person on
  their own machine.

## Six shapes of data, one renderer

The repository ships example packs over very different made-up data, and they are also the test suite: `commerce`
(a star schema and a fan-out trap), `events` (one wide table, every time grain), `consultation` (JSON, several
languages, tenants), `tickets` (state history, durations, a funnel), `hcm` (a deliberately awkward registry: epoch
times, soft deletes, dotted hierarchies) and `campaign` (search-index shapes, the same numbers from DuckDB and
Elasticsearch). See [The example packs](docs/architecture/README.md#the-example-packs).

## What holds

Claims that fail the build when they stop being true: every example board returns the same numbers on Postgres,
MySQL, MariaDB, SQLite, ClickHouse and DuckDB; one pack returns the same numbers from DuckDB and Elasticsearch; the
kernel contains no word from any example's domain; every dimension × measure × shape compiles or is refused with a
documented reason. See [Claims the build checks](docs/architecture/README.md#claims-the-build-checks) and
[Why the model cannot break things](docs/architecture/safety.md).

## Documentation

Start with [What Lenspack is](docs/introduction/README.md), then [Concepts](docs/concepts/README.md). The
[documentation home](docs/README.md) has the full contents, from aims to reference. Packages are installed from
GitHub Packages; see [Packages](docs/reference/packages.md).

`0.1.0`. What is not built yet is in [What Lenspack does not do](docs/introduction/limits.md). Contributions, drivers
and new example packs are welcome.

## License

Apache-2.0.
