# Lenspack

Lenspack is an open-source assistant for dashboards. People ask questions and change dashboards in plain words,
inside Apache Superset or Lenspack's own app, and every number comes from definitions your team reviewed, never from
SQL a model wrote.

*A dashboard is data, not code.*

**[Documentation](docs/README.md)** · **[Live demo](https://lenspack.proto.theflywheel.in)** · Apache-2.0

You describe your data once, in a file your team reviews like code: its tables, what can be counted, what it can be
grouped by. The assistant can only name what that file declares. Ask for something it does not declare, or
something that would count rows twice, and you get a refusal with the reason and the nearest thing that would
work, never a wrong number. The model never writes to your data.

## Try it in a minute

You need Node.js 22 or later and pnpm 9.

```bash
git clone https://github.com/theflywheel/lenspack && cd lenspack && pnpm install
pnpm seed commerce ./commerce.duckdb      # 5,000 made-up orders in a DuckDB file
pnpm demo                                 # http://localhost:5173: a board you can edit
```

![The shop overview board from the quick start: three KPIs, weekly revenue, revenue by country and line revenue by
category, on made-up data](docs/images/quickstart-board.png)

The chat needs a model key; the [Quick start](docs/getting-started/quickstart.md) shows how to give it one, and what
to ask.

## Where it runs

- **[Inside Apache Superset](docs/hosts/superset/README.md)** 6.1 or 5.0, following Superset's own roles and
  row-level security.
- **[On its own](docs/hosts/serve.md)**, with `lenspack serve`: the board app, the chat and an admin panel over your
  databases, with sign-in.
- **[In your React app](docs/hosts/react.md)**, as board components.
- **[In any MCP client](docs/hosts/mcp.md)**, as tools a model can call.

It reads Postgres, ClickHouse, DuckDB, SQLite, MySQL, MariaDB and Elasticsearch. See [Sources](docs/sources/README.md).

## Documentation

- [What Lenspack is](docs/introduction/README.md): the problem, how it works, and who it is for.
- [Quick start](docs/getting-started/quickstart.md), then [Tutorial: build a pack](docs/getting-started/tutorial.md).
- [The documentation home](docs/README.md): everything, from aims to reference.
- [Changelog](CHANGELOG.md): what changed, newest first.

Packages are published to GitHub Packages; see [Packages](docs/reference/packages.md). Contributions, new sources and
new example packs are welcome.

## License

Apache-2.0.
