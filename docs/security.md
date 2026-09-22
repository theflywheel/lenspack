# Security model

lenspack's premise is that the model's outputs are data with a closed grammar, and that everything with authority — table names, SQL fragments, tenancy — comes from a file a human reviewed.

## What the model can emit

- **Ops** on a board (`add_widget`, `move_widget`, …): eight discriminated variants validated by zod, with no op that replaces the widget map.
- **Queries** in the IR: four shapes, every string a catalogue key.
- Through `propose_measure`: a candidate written to a proposals file with `verified: false`. It does not enter the pack.

Anything else is rejected before it reaches a database.

## What a config can never contain

- URLs (widgets have no sources; the pack does).
- Markup: text widgets render as text nodes.
- Colours: configs name a scheme; the renderer maps it to CSS variables.
- Coordinates: placement is intent (`top`, `bottom`, `after:<id>`); the server packs and overlap is unrepresentable.

## The compiler's guarantees

Every identifier from the pack; every value a bound parameter; tenant predicate present or compile error; `LIMIT` always; fan-out refused. See [query-ir.md](query-ir.md).

## The executor's guarantees

- Postgres: `BEGIN TRANSACTION READ ONLY` and `SET LOCAL statement_timeout` around every statement. Use a read-only database role in production; the transaction mode is a belt, the role is the braces.
- DuckDB: the executor only runs compiled statements and interrupts the connection on timeout. Seeding and the board store use a separate `Writer` that is never handed to a tool.

## `run_sql`

Off by default. When enabled: one statement, `SELECT`/`WITH` by shape, wrapped in `SELECT * FROM (…) LIMIT n`, executed through the read-only executor. No keyword denylist — a denylist cannot know what a function does; the role and the transaction mode are the guards. Results are returned to the caller and cannot be attached to a widget: if an answer is worth keeping, `propose_measure` it and let a human promote it.

## Tenancy

An entity that declares `tenant` cannot be queried without one; the predicate is pushed into that entity's subquery. The tenant value comes from the host's `ctx`, never from the model.

## Pack fragments are code

`sql:` and `filter:` fragments are inlined verbatim. They are trusted because they come from the pack file. Review pack changes the way you review migrations.

## Reporting

Please report vulnerabilities privately to contact@theflywheel.in.
