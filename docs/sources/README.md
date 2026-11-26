# Sources

This section covers where Lenspack reads numbers from and how to connect each kind of source. It is for whoever
connects Lenspack to data. What a source is, and why a pack stays the same across sources, is in
[Sources](../concepts/sources.md).

Lenspack reads; it never writes to your data and never copies it into a store of its own. Every source runs
Lenspack's queries read-only, under a time limit and a row cap.

| source | how you name it | page |
|---|---|---|
| Postgres, DuckDB, SQLite, MySQL and MariaDB, ClickHouse | a connection URL: `postgres://`, `duckdb:`, `sqlite:`, `mysql://`, `clickhouse://` | [SQL databases](sql.md) |
| Elasticsearch 6.x to 8.x (tested on 7.17), OpenSearch | `kind: elasticsearch` or `kind: opensearch`, with a URL | [Elasticsearch and OpenSearch](elasticsearch.md) |
| Apache Superset's datasets | `datasets:` in `superset.yaml`; Superset runs the queries on its own databases | [Datasets and dashboards](../hosts/superset/datasets-and-dashboards.md) |

```yaml
# lenspack.yaml: secrets are env: references, never values
sources:
  search: { kind: elasticsearch, url: env:ES_URL, apiKey: env:ES_API_KEY }
  shop:   { url: env:DATABASE_URL }                # postgres://, mysql://, clickhouse://, sqlite:…
  local:  { url: "duckdb:./data/shop.duckdb" }
packs:
  - { pack: ./packs/shop.yaml, source: shop, boards: ./packs/shop-boards }
store: { kind: duckdb, path: ./data/boards.duckdb }   # boards never live in a source
```

`lenspack sources --config lenspack.yaml` lists what each source holds (tables or indexes, fields, types and row
counts), a first step when writing a pack.

**One pack, any source.** A pack that names data with `field:` and `where:` rather than SQL fragments runs unchanged on
every source, and the build holds that to account: the `campaign` example returns identical numbers from DuckDB and a
real Elasticsearch (7.17) on more than 100 queries. Where sources differ (joins, exact distinct counts, percentiles,
time zones, maps), each says what it can do and Lenspack refuses the rest rather than guess. The table is in [Write a
source](../extending/write-a-source.md).

A source Lenspack does not ship is a connector you write, or for a SQL database a driver you register. See
[Write a source](../extending/write-a-source.md).

---

**Next:** [SQL databases](sql.md).

**Related:** [Sources](../concepts/sources.md) · [Configuration reference](../reference/config.md) ·
[Write a pack](../extending/write-a-pack.md)
