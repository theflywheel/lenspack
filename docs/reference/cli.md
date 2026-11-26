# Command line

This page lists Lenspack's commands, their options and the repository's own scripts. It is for operators and
developers running Lenspack from a terminal.

## `lenspack`

The `lenspack` command comes from `@lenspack/serve` (and is the image's entry point).

| command | what it does |
|---|---|
| <a id="lenspack-serve"></a>`lenspack serve --config lenspack.yaml [--port 8787] [--host …] [--ui dir]` | the standalone server: the board API, the board app, the chat and the admin panel. The word `serve` may be left out: `lenspack --config lenspack.yaml` |
| `lenspack superset --config superset.yaml` | the chat inside Apache Superset (from `@lenspack/superset`). See [Install into Superset](../hosts/superset/install.md) |
| `lenspack check --config lenspack.yaml` | reads every pack (listing every problem), then draws every board against its source; exits 1 on any error. Run it before a restart |
| `lenspack sources --config lenspack.yaml [--source name]` | what each source holds: tables or indexes, fields, types and row counts. A first step when writing a pack |
| `lenspack hash-password` | a scrypt hash of the password read from standard input, for `LENSPACK_ADMIN_PASSWORD_HASH`. The password must be at least 12 characters; reading it from standard input keeps it out of the process list and shell history |
| `lenspack dss ChartApiConfig.json [--dashboards MasterDashboardConfig.json] [--placeholders PVAR,…] [--pack name] --out dir` | turns another system's chart configs into a pack, boards and a report. See [Importers](../extending/importers.md) |

`serve` reads the port from `--port`, then `port:` in the config, then `PORT`, then 8787. It listens on `--host`,
then `host:`, then `0.0.0.0` when a sign-in is set and `127.0.0.1` when `auth: none`. With `auth: none` set by
`LENSPACK_AUTH` over a config's own sign-in, only `--host` moves it off this machine, and it warns at start that anyone
who reaches it may read and edit every board.

## <a id="lenspack-mcp"></a>`lenspack-mcp`

The `lenspack-mcp` command comes from `@lenspack/mcp`. It serves one pack and one board to an MCP client.

```
lenspack-mcp --pack <pack.yaml> --db <url | file.duckdb> [options]
```

| option | what it does |
|---|---|
| `--db <url>` | the data, opened read-only: `postgres://…`, `mysql://…`, `clickhouse://…`, `sqlite:<file>`, `duckdb:<file>`, or a bare path to a DuckDB file |
| `--store <where>` | where boards are kept, apart from the data: a DuckDB file, `postgres://…`, or `memory` (default: `<pack name>.boards.duckdb` next to the pack) |
| `--board <id>` | the board to edit (default `default`) |
| `--tenant <t>` | the tenant every query is scoped to |
| `--run-sql` | offers `run_sql` (raw read-only SQL) on a pack without tenant scoping |
| `--run-sql-role-scoped` | offers `run_sql` where the database role already limits the rows |
| `--http <port>` | serves streamable HTTP at `/mcp` instead of standard input and output |
| `--host <address>` | the address `--http` listens on (default `127.0.0.1`, this machine only); any other address needs a token |
| `--token <token>` | the bearer token every HTTP request must carry (or `LENSPACK_MCP_TOKEN`) |
| `--allow-origin <url>` | a browser origin allowed to call the HTTP server (repeatable) |

See [MCP server](../hosts/mcp.md) for who it is for and how `run_sql` is kept safe.

## The repository's scripts

Run from a clone, after `pnpm install`.

| script | what it does |
|---|---|
| `pnpm seed <commerce\|events\|consultation\|tickets\|hcm\|campaign> <./file.duckdb \| postgres://…>` | seeds an example's made-up data |
| `pnpm demo` | the demo board app over every seeded `<name>.duckdb` in the folder given (`pnpm demo ./data`), else the current one. See [Quick start](../getting-started/quickstart.md) |
| `pnpm build` | builds every package |
| `pnpm check` | type checks, the no-domain-words check, the docs key tables and the tests |
| `pnpm test`, `pnpm test:pg`, `pnpm test:access` | the tests; against a Postgres at `LENSPACK_PG_URL`; the Superset access tests |
| `pnpm smoke:dist` | loads the built packages the way an outside project would |
| `pnpm docs:keys` | rewrites the generated key tables in [Configuration reference](config.md) and [Pack file reference](pack.md) |
| `pnpm eval`, `pnpm eval:suite` | the model evaluations. See [Evals](evals.md) |

---

**Next:** [Stream parts](stream-parts.md).

**Related:** [Configuration reference](config.md) · [Deploying](../operating/deploying.md) ·
[MCP server](../hosts/mcp.md)
