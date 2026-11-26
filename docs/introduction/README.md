# What Lenspack is

This page tells Lenspack's story: the problem, the idea, how it holds, and who it is for. Read it first if you are
deciding whether Lenspack fits your team. The [live demo](https://lenspack.proto.theflywheel.in) shows it working.

**A dashboard is data, not code.**

Declare your data once in a pack. After that a language model can answer questions over it, and build and edit
dashboards, by naming keys such as `revenue`, `country` and `refund_rate`, and nothing else. No SQL, no JSX, no
colour values. What the pack does not declare, the compiler will not build.

## The problem

A dashboard answers the questions someone thought of when they built it. The people who read it ask others every
day: "which region is behind this week?", "how does that compare with last month?", "what is the average per day,
counting the days with none?". Today they wait for an analyst, or they export to a spreadsheet and work it out by
hand, and the numbers drift apart.

Putting a chat model on top of the data seems like the fix. But a model that writes its own SQL makes numbers nobody
can check. It joins tables the wrong way and counts orders twice. It forgets a filter. It reads "this month" one way
today and another way tomorrow. The answer looks confident either way.

## The binding

Lenspack keeps three things apart:

1. **A pack**, written once by someone who knows the data and reviewed like code. It names the tables, how they
   join, what you can group by (dimensions) and what you can count (measures). It is a closed vocabulary.
2. **A board**: a dashboard as a small document of widgets, filters and layout. Nothing in it is code, SQL, markup
   or a colour value, so any charting library can draw it: the board never changes, only the renderer does.
3. **A compiler** that turns a request naming pack keys into a safe query, or refuses it.

The model sits on top. It asks for numbers by naming keys, such as `revenue` by `country` for the last 30 days, and
it changes a board through ten checked edit operations. It never writes SQL, and never writes to your data.

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

A mistake becomes a refusal, never a wrong number. Every answer that read data shows how it was worked out: the
measure behind each figure, the SQL that ran and the rows that came back.

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
      - to: customers
        on: orders.customer_id = customers.id
        type: many_to_one
measures:
  - { key: revenue, entity: orders,
      agg: sum, sql: total_cents / 100.0 }
  - { key: refund_rate, entity: orders,
      agg: avg, sql: "CASE WHEN status = 'refunded' THEN 1 ELSE 0 END" }
```

**2. Point a model at it.** The chat on your dashboards, inside Apache Superset or Lenspack's own server; any MCP
client; or the same tools inside your own agent. A small, cheap model is enough for most turns, and a stronger one
can check its edits before they are saved.

**3. Render it.** The renderer is the only code. It never reaches a database or a model, because data arrives through
host callbacks, and the charting library is an adapter you choose.

## Where it runs

- **Inside Apache Superset** 6.1 or 5.0. One Python file in Superset's config and one Lenspack server. The chat
  appears on every dashboard, reads Superset's datasets, keeps its boards as Superset dashboards, and shows each person
  only what Superset lets them see. See [Apache Superset](../hosts/superset/README.md).
- **On its own.** `lenspack serve` reads a config file, connects to your databases and serves a board app with the
  chat, sign-in, per-role access rules and an admin panel. See [The standalone server](../hosts/serve.md).
- **Inside your app.** React components draw boards, and the agent's tools plug into your own model loop or any MCP
  client. See [React](../hosts/react.md) and [MCP](../hosts/mcp.md).

Around the chat: voice input in several languages, saved answers that answer a repeated question without the model,
a reviewer that checks edits, an admin panel for definitions and open questions, and usage records. See
[What you get](offerings.md).

## Six shapes of data, one renderer

Each example pack stresses a different side of the design. Each is made-up data that seeds in seconds, and together
they are the test suite: every board runs on every supported database in CI, and the results must match.

| pack | what it stresses |
|---|---|
| `commerce` | a star schema, money and ratios, and a fan-out trap the compiler refuses |
| `events` | one wide table: every time grain, distinct counts, a high-cardinality dimension |
| `consultation` | text in several languages with JSON metadata, tenants, themes from a language model as joined dimensions |
| `tickets` | state history, durations, an SLA breach rate, a funnel read from transitions |
| `hcm` | a deliberately awkward registry: epoch-millisecond times, soft deletes, dotted hierarchies |
| `campaign` | search-index shapes: the same numbers from DuckDB and Elasticsearch |

More in [The example packs](../architecture/README.md#the-example-packs).

## What holds

Lenspack came out of a consultation tool whose dashboard logic was welded to one schema. These checks are what keep
the abstraction honest now that it is not. The build fails when one stops being true.

| check | what it holds |
|---|---|
| Every engine, same answer | every example board runs on Postgres, MySQL, MariaDB, SQLite and ClickHouse and must return DuckDB's numbers |
| One pack, two kinds of source | the `campaign` pack returns identical numbers from DuckDB and Elasticsearch |
| One edit suite, every pack | the core's tests run over every example catalogue, not just the one they were written for |
| No domain words in the code | the build fails if the kernel, the sources or the hosts contain a word from any example domain |
| Pack conformance | every dimension × measure × shape compiles or fails with a documented reason; declared fan-outs are refused; tenancy is present |
| The next pack | writing a pack for a new dataset takes under an hour and changes nothing under `packages/` |

The full list is in [Claims the build checks](../architecture/README.md#claims-the-build-checks).

## The guarantees

- The model's only outputs are edit operations and queries: closed formats, checked before anything reaches a
  database.
- Every identifier in the SQL comes from the pack; every value is a bound parameter; a `LIMIT` is always present.
- Tenancy is structural: an entity that declares a tenant cannot be queried without one.
- Who sees what comes from the app Lenspack runs inside, and Lenspack can only narrow it.
- Raw SQL is off by default. Switched on, it is read-only, timeboxed and capped, and its results can never become a
  widget.
- No URLs, no markup and no colour values in any board.

The safety model in full: [Why the model cannot break things](../architecture/safety.md).

## Who it is for

- **Teams that run dashboards for others**, such as a data team, an operations team or a programme office, and want
  their readers to self-serve without losing control of what the numbers mean.
- **People who read dashboards** and have a question the dashboard does not answer. They need no SQL and no
  training: they type or speak a question in their own language.
- **Platform owners** who already run Apache Superset and want an assistant inside it that follows Superset's own
  permissions.
- **Developers** who want to put checked, editable boards inside their own app, or give an AI assistant safe access
  to a database through the Model Context Protocol (MCP).

---

**Next:** [What you get](offerings.md): the parts of the product.

**Related:** [Concepts](../concepts/README.md) · [Quick start](../getting-started/quickstart.md) ·
[Live demo](https://lenspack.proto.theflywheel.in)
