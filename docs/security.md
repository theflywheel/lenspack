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

## The driver's guarantees

Every SQL source is opened through a driver, and the driver, not the SQL, enforces four things on every statement: read-only, exactly one statement, a statement timeout and a row cap (a result over it is an error, not a shorter answer). How each database does it is in [drivers.md](drivers.md#the-guards-are-the-drivers); in short:

- Postgres: `BEGIN TRANSACTION READ ONLY` and `SET LOCAL statement_timeout` around every statement, always over the extended protocol, which takes one statement.
- DuckDB: one statement, prepared and run only if it is a `SELECT`; interrupted on timeout. A source file is opened `READ_ONLY` with external access off, so nothing can read past it.
- SQLite: the file is opened read-only, every statement must be one SQLite marks read-only, and the connection runs in a worker thread that is ended on timeout.
- MySQL and MariaDB: a read-only session and a read-only transaction per statement, the server's statement timer, prepared statements.
- ClickHouse: `readonly=2`, `max_execution_time` and `max_result_rows` on every request.

Use a read-only database role in production; these are belts, the role is the braces. Seeding and the board store use a separate `Writer` that is never handed to a tool.

## `run_sql`

Off by default, and refused on a pack with tenant-scoped entities or a caller scope: raw SQL does not pass through the pack, so neither applies to it. There it can be enabled only as `runSql: "role-scoped"` (`--run-sql-role-scoped`), which states that the database role behind the connection already limits what it can read. When enabled: one statement, `SELECT`/`WITH` by shape, wrapped in `SELECT * FROM (…) LIMIT n`, executed through the read-only driver, whose own guards apply as well. No keyword denylist — a denylist cannot know what a function does; the role and the transaction mode are the guards. Results are returned to the caller and cannot be attached to a widget: if an answer is worth keeping, `propose_measure` it and let a human promote it.

## Tenancy

An entity that declares `tenant` cannot be queried without one; the predicate is pushed into that entity's subquery. The tenant value comes from the host's `ctx`, never from the model.

## Callers: who, which rows, what they may change

lenspack keeps no users. The deployment identifies each caller through an `access(request)` hook, or `auth:` in `lenspack.yaml`:

- `tokens`: bearer tokens the deployment issues, each an `env:` reference, compared in constant time.
- `proxy`: a login proxy in front names the user in a header. The header is believed only when the request carries the proxy's shared secret (16+ characters), so a caller who reaches lenspack directly cannot claim to be anyone.
- `none`: open, and it must be written down. With no `auth:` block the server listens on 127.0.0.1 only.

The answer is a principal: `{ user, tenant?, scope?, edit?, packs? }`.

- **Unknown caller:** 401 on every API path. A pack outside `packs` answers 404, as if it did not exist.
- **Tenant:** narrows the pack's tenancy; it can never move a pack the config pins to another tenant (403).
- **Scope:** filter clauses added to every query in resolution — boards, filter menus, explain, chat tools — on every connector. A query whose root cannot be narrowed by a scope dimension is refused with `OUT_OF_SCOPE` rather than answered for all rows. Cached results are keyed by the compiled statement and its parameters, so one caller's rows are never served to another.
- **Edit:** every non-GET request (ops, layout, revert, chat, create, delete) needs it; a viewer gets 403.
- **Audit:** every change, refused change and denied request goes to the `audit` hook with the user, pack, board and outcome (`audit: ./audit.jsonl` appends JSON lines).

## Pack fragments are code

`sql:` and `filter:` fragments are inlined verbatim. They are trusted because they come from the pack file. Review pack changes the way you review migrations.

## Reporting

Please report vulnerabilities privately to contact@theflywheel.in.
