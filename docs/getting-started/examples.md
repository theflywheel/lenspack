# The example packs

This page lists the example packs that ship with Lenspack: what each one's data looks like, its boards, how to seed
it and what it shows. It is for anyone trying Lenspack, and for pack authors looking for a pattern to copy.

Every example is made-up data that seeds in seconds. Together they are also the test suite: the examples run on
every SQL database Lenspack supports, and the build fails if the numbers differ (see [Claims the build
checks](../architecture/claims.md)).

## The packs

| pack | boards | what it shows |
|---|---|---|
| [`commerce`](../../examples/commerce) | `overview`, `channels` | A small online shop: a star schema, money and ratios, percentiles, and a fan-out trap the compiler refuses. The running example in these docs. |
| [`events`](../../examples/events) | `traffic`, `acquisition` | Web analytics in one wide table: every time grain, distinct counts, a high-cardinality dimension, a per-database fragment. |
| [`consultation`](../../examples/consultation) | `committee`, `signals` | Public-consultation submissions: JSON paths, text in several languages, tenants, and themes found by a language model used as ordinary joined dimensions. |
| [`tickets`](../../examples/tickets) | `desk`, `sla` | A support desk: state history, durations, an SLA breach as a filtered rate, a funnel read from transitions. The [tutorial](tutorial.md) builds it from scratch. |
| [`hcm`](../../examples/hcm) | `campaign`, `coverage` | A deliberately awkward registry: epoch-millisecond times, soft deletes on every table, two keys for the same record, JSON in text columns, dotted hierarchies, fan-out on every side. |
| [`campaign`](../../examples/campaign) | `overview` | Search-index shapes, written only with `field:` and `where:`, so it runs on DuckDB and on Elasticsearch with the same numbers. |

## Seeding one

From a clone of the repository:

```bash
pnpm seed <commerce|events|consultation|tickets|hcm|campaign> ./<name>.duckdb    # a DuckDB file
pnpm seed commerce postgres://user:pass@localhost:5432/shop                     # or a Postgres database
```

Every seed is fixed: the same command writes the same rows. The data runs up to 31 August 2026. The board app
treats 1 September 2026 as today for the examples, so "the last 30 days" means August. A server of your own over a
seeded file uses the real date, so ask about dates before September 2026 there.

## Opening one

`pnpm demo` serves every `<name>.duckdb` file in the current folder (or the folder you name: `pnpm demo ./data`).
Open <http://localhost:5173/?example=tickets&board=desk> to see one board. Each example folder holds its pack
(`pack.yaml`), its boards (`boards/*.json`, as edit operations) and its seed (`seed.ts`).

To serve one with `lenspack serve` instead, point a `lenspack.yaml` at the file, as the
[tutorial](tutorial.md#2-point-a-config-at-it) does.

---

**Next:** [Tutorial: build a pack from scratch](tutorial.md).

**Related:** [Quick start](quickstart.md) · [Packs](../concepts/packs.md) · [Write a pack](../extending/write-a-pack.md)
