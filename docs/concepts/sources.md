# Sources

A source is where the rows live: a database, a search index, or Superset. This page explains how a pack is tied to
a source and what a source is allowed to do. It is for anyone connecting Lenspack to data.

## A pack says what; a source says where

The pack says what the numbers mean. A **source** says where they are. In `lenspack.yaml`, each pack names one
source:

```yaml
sources:
  shop:   { url: env:DATABASE_URL }                           # a SQL database, by connection URL
  search: { kind: elasticsearch, url: env:ES_URL }            # a search index
packs:
  - { pack: ./commerce.pack.yaml, source: shop }
```

Behind each source is a **connector**: the one piece of Lenspack that knows how to talk to that kind of system.
The engine checks a query against the pack, then hands the connector a plan; the connector turns it into SQL or a
search request and runs it.

| source | connector | notes |
|---|---|---|
| Postgres, ClickHouse, DuckDB, SQLite, MySQL, MariaDB | `sql`, with one driver per database | chosen by the URL's scheme. See [SQL databases](../sources/sql.md). |
| Elasticsearch 6.x to 8.x (tested on 7.17), OpenSearch | `elasticsearch` | no joins; approximate counts are marked. See [Elasticsearch](../sources/elasticsearch.md). |
| Superset datasets | `superset` | numbers come from Superset's chart-data API, so a metric means the same in both. See [Superset](../hosts/superset/datasets-and-dashboards.md). |

## What a source may do

- **Read, never write.** Every query runs read-only, one statement at a time, under a time limit and a row cap.
  The driver enforces this, not the SQL.
- **Refuse what it cannot do.** Each connector declares its capabilities. A percentile on a database without one,
  a join on a search index, a map on a source with no coordinates: each is refused before anything runs, with
  the reason.
- **Never keep boards.** Boards live in their own store, apart from the data.

## Portable packs

A pack can name data in two ways:

- **Structured**: `field: country`, `where: [{ field: status, op: eq, value: refunded }]`. Every connector
  understands these, so the pack runs anywhere.
- **SQL fragments**: `sql: total_cents / 100.0`. Copied into the query as written. Write them in SQL every database
  accepts, or give one per database.

The repository's tests hold this to account: one example pack returns the same numbers from DuckDB and from a real
Elasticsearch on more than 100 queries.

---

**Next:** [Entities and joins](entities.md).

**Related:** [Sources overview](../sources/README.md) · [Write a source](../extending/write-a-source.md)
