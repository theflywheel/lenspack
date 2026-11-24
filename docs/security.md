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
- DuckDB: one statement, prepared and run only if it is a `SELECT`; interrupted on timeout. A source file is opened `READ_ONLY` with external access off and its settings locked, so nothing can read past it or turn that access back on (an in-memory source also has external access off).
- SQLite: the file is opened read-only, every statement must be one SQLite marks read-only, and the connection runs in a worker thread that is ended on timeout.
- MySQL and MariaDB: a read-only session and a read-only transaction per statement, the server's statement timer, prepared statements.
- ClickHouse: `readonly=2`, `max_execution_time` and `max_result_rows` on every request.

Use a read-only database role in production; these are belts, the role is the braces. Seeding and the board store use a separate `Writer` that is never handed to a tool.

## `run_sql`

Off by default, and refused on a pack with tenant-scoped entities or a caller scope: raw SQL does not pass through the pack, so neither applies to it. There it can be enabled only as `runSql: "role-scoped"` (`--run-sql-role-scoped`), which states that the database role behind the connection already limits what it can read. When enabled: one statement, `SELECT`/`WITH` by shape, wrapped in `SELECT * FROM (…) LIMIT n`, executed through the read-only driver, whose own guards apply as well. No keyword denylist — a denylist cannot know what a function does; the role and the transaction mode are the guards. Results are returned to the caller and cannot be attached to a widget: if an answer is worth keeping, `propose_measure` it and let a human promote it.

## Tenancy

An entity that declares `tenant` cannot be queried without one; the predicate is pushed into that entity's subquery. The tenant value comes from the host's `ctx`, never from the model.

## Callers: who, which rows, what they may change

The deployment identifies each caller through an `access(request)` hook, or `auth:` in `lenspack.yaml` (`LENSPACK_AUTH` overrides its kind):

- `password`, the default: one built-in user, `admin`, with a password from `LENSPACK_ADMIN_PASSWORD` (or a scrypt hash in `LENSPACK_ADMIN_PASSWORD_HASH`). With neither, a random one is made at first start: only its hash is kept, and the password is written once to a 0600 file whose name is logged. The comparison is constant-time, wrong passwords back off per address (or per signed-in browser) and against a shared budget, and a new password ends old sessions. Put TLS in front. lenspack keeps no other users.
- `tokens`: bearer tokens the deployment issues, each an `env:` reference, compared in constant time.
- `oidc`: lenspack signs people in with an OpenID Connect provider itself (code flow with PKCE, the ID token's signature and claims checked, a signed session cookie). Roles come from the token's claims.
- `proxy`: a login proxy in front names the user in a header, and optionally their roles in another. The headers are believed only when the request carries the proxy's shared secret (16+ characters), so a caller who reaches lenspack directly cannot claim to be anyone.
- `none`: open, for a local demo, and it must be written down. It listens on 127.0.0.1 unless `host:` says otherwise; opened by `LENSPACK_AUTH` (over a config that names another kind or none at all), only `--host` moves it.

The answer is a principal: `{ user, roles?, tenant?, scope?, edit?, maintain?, usage?, packs? }`.

- **Unknown caller:** 401 on every API path. A pack outside `packs` answers 404, as if it did not exist.
- **Tenant:** narrows the pack's tenancy; it can never move a pack the config pins to another tenant (403).
- **Scope:** filter clauses added to every query in resolution — boards, filter menus, explain, chat tools — on every connector. A query whose root cannot be narrowed by a scope dimension is refused with `OUT_OF_SCOPE` rather than answered for all rows. Cached results are keyed by the compiled statement and its parameters, so one caller's rows are never served to another.
- **Edit:** every non-GET request (ops, layout, revert, chat, create, copy, share, delete) needs it; a viewer gets 403. It lets a caller make boards of their own and change, share and delete those.
- **Boards have owners:** a board someone makes is theirs. Until they share it, nobody else sees it (404, as if it did not exist); once shared, others in the same tenant may read it and save a copy, not change it. The pack's own boards, from its board files, have no owner: everyone reads them, and only a caller with `maintain` changes them. A changed board file lands as a new version at the next start, so an edit made in the app stays in the history. `editors` and `maintainers` name who gets which, for every kind (`"*"` for everyone signed in); `admin` under `password` has both, and so does the one local user under `none`.
- **Pack access:** a pack's `access:` rules decide, by role, whether a caller sees the pack at all, which of its keys they may use and which rows. A query naming a hidden key is refused in resolution (`NOT_PERMITTED`) on every path, and the catalogue, the chat's prompt and tools leave hidden keys out. See [access.md](access.md).
- **Audit:** every change, refused change and denied request goes to the `audit` hook with the user, pack, board and outcome (`audit: ./audit.jsonl` appends JSON lines).

## The MCP host

`lenspack-mcp` is one identity, the person who started it: it has no sign-in and does not go through `decide()`, so `lenspack.yaml` access rules do not apply to it. Over stdio only the client that started it can reach it. Over HTTP it listens on `127.0.0.1` and refuses a request whose `Host` is not a loopback name or whose `Origin` is not its own, so a web page cannot drive it; any other address needs a bearer token (`--token` or `LENSPACK_MCP_TOKEN`). It opens `--db` as a read-only source and keeps boards in a separate store. See [the package README](../packages/hosts/mcp/README.md).

## Pack fragments are code

`sql:` and `filter:` fragments are inlined verbatim. They are trusted because they come from the pack file. Review pack changes the way you review migrations.

## Reporting

Please report vulnerabilities privately to contact@theflywheel.in.
