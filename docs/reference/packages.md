# Packages

This page lists Lenspack's npm packages, what each holds and what it depends on, and how to install them. It is for
developers building Lenspack into their own code. Where each package sits in the design is in
[Architecture overview](../architecture/README.md#how-the-code-is-laid-out).

## The packages

| package | folder | what it is | depends on |
|---|---|---|---|
| `@lenspack/core` | `kernel/core` | the board format, the query format, the ten edit operations, packing the grid, checks, `nearest()`, an in-memory board store. No database, no React, no model | zod |
| `@lenspack/pack` | `kernel/pack` | the pack loader: YAML or JSON to a checked pack and its catalogue | core |
| `@lenspack/policy` | `kernel/policy` | who may see and change what: `principalOf()`, `decide()` (row scope, hidden keys, the pack and catalogue as one person sees them), `boardRights()`. Pure: the engine enforces what it decides | core, pack |
| `@lenspack/engine` | `kernel/engine` | the source-neutral half: resolving a query (keys, join paths, fan-out, tenancy, time, what the source can do), the `Connector` interface, `run`, `explain`, `checkOps`, `resolveBoard`, cross-entity ratios, the compute step | core, pack |
| `@lenspack/agent` | `kernel/agent` | `boardTools()`: the model's tools over any connector, with edits held and checked before they land; `toVercelAI()`; saved answers and the queue | core, pack, engine, policy |
| `@lenspack/sql` | `sources/sql` | `sqlConnector()` and the driver registry: the compiler (plan, then print) and read-only drivers for Postgres, DuckDB, SQLite, MySQL/MariaDB and ClickHouse, chosen by connection URL; a query cache; the SQL board store | engine |
| `@lenspack/elasticsearch` | `sources/elasticsearch` | `elasticsearchConnector()`: queries as aggregations over plain HTTP, for Elasticsearch 6.x–8.x (tested on 7.17) and OpenSearch; text fields read through their keyword sub-field; estimates marked ≈ | engine |
| `@lenspack/dss` | `packs/dss` | turns DIGIT DSS chart configs into a pack and boards, with a report of what did not translate | core, pack, engine |
| `@lenspack/ccrs` | `packs/ccrs` | turns a CCRS analytics KPI catalogue into a pack, boards and a skin map (which result column fills which part of each CCRS chart) | core, pack, engine, policy |
| `@lenspack/serve` | `hosts/serve` | the `lenspack` command: `serve` (the board API and the chat, from a `lenspack.yaml`), `check`, `sources`, `hash-password`, `dss`; sign-in, the admin panel, metering | the kernel and sources |
| `@lenspack/superset` | `hosts/superset` | Lenspack inside Apache Superset: the catalogue from Superset's datasets, numbers from Superset's chart API, boards kept in step with Superset's dashboards, and the Python plugin | core, pack, engine, policy, serve |
| `@lenspack/react` | `hosts/react` | `<BoardProvider>`, `<Board>`, `<FilterBar>`, `<VersionHistory>`, `useBoardOps()`; a chart adapter seam with a dependency-free SVG adapter (the default) and recharts | core, react-grid-layout (recharts is an optional peer) |
| `@lenspack/mcp` | `hosts/mcp` | `createMcpServer()` and the `lenspack-mcp` command (stdio or streamable HTTP); re-exports `@lenspack/agent` | agent, sql |

Subpaths: `@lenspack/sql/pg`, `/duckdb`, `/mysql`, `/sqlite` and `/clickhouse` open each database;
`@lenspack/react/adapters/svg` and `/recharts` are the chart adapters; `@lenspack/react/styles.css` is the default
stylesheet; `@lenspack/superset/server` is the Superset server.

## Installing from GitHub Packages

Releases are published to GitHub Packages under the `theflywheel` org as `@theflywheel/lenspack-<name>`: `core`,
`pack`, `policy`, `engine`, `agent`, `sql`, `elasticsearch`, `dss`, `ccrs`, `serve`, `superset`, `react` and `mcp`.
They are not on the public npm registry. Point the scope at GitHub's registry in your project's `.npmrc`:

```ini
@theflywheel:registry=https://npm.pkg.github.com
```

Installing needs a GitHub token with the `read:packages` scope, even for public packages
(`//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}` in `~/.npmrc`, or `NODE_AUTH_TOKEN` in CI). Install under the
names the code and these docs use, as npm aliases:

```json
"dependencies": {
  "@lenspack/core": "npm:@theflywheel/lenspack-core@^0.1.0",
  "@lenspack/react": "npm:@theflywheel/lenspack-react@^0.1.0"
}
```

Every import in these docs, subpaths included, then works unchanged. The packages depend on each other through the
same aliases, so you only list the ones you import.

The commands work the same way. With the `.npmrc` above, `npx --package @theflywheel/lenspack-mcp lenspack-mcp …`
runs the MCP server, and `npx --package @theflywheel/lenspack-serve lenspack …` the server. From a clone, run
`pnpm install && pnpm build`, then `node packages/hosts/mcp/dist/cli.js …` or `node packages/hosts/serve/dist/cli.js …`.
The server is also an image: see [Deploying](../operating/deploying.md).

## Upgrading from 0.1.0

The pack loader `@lenspack/spec` is now `@lenspack/pack` (published as `@theflywheel/lenspack-pack`). Its exports
are unchanged; change the import path and the dependency name. The packages now sit in folders by job
(`packages/kernel`, `sources`, `packs`, `hosts`), which changes no package name. See
[Upgrading](../operating/upgrading.md).

---

**Next:** [Evals](evals.md).

**Related:** [Architecture overview](../architecture/README.md) · [React components](../hosts/react.md) ·
[Write a host](../extending/write-a-host.md)
