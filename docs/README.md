# Lenspack documentation

**A dashboard is data, not code.** Declare your data once in a pack, a closed vocabulary of measures and
dimensions that your team reviews like code. After that a language model can answer questions and build and edit
dashboards by naming those keys, and nothing else. What the pack does not declare, the compiler will not build: ask
for it and you get a refusal with the reason and the nearest key, never a wrong number. The model never writes SQL
and never writes to your data.

People meet this as a chat on their dashboards, inside Apache Superset or Lenspack's own app: questions in their own
words or by voice, answers that show how they were worked out, and dashboards that change when someone allowed to
edit asks. See it on the [live demo](https://lenspack.proto.theflywheel.in).

These pages go from why Lenspack exists to every setting it has: aims, concepts, architecture, features, hosts,
sources, extending, access, operating and reference. Read them in order the first time; come back to the reference
when you need a detail.

## Start here

| I want to… | Go to |
|---|---|
| understand what Lenspack is and whether it fits | [What Lenspack is](introduction/README.md) |
| see it working on my machine in five minutes | [Quick start](getting-started/quickstart.md) |
| add the chat to an existing Apache Superset | [Install into Superset](hosts/superset/install.md) |
| point it at my own database | [Your own data](getting-started/your-own-data.md) |
| build boards into my own app | [React components](hosts/react.md) |
| give an AI assistant (an MCP client) my data | [MCP server](hosts/mcp.md) |

## Contents

### 1. Aims and offerings

Why Lenspack exists, who it is for, and what it deliberately leaves out.

- [What Lenspack is](introduction/README.md): the problem, the idea, and who it is for.
- [What you get](introduction/offerings.md): the parts of the product, one paragraph each.
- [What Lenspack does not do](introduction/limits.md): the lines it never crosses, and what is not built yet.

### Getting started

- [Choose a path](getting-started/README.md)
- [Quick start](getting-started/quickstart.md): a board and a chat on made-up data, in minutes.
- [Your own data](getting-started/your-own-data.md): a config file, a small pack, and a running server.

### 2. Concepts

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

### 3. Architecture

How the code is laid out and how a request moves through it.

- [Architecture overview](architecture/README.md): kernel, sources and hosts.
- [The kernel](architecture/kernel.md): core, pack, engine, agent and policy.
- [The life of a query](architecture/life-of-a-query.md): from a query to rows, and every check on the way.
- [The life of a turn](architecture/life-of-a-turn.md): from a question to a reply.
- [Stores, and running several copies](architecture/stores.md): what is kept where, today and planned.
- [How a host plugs in](architecture/hosts.md): what a host gives Lenspack, and what it gets back.
- [Why the model cannot break things](architecture/safety.md): the safety model.

### 4. Features

- [All features](features/README.md): what each does and which hosts have it.
- [Answering questions](features/answering.md) and [the compute step](features/compute.md)
- [Dashboard edits, versions and undo](features/dashboard-edits.md)
- [Charts, maps and heatmaps](features/charts.md)
- [How this was worked out](features/explain.md)
- [Saved answers](features/saved-answers.md) and [busy hours](features/busy-hours.md)
- [Open questions and definitions](features/open-questions.md)
- [The admin panel](features/admin-panel.md)
- [Voice](features/voice.md) and [languages](features/languages.md)
- [Usage telemetry](features/telemetry.md)

### 5. Hosts

- [Choose a host](hosts/README.md)
- [Apache Superset](hosts/superset/README.md): [install](hosts/superset/install.md),
  [datasets and dashboards](hosts/superset/datasets-and-dashboards.md),
  [computed charts](hosts/superset/computed-charts.md), [who is asking](hosts/superset/identity.md),
  [the settings page](hosts/superset/settings.md), [supported versions](hosts/superset/versions.md),
  [upgrading](hosts/superset/upgrading.md)
- [The standalone server](hosts/serve.md)
- [React components](hosts/react.md)
- [MCP server](hosts/mcp.md)

### 6. Sources

- [Sources overview](sources/README.md)
- [SQL databases](sources/sql.md): Postgres, ClickHouse, DuckDB, SQLite, MySQL and MariaDB.
- [Elasticsearch and OpenSearch](sources/elasticsearch.md)

### 7. Extending

- [Extension points](extending/README.md)
- [Write a pack](extending/write-a-pack.md)
- [Write a source](extending/write-a-source.md)
- [Write a host](extending/write-a-host.md)
- [Add a model provider](extending/model-adapter.md)
- [Importers](extending/importers.md): packs and boards from another system's configuration.

### 8. Access and policy

- [Who sees what](access/README.md): the layers, from the host down to the query.
- [Sign-in](access/sign-in.md)
- [Rights: viewing, editing, maintaining, administering](access/rights.md)
- [Pack access rules](access/pack-rules.md)
- [Row scope and tenancy](access/scope-and-tenancy.md)
- [Access inside Superset](access/superset.md)
- [How access is tested](access/testing.md)

### 9. Operating it

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

### 10. Reference

- [Reference index](reference/README.md)
- [Configuration keys](reference/config.md)
- [Pack file](reference/pack.md)
- [Query format](reference/query.md)
- [Board format and edit operations](reference/board.md)
- [HTTP API](reference/http-api.md)
- [Command line](reference/cli.md)
- [Chat stream parts](reference/stream-parts.md)
- [Refusal codes](reference/errors.md)
- [Packages](reference/packages.md)
- [Evals](reference/evals.md)
- [Glossary](reference/glossary.md)

### Background

- [Design notes](design/README.md): the original design documents, kept for history.

## How these pages are written

- **Learn first, look up later.** Sections 1 to 4 explain; section 10 lists. Each explanation links to the
  reference entry it relies on, and each reference entry links back to the page that explains it.
- **One idea per page.** Every page starts by saying what it covers and who it is for, and ends with where to
  go next.
- **Made-up examples.** The running example is a small online shop with made-up data, the same one the repository
  seeds with `pnpm seed commerce`. No page uses real data.
- **Everything described is on the main branch.** What changed lately is in the [changelog](../CHANGELOG.md).
- **"Planned"** marks a direction the architecture has chosen but that is not built yet.
