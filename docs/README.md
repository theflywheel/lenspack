# Lenspack documentation

Lenspack is an open-source assistant for dashboards. People ask questions and change dashboards in plain words,
inside Apache Superset or Lenspack's own app, and every number comes from definitions your team reviewed, never from
SQL a model wrote.

*A dashboard is data, not code.*

You describe your data once, in a **pack** your team reviews like code. The assistant can only name what the pack
declares. Ask for something it does not declare, or something that would count rows twice, and you get a refusal
with the reason and the nearest thing that would work, never a wrong number. See it on the
[live demo](https://lenspack.proto.theflywheel.in).

## Start here

| I want to… | Go to |
|---|---|
| understand what Lenspack is and whether it fits | [What Lenspack is](introduction/README.md) |
| see it working on my machine in five minutes | [Quick start](getting-started/quickstart.md) |
| learn to write a pack, step by step | [Tutorial: build a pack](getting-started/tutorial.md) |
| add the chat to an existing Apache Superset | [Install into Superset](hosts/superset/install.md) |
| point it at my own database | [Your own data](getting-started/your-own-data.md) |
| build boards into my own app | [React components](hosts/react.md) |
| give an AI assistant (an MCP client) my data | [MCP server](hosts/mcp.md) |

## The core path

About ninety pages follow, but ten of them are enough to understand Lenspack and run it. Read these first, in this
order:

1. [What Lenspack is](introduction/README.md)
2. [Quick start](getting-started/quickstart.md)
3. [Concepts in one page](concepts/README.md)
4. [Packs](concepts/packs.md)
5. [Entities and joins](concepts/entities.md)
6. [Measures and the compute step](concepts/measures.md)
7. [Boards and widgets](concepts/boards.md)
8. [Choose a host](hosts/README.md)
9. [Who sees what](access/README.md)
10. [Deploying](operating/deploying.md)

Come back to the rest, and to the reference, when you need a detail.

## Contents

### 1. Aims and offerings

Why Lenspack exists, who it is for, and what it deliberately leaves out.

- [What Lenspack is](introduction/README.md): the problem, how it works, and who it is for.
- [What you get](introduction/offerings.md): the parts of the product, one paragraph each.
- [What Lenspack does not do](introduction/limits.md): the lines it never crosses, and what is not built yet.

### 2. Getting started

From a first look to your own data.

- [Choose a path](getting-started/README.md)
- [Quick start](getting-started/quickstart.md): a board and a chat on made-up data, in minutes.
- [The example packs](getting-started/examples.md): six made-up datasets, their boards, and how to seed them.
- [Tutorial: build a pack](getting-started/tutorial.md): a pack, a board and a server over made-up support tickets,
  with a check after each step.
- [Your own data](getting-started/your-own-data.md): a config file, a small pack, and a running server.

### 3. Concepts

The handful of ideas everything else is built from, with one running example.

- [Concepts in one page](concepts/README.md): the running example, and how the pieces fit.
- [Packs](concepts/packs.md): the reviewed description of your data.
- [Sources](concepts/sources.md): where the numbers live.
- [Entities and joins](concepts/entities.md): tables, their grain, and why some questions are refused.
- [Dimensions](concepts/dimensions.md): what you group and filter by.
- [Measures and the compute step](concepts/measures.md): simple base numbers, and the arithmetic done after.
- [Queries](concepts/queries.md): the five shapes of question Lenspack can ask a source.
- [Filters](concepts/filters.md): narrowing a query, a board, or a person's view.
- [Boards and widgets](concepts/boards.md): a dashboard as a document.
- [Turns](concepts/turns.md): one question or request in the chat, from start to finish.
- [Hosts](concepts/hosts.md): the app Lenspack runs inside.
- [Policy](concepts/policy.md): who may see and change what.
- [Definitions and open questions](concepts/definitions.md): settling what a word means for your deployment.
- [Saved answers](concepts/saved-answers.md): answering a repeated question without the model.

### 4. Architecture

How the code is laid out and how a request moves through it.

- [Architecture overview](architecture/README.md): kernel, sources and hosts.
- [The kernel](architecture/kernel.md): core, pack, engine, agent and policy.
- [The life of a query](architecture/life-of-a-query.md): from a query to rows, and every check on the way.
- [The life of a turn](architecture/life-of-a-turn.md): from a question to a reply.
- [Stores, and running several copies](architecture/stores.md): what is kept where, today and planned.
- [How a host plugs in](architecture/hosts.md): what a host gives Lenspack, and what it gets back.
- [Why the model cannot break things](architecture/safety.md): the safety model.
- [Claims the build checks](architecture/claims.md): what the test suite holds true on every build.

### 5. Features

- [All features](features/README.md): what each does and which hosts have it.
- [Answering questions](features/answering.md)
- [The compute step](features/compute.md)
- [How this was worked out](features/explain.md)
- [Saved answers](features/saved-answers.md)
- [Busy hours](features/busy-hours.md)
- [Dashboard edits, versions and undo](features/dashboard-edits.md)
- [Charts, maps and heatmaps](features/charts.md)
- [Personal dashboards and saved layouts](features/personal-dashboards.md)
- [Open questions and definitions](features/open-questions.md)
- [The admin panel](features/admin-panel.md)
- [Usage telemetry](features/telemetry.md)
- [Voice](features/voice.md)
- [Languages](features/languages.md)
- [Naming the assistant](features/naming.md)

### 6. Hosts

- [Choose a host](hosts/README.md)
- [Apache Superset](hosts/superset/README.md): [install](hosts/superset/install.md),
  [datasets and dashboards](hosts/superset/datasets-and-dashboards.md),
  [computed charts](hosts/superset/computed-charts.md), [who is asking](hosts/superset/identity.md),
  [the settings page](hosts/superset/settings.md), [supported versions](hosts/superset/versions.md),
  [upgrading](hosts/superset/upgrading.md)
- [The standalone server](hosts/serve.md)
- [React components](hosts/react.md)
- [MCP server](hosts/mcp.md)

### 7. Sources

- [Sources overview](sources/README.md)
- [SQL databases](sources/sql.md): Postgres, ClickHouse, DuckDB, SQLite, MySQL and MariaDB.
- [Elasticsearch and OpenSearch](sources/elasticsearch.md)

### 8. Extending

- [Extension points](extending/README.md)
- [Write a pack](extending/write-a-pack.md)
- [Write a source](extending/write-a-source.md)
- [Write a host](extending/write-a-host.md)
- [Add a model provider](extending/model-adapter.md)
- [Importers](extending/importers.md): packs and boards from another system's configuration.

### 9. Access and policy

- [Who sees what](access/README.md): the layers, from the host down to the query.
- [Sign-in](access/sign-in.md)
- [Rights: viewing, editing, maintaining, administering](access/rights.md)
- [Pack access rules](access/pack-rules.md)
- [Row scope and tenancy](access/scope-and-tenancy.md)
- [Access inside Superset](access/superset.md)

### 10. Operating it

- [Operating overview](operating/README.md)
- [Configuration](operating/configuration.md)
- [Chat models](operating/models.md)
- [Costs, metering and budgets](operating/costs.md)
- [Feature switches](operating/switches.md)
- [Deploying](operating/deploying.md)
- [What Lenspack keeps on disk](operating/state.md)
- [Privacy and data handling](operating/privacy.md)
- [Upgrading](operating/upgrading.md)
- [Troubleshooting](operating/troubleshooting.md)

### 11. Reference

- [Reference index](reference/README.md)
- [Configuration keys](reference/config.md)
- [Pack file](reference/pack.md)
- [Query format](reference/query.md)
- [Board format and edit operations](reference/board.md)
- [HTTP API](reference/http-api.md)
- [Command line](reference/cli.md)
- [Chat stream parts](reference/stream-parts.md)
- [Telemetry records](reference/telemetry-records.md)
- [Refusal codes](reference/errors.md)
- [Packages](reference/packages.md)
- [Glossary](reference/glossary.md)
- [Changelog](../CHANGELOG.md)

### Contributing

For people changing Lenspack itself.

- [How access is tested](access/testing.md): the suite that runs real Superset and checks what each user sees.
- [Evals](reference/evals.md): scoring models on board building and on answers.
- [Design notes](design/README.md): historical design notes, kept for the reasons behind the code.

## How these pages are written

- **Learn first, look up later.** Sections 1 to 5 explain; section 11 lists. Each explanation links to the
  reference entry it relies on, and each reference entry links back to the page that explains it.
- **One idea per page.** Every page starts by saying what it covers and who it is for, and ends with where to
  go next. Following **Next** from the first page walks the contents in order.
- **Made-up examples.** The running example is a small online shop with made-up data, the same one the repository
  seeds with `pnpm seed commerce`. No page uses real data.
- **Everything described is on the main branch.** What changed lately is in the [changelog](../CHANGELOG.md).
- **"Planned"** marks a direction the architecture has chosen but that is not built yet.
