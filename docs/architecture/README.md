# Architecture overview

This page shows how Lenspack's code is laid out and the one rule that holds it together. It is for developers who
will read, extend or review the code, and for anyone who wants to know where a behaviour lives.

## Three layers

```
┌──────────────────────────── hosts ─────────────────────────────┐
│  superset · serve (lenspack serve) · react · mcp                │   who is asking, where boards
└───────────────▲───────────────────────────────▲─────────────────┘   live, the UI, the running turn
                │ identity, store, UI           │ tools, answers
┌───────────────┴───────────── kernel ──────────┴─────────────────┐
│  core · pack · engine · agent · policy                          │   the rules: boards, packs,
└───────────────▲─────────────────────────────────────────────────┘   queries, tools, access
                │ a checked plan
┌───────────────┴──────────── sources ────────────────────────────┐
│  sql (Postgres, ClickHouse, DuckDB, SQLite, MySQL) · elasticsearch │   talk to one kind of system
└─────────────────────────────────────────────────────────────────┘
```

**The rule:** the kernel never reaches a database or a model provider by itself, and never decides who someone
is. Sources plug in below it; hosts plug in above it. So the same rules apply whichever database holds the data and
whichever app the person is using.

## How the code is laid out

The npm packages (`@lenspack/<name>`) sit in four folders under `packages/`, by the job they do:

| folder | packages | what they do |
|---|---|---|
| `packages/kernel/` | `core`, `pack`, `engine`, `agent`, `policy` | What every deployment uses. See [The kernel](kernel.md). |
| `packages/sources/` | `sql`, `elasticsearch` | Where data comes from. See [Sources](../sources/README.md). |
| `packages/packs/` | `dss`, `ccrs` | Ready-made packs and boards, compiled from another system's configuration. See [Importers](../extending/importers.md). |
| `packages/hosts/` | `serve`, `superset`, `react`, `mcp` | The apps and integrations that run Lenspack. See [Hosts](../hosts/README.md). |

What each package holds and what it depends on is in [Packages](../reference/packages.md).

## Where to read next

- [The kernel](kernel.md): what each of the five kernel packages owns.
- [The life of a query](life-of-a-query.md): how a query becomes rows, and every check on the way.
- [The life of a turn](life-of-a-turn.md): how a chat message becomes a reply.
- [Stores, and running several copies](stores.md): where state is kept, today and planned.
- [How a host plugs in](hosts.md): the contract between a host and the kernel.
- [Why the model cannot break things](safety.md): the safety model.

## The example packs

The repository ships example packs over very different data. Each is made-up data, `pnpm seed <name>
./<name>.duckdb` seeds it, and together they are the test suite.

| pack | board | what it stresses |
|---|---|---|
| [`commerce`](../../examples/commerce) | `overview` | A star schema, money and ratios, percentiles, and a fan-out trap the compiler refuses. |
| [`events`](../../examples/events) | `traffic` | One wide table: every time grain, distinct counts, a high-cardinality dimension, a per-database fragment. |
| [`consultation`](../../examples/consultation) | `committee` | JSON paths, multilingual text, multi-tenancy, themes derived by a language model used as ordinary joined dimensions. |
| [`tickets`](../../examples/tickets) | `desk` | State history, durations, an SLA breach as a filtered rate, a funnel read from transitions. |
| [`hcm`](../../examples/hcm) | `campaign` | A deliberately awkward registry: epoch-millisecond times, soft deletes on every table, dual keys, JSON in text columns, dotted hierarchies, fan-out on every side. |
| [`campaign`](../../examples/campaign) | `overview` | Search-index shapes, run on both DuckDB and Elasticsearch to prove a pack is portable. |

## Claims the build checks

Lenspack came out of a tool whose dashboard logic was tied to one schema. These checks keep the abstraction honest
now that it is not, and the build fails when one stops being true:

| check | what it holds |
|---|---|
| Every engine, same answer | Every example board, and every dimension × measure × shape of every pack, runs on Postgres, MySQL, MariaDB, SQLite and ClickHouse and must return DuckDB's numbers. A percentile on a database without one (MySQL, SQLite) must come back as the documented refusal and nothing else. Golden files pin the SQL each database is sent. |
| One pack, two kinds of source | The `campaign` pack returns identical numbers from DuckDB and a real Elasticsearch on 77 queries. |
| One edit suite, every pack | The core's tests run over every example catalogue, not just the one they were written for. |
| No domain words in the code | The build fails if the kernel, the sources or the hosts' own code contain a word from any example domain. |
| Pack conformance | Every dimension × measure × shape compiles or fails with a documented reason; every declared fan-out is refused; tenancy is present. |
| The next pack | Writing a pack for a new dataset takes under an hour and changes nothing under `packages/`. See [Write a pack](../extending/write-a-pack.md). |

---

**Next:** [The kernel](kernel.md).

**Related:** [Concepts](../concepts/README.md) · [Packages](../reference/packages.md)
