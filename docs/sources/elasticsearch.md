# Elasticsearch and OpenSearch

This page covers search indexes as Lenspack sources: how to connect, what a pack needs to run on one, and what is
refused or approximate. It is for whoever connects Lenspack to Elasticsearch or OpenSearch.

`@lenspack/elasticsearch` turns a query into one search request with aggregations, over plain HTTP. With no client
library, one connector is written for **Elasticsearch 6.x to 8.x and OpenSearch**, which differ in client packages far more
than in the search API it uses. The repository's tests run it against Elasticsearch 7.17; the other versions are
supported by design but not tested on every build.

## Connect

```yaml
# lenspack.yaml
sources:
  search: { kind: elasticsearch, url: env:ES_URL, apiKey: env:ES_API_KEY }        # or username + password
  os:     { kind: opensearch, url: env:OS_URL, username: env:OS_USER, password: env:OS_PASSWORD }
packs:
  - { pack: ./packs/campaign/pack.yaml, source: search }
```

`apiKey` is sent as `Authorization: ApiKey …` (Elastic's base64 `id:key` form). `timeoutMs` is the time limit for one
request (15 seconds by default). An entity's `source:` is an index, an index pattern (`visits-*`) or a comma-separated
list.

## Writing a pack for an index

- **Name fields with `field:`**, and conditions with `where:`, not SQL fragments. A measure or dimension written only
  in SQL is refused on this source unless it has an `elasticsearch:` entry (a query DSL fragment, as JSON).
- **A text field is grouped by its keyword sub-field.** Lenspack reads the index mapping and uses `name.keyword` when
  `name` is text, so `field: name` works either way.
- **Time** must be a field: a date, or a number of milliseconds since 1970. A series over seconds since 1970 is
  refused; a series in a pack `timeZone` over millisecond numbers needs Elasticsearch 7.11 or later (runtime fields).
- **JSON column paths and script dimensions** have no meaning on an index and are refused.

## What is different from SQL

| | SQL databases | Elasticsearch and OpenSearch |
|---|---|---|
| joins | many-to-one joins; fan-out refused | **none**: a dimension on another entity is refused, with the dimensions it *can* group by |
| distinct counts | exact | approximate (`cardinality`, precision threshold 40,000), marked ≈ |
| percentiles | exact where the database has them | approximate, marked ≈ |
| two-stage measures (`per`) | yes | refused |
| maps (`points`) | yes | refused |

**No joins.** A search index cannot join. A dimension that lives on another entity is refused with the dimensions
the measure's entity can group by, unless the pack declares the same dimension on both entities with `also:` (see
[Dimensions](../concepts/dimensions.md#the-same-dimension-on-several-entities)). A ratio across entities (delivered
against target) is two aggregates joined on the group, never a row-level join, so it works here too; a target with
no time divides every period.

**Approximate answers are marked.** A number from an approximate aggregation is flagged ≈ in the answer, so a person
knows it is not exact.

## Why it is not a SQL driver

Elasticsearch has a SQL API, but it cannot join, and its answers come from the same aggregations the native
connector already builds. The native connector marks approximate aggregations and is proven in the repository's
tests to return DuckDB's numbers on the `campaign` example pack, on more than 100 queries. Routing it through SQL would trade
that for a narrower dialect, so it stays a connector of its own, configured with `kind: elasticsearch`.

---

**Next:** [Extending Lenspack](../extending/README.md).

**Related:** [SQL databases](sql.md) · [Sources](../concepts/sources.md) · [Write a source](../extending/write-a-source.md)
