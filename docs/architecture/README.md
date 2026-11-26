# Architecture overview

This page shows how Lenspack's code is laid out and the one rule that holds it together. It is for developers who
will read, extend or review the code, and for anyone who wants to know where a behaviour lives.

## Three layers

A pack becomes a catalogue the model reads. The model names keys from it, as edits to a board or as queries. The
compiler turns those into a checked query for the source:

```
pack.yaml  ──►  catalogue  ──►  the model names keys  ──►  edits  ──►  board (JSON)
                    │                                                     │
                    └──────────►  compiler (resolve → plan → print)  ◄────┘
                                          │
         Postgres · ClickHouse · DuckDB · SQLite · MySQL · Elasticsearch · Superset
```

In code, that is three layers:

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
- [Claims the build checks](claims.md): what the test suite holds true on every build.

---

**Next:** [The kernel](kernel.md).

**Related:** [Concepts](../concepts/README.md) · [Packages](../reference/packages.md)
