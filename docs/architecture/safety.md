# Why the model cannot break things

This page explains Lenspack's safety model: what a model can and cannot produce, and the checks that stand between
it and your data. It is for security reviewers and anyone who has to sign off on a deployment.

The premise: **the model's outputs are data with a closed grammar, and everything with authority (table names, SQL
fragments, tenancy, who someone is) comes from a file a person reviewed or from the host.**

## What the model can produce

- **Edit operations** on a board: ten kinds, each checked by its schema. There is no operation that replaces the
  whole board.
- **Queries**: five shapes, every string a catalogue key.
- **A proposed measure**, through `propose_measure`: written to a proposals file as unverified. It does not enter
  the pack.

Anything else is refused before it reaches a database.

## What a board can never contain

- **URLs.** Widgets have no sources; the pack does.
- **Markup.** Text widgets are drawn as text nodes.
- **Colours.** A board names a scheme; the renderer maps it to CSS variables.
- **Coordinates.** Placement is intent (`top`, `bottom`, `after:<id>`); the server packs the grid, so an overlap
  cannot be written down.

## The compiler's guarantees

Every identifier comes from the pack; every value is a bound parameter; a declared tenant is present or the query does
not compile; a `LIMIT` is always there; fan-out is refused. See [The life of a
query](life-of-a-query.md#the-invariants).

## The driver's guarantees

Every SQL source is opened through a driver, and the driver, not the SQL, enforces four things on every statement:
read-only, exactly one statement, a time limit, and a row cap (a result over it is an error, not a shorter
answer). How each database does it is in [SQL databases](../sources/sql.md#the-guards-belong-to-the-driver).

Use a read-only database role in production as well. The role is a second guard: if the driver's guards ever missed
something, the database would still refuse to write. Seeding and the board store use a separate writer that is never
handed to a tool or a model.

## `run_sql`

Off by default. It is a developer's escape hatch, not part of answering: the MCP server offers it with
`--run-sql`, and a program using the agent's tools with `runSql: true`. The standalone server and the Superset host
never offer it.

- On a pack with tenant-scoped entities, or for a caller with a row scope, it is refused: raw SQL does not pass
  through the pack, so neither applies to it. There it can be turned on only as `role-scoped`
  (`runSql: "role-scoped"`, or `--run-sql-role-scoped`), which states that the database role behind the connection
  already limits what it can read.
- For a caller with hidden keys or tables it is refused outright, since raw SQL would read past them.
- When on: one statement, `SELECT` or `WITH` by shape, wrapped in `SELECT * FROM (…) LIMIT n`, run through the
  read-only driver, whose own guards apply too.
- There is no keyword deny-list: a list cannot know what a function does. The role and the transaction mode are the
  guards.
- Its results go back to the caller and can never be attached to a widget. If an answer is worth keeping, propose a
  measure and let a person add it.

## Tenancy

An entity that declares a `tenant` cannot be queried without one; the condition is pushed into that entity's subquery.
The tenant comes from the host, never from the model. See [Row scope and tenancy](../access/scope-and-tenancy.md).

## Pack fragments are code

`sql:` and `filter:` fragments are copied into queries as written. They are trusted because they come from the
pack file, never from a request. Review pack changes the way you review database migrations. Anything that drafts a
pack automatically must not be allowed to write fragments.

## Errors do not leak the deployment

When a query fails, the model hears the reason, not the deployment's addresses: an unreachable source becomes "the
data source is unreachable (connection refused)", a slow one "did not answer in time", and any other error keeps
its wording with URLs, hosts, ports and IP addresses taken out. The raw error goes to the server log. Anything in a
stored statement that looks like a credential is masked as well.

## Reporting a vulnerability

Please report vulnerabilities privately to contact@theflywheel.in.

---

**Next:** [Claims the build checks](claims.md).

**Related:** [Who sees what](../access/README.md) · [Privacy and data handling](../operating/privacy.md)
