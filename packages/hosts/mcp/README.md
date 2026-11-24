# @lenspack/mcp

Lenspack as tools for any MCP client. The `lenspack-mcp` command serves one pack and one board over stdio (the default) or streamable HTTP. The model reads and edits the board through the same tools the Lenspack chat uses, so every query goes through the pack: it cannot write SQL of its own unless you turn on `run_sql`.

```bash
npx lenspack-mcp --pack ./pack.yaml --db ./data.duckdb
```

```json
{ "mcpServers": { "data": { "command": "npx", "args": ["lenspack-mcp", "--pack", "./pack.yaml", "--db", "./data.duckdb"] } } }
```

## Who it is for

`lenspack-mcp` is a tool for one person on their own machine. It has no sign-in and no access rules of its own: whoever can reach it acts as you, with your `--tenant`, and can add and remove widgets on the board. Over stdio only the MCP client that started it can reach it. Over HTTP it listens on this machine only, unless you set a token (see [HTTP](#http)).

If several people need a board, run `lenspack serve` instead: it has sign-in, roles and per-person access rules.

## Options

| Option | What it does |
| --- | --- |
| `--pack <file>` | The pack to serve. Required. |
| `--db <url>` | The data. Required. A bare path is a DuckDB file; otherwise a URL: `postgres://…`, `mysql://…`, `clickhouse://…`, `sqlite:<file>` or `duckdb:<file>`. |
| `--store <where>` | Where the board is kept: a DuckDB file, a `postgres://…` URL, or `memory` (lost when the process ends). Default: `<pack name>.boards.duckdb` next to the pack file. It cannot be the data itself. |
| `--board <id>` | The board to edit. Default `default`. |
| `--tenant <t>` | The tenant every query is limited to, for a pack with tenant-scoped entities. |
| `--run-sql` | Offers `run_sql`, raw read-only SQL. Refused on a pack with tenant-scoped entities. |
| `--run-sql-role-scoped` | Offers `run_sql` on such a pack, when the database role behind `--db` already limits the rows it can read. |
| `--http <port>` | Serves streamable HTTP at `http://127.0.0.1:<port>/mcp` instead of stdio. |
| `--host <address>` | The address `--http` listens on. Default `127.0.0.1`. Any address other than this machine's needs a token. |
| `--token <token>` | The bearer token every HTTP request must carry. You can set `LENSPACK_MCP_TOKEN` instead, which keeps it out of the process list. |
| `--allow-origin <url>` | A web page origin allowed to call the HTTP server, such as `https://app.example.com`. Repeatable. |

## The data is read-only

The data is opened the same way `lenspack serve` opens a source: read-only, through the driver for its URL. Each driver refuses a write on its own (see [docs/drivers.md](../../../docs/drivers.md)). A DuckDB file is also opened with access to every other file turned off, and with its settings locked, so no statement can turn that access back on. `run_sql` therefore cannot read files such as `/etc/passwd` or `.env` with `read_csv` and the like, cannot write files with `COPY`, cannot `ATTACH` another database, and cannot `INSTALL` or `LOAD` extensions.

The board is kept apart from the data, in its own store (`--store`). For Postgres and the other server databases, still connect with a read-only database role: the driver's guards are a second line, not the first.

## HTTP

```bash
lenspack-mcp --pack ./pack.yaml --db ./data.duckdb --http 8787
```

By default the server listens on `127.0.0.1`, so only programs on this machine can reach it. It also refuses:

- a request whose `Host` header is not `localhost`, `127.0.0.1` or `[::1]`. This blocks DNS rebinding, where a web page points its own domain name at your machine.
- a request whose `Origin` header is not the server's own address or one you allowed with `--allow-origin`. Browsers send `Origin` with every cross-site request, so a web page you visit cannot call your tools. MCP clients that are not browsers send no `Origin` and are not affected.

To reach it from other machines, choose an address with `--host` and set a token. The server refuses to start without one.

```bash
export LENSPACK_MCP_TOKEN="$(openssl rand -hex 32)"
lenspack-mcp --pack ./pack.yaml --db ./data.duckdb --http 8787 --host 0.0.0.0
```

Each request must then send `Authorization: Bearer <token>`. Anyone with the token acts as you, as described above, so share it as you would a password. The token travels in plain text over HTTP: put the server behind HTTPS (a reverse proxy, or a private network such as a VPN) before it leaves your machine.

## As a library

```ts
import { boardTools, createMcpServer } from "@lenspack/mcp";
```

`createMcpServer(tools)` registers the agent's board tools on an MCP server. Connect it to any transport. The package also re-exports `@lenspack/agent`.
