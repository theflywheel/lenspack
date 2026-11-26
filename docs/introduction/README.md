# What Lenspack is

This page explains the problem Lenspack solves, the idea behind it, and who it is for. Read it first if you are
deciding whether Lenspack fits your team.

## The problem

A dashboard answers the questions someone thought of when they built it. The people who read it ask others every
day: "which region is behind this week?", "how does that compare with last month?", "what is the average per
day, counting the days with none?". Today they wait for an analyst, or they export to a spreadsheet and work it out
by hand, and the numbers drift apart.

Putting a chat model on top of the data seems like the fix. But a model that writes its own SQL makes numbers
nobody can check. It joins tables the wrong way and counts orders twice. It forgets a filter. It reads "this
month" one way today and another way tomorrow. The answer looks confident either way.

## The idea

**A dashboard is data, not code.** Lenspack keeps three things apart:

1. **A pack**, written once by someone who knows the data and reviewed like code. It names the tables, how they
   join, what you can group by (dimensions) and what you can count (measures).
2. **A board**: a dashboard as a small document of widgets, filters and layout. Nothing in it is code, SQL, markup
   or a colour value.
3. **A compiler** that turns a request naming pack keys into a safe query, or refuses it with a reason and the
   nearest key that would work.

The model sits on top. It never writes SQL. It asks for numbers by naming keys from the pack, such as `revenue`
by `country` for the last 30 days, and it changes a board through a short list of checked edits. Everything it
asks for passes through the compiler, so what the pack does not declare cannot be built, and a mistake becomes a
refusal rather than a wrong number.

```
pack.yaml  ──►  catalogue  ──►  the model names keys  ──►  edits  ──►  board (JSON)
                    │                                                     │
                    └──────────►  compiler (resolve → plan → print)  ◄────┘
                                          │
         Postgres · ClickHouse · DuckDB · SQLite · MySQL · Elasticsearch · Superset
```

Every answer shows how it was worked out: the measure behind each figure, the SQL that ran and the rows that came
back. Who may see what comes from the app Lenspack runs inside, and Lenspack can only narrow it.

## Who it is for

- **Teams that run dashboards for others**, such as a data team, an operations team or a programme office, and
  want their readers to self-serve without losing control of what the numbers mean.
- **People who read dashboards** and have a question the dashboard does not answer. They need no SQL and no
  training: they type or speak a question in their own language.
- **Platform owners** who already run Apache Superset and want an assistant inside it that follows Superset's own
  permissions.
- **Developers** who want to put checked, editable boards inside their own app, or give an AI assistant safe access
  to a database through the Model Context Protocol (MCP).

## Where it runs

Lenspack is a set of packages. You can run it in three ways:

- **Inside Apache Superset.** One Python file in Superset's config and one Lenspack server. The chat appears on
  every dashboard, reads Superset's datasets, and keeps its boards as Superset dashboards. See
  [Apache Superset](../hosts/superset/README.md).
- **On its own.** The `lenspack serve` command reads a config file, connects to your databases and serves a board
  app with the chat. See [the standalone server](../hosts/serve.md).
- **Inside your app.** React components draw boards, and the agent's tools plug into your own model loop or any
  MCP client. See [React](../hosts/react.md) and [MCP](../hosts/mcp.md).

## Where it came from

Lenspack was taken out of a public-consultation moderation tool whose dashboard logic was tied to one database
schema. To keep the abstraction honest, the repository ships several example packs over very different data, and
its tests run every example on every supported database and fail the build when the answers differ. See
[Architecture](../architecture/README.md#claims-the-build-checks).

---

**Next:** [What you get](offerings.md): the parts of the product.

**Related:** [Concepts](../concepts/README.md) · [Quick start](../getting-started/quickstart.md)
