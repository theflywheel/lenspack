# Connectors, Elasticsearch, `lenspack serve`, and the DSS compiler

Status: approved direction ("Connector + ES + serve"), 2026-09-29. Adds a
fourth item the owner asked for mid-build: a small compiler from DIGIT DSS
`ChartApiConfig.json` to a pack plus boards.

## Why

lenspack assumed SQL in three places: pack `sql:` fragments, the compiler's
output (`{sql, params}`), and `Executor.query(sql, params)`. There was no
product binary, because the demo server was welded to the examples. A request
to "connect this to Elasticsearch" had nowhere to land.

DIGIT's DSS is the forcing case: 140 charts, all hand-written ES `aggrQuery`
JSON (104 health charts = 11,656 lines). They draw on 5 indexes and about 24
fields. Measured on the config, the agg features are terms 193, filter 188,
sum 186, filters 140, script 90, bucket_script 71, value_count 60 and
date_histogram 24. Post-aggregation work runs through `computedFields`
(Percentage 31) and `action: percentage` (24), which are ratios across two
queries, often across two indexes.

## 1. The Connector seam

A new package, `@lenspack/engine`, holds everything that is not tied to one
backend:

- `resolve` (moved from `@lenspack/sql`), which binds keys, finds join paths,
  refuses fan-out, and handles tenancy and time windows;
- `WidgetData` and its shaping helpers;
- `run`, `resolveBoard`, `dimensionValues`, `checkOps`, `widgetQuery`;
- the `Connector` interface:

```ts
interface Connector {
  readonly kind: string;                  // "postgres" | "duckdb" | "elasticsearch"
  readonly capabilities: Capabilities;
  compile(bound: BoundPlan, pack: Pack): Plan;     // { text, native, shape, approximate }
  execute(plan: Plan, opts?: { timeoutMs?: number }): Promise<WidgetData>;
  introspect?(): Promise<SourceSchema>;
  close?(): Promise<void>;
}
type Capabilities = { joins: boolean; exactDistinct: boolean; exactPercentiles: boolean };
```

`resolve` takes the capabilities. A connector without `joins` refuses any
dimension that lives on another entity (`NEEDS_JOIN`), and the error names the
dimensions it can use instead. The refusal is structural, not a runtime
failure.

`@lenspack/sql` becomes one connector, `sqlConnector(executor)`. It keeps its
executors, cache and store, and re-exports the engine for compatibility.

## 2. A pack that is not SQL

These additions are neutral: every connector compiles them.

- `field: "Data.district.keyword"`. A dimension or measure may name a field
  in place of a `sql` fragment. SQL quotes it as a column; ES uses it as the
  field path.
- entity `time:` accepts a field path (dots allowed).
- `where: [{ field, op, value }]`, with op in eq, neq, in, gt, gte, lt, lte
  and exists. This is a structured predicate on measures and entities,
  alongside the existing `filter:` fragment.
- `count` may take a `field`, which counts non-null values (`COUNT(col)` /
  `value_count`).
- `scale: 1.8` multiplies a measure's final value. DSS uses this for
  population = nets × 1.8.
- A dimension may add `also: { <entity>: { field | sql } }`. This is the same
  concept on another entity (a conformed dimension), and it is what lets one
  `district` group measures from two indexes.
- Fragments gain an `elasticsearch` key. For a filter, its value is query DSL
  JSON; for a dimension or measure, it is a Painless script. This is the
  escape hatch, reviewed like SQL.

## 3. Elasticsearch connector (`@lenspack/elasticsearch`)

It talks HTTP via `fetch`, so it needs no client library. It covers
ES 6.x/7.x/8.x and OpenSearch; the version is detected from `GET /`, and 6.x
uses `interval` where later versions use `calendar_interval`. It reads
`_mapping` once so that an `eq` or `terms` on a `text` field goes to its
`.keyword` sub-field.

| IR | ES |
|---|---|
| tenant, entity where/filter, time window, query filters | `bool.filter` (neq → `must_not`) |
| breakdown | `terms` (size = limit, ordered by the metric) + metric; string dims get `missing: ""` → "(none)" |
| series | `date_histogram` (UTC); with `by`: outer `terms` top-12 by metric, inner histogram |
| value | filtered metric; `compare` → `filters` agg with current and previous windows |
| rows | `_search` with `_source` columns, `sort`, `size` |
| count / count(field) | `doc_count` / `value_count` |
| sum avg min max | same name |
| count_distinct | `cardinality` (precision 40000), marked approximate |
| median, p90 | `percentiles`, marked approximate |
| measure `where`/`filter` | `filter` sub-agg wrapping the metric |
| derived (same entity) | both metrics in one request, divided after |

`WidgetData.approximate = true` makes the UI show ≈.

## 4. Cross-entity ratios

`derived: "a / b"` may now cross entities. The engine runs each side as its own
query at its own grain: both sides share the same shape, filters and window,
and the dimension resolves on each side through `also`. It then joins the two
on the group key and divides. Fan-out can't happen, because nothing is joined
row-wise. Both connectors get this for free. It replaces DSS's
`PercentageComputedField` and `action: percentage`.

## 5. `lenspack serve`

`@lenspack/serve` is the demo server, generalised. The board API, chat,
review and explain routes move there, and the demo becomes a config.

```yaml
# lenspack.yaml
sources:
  hcm_es: { kind: elasticsearch, url: env:ES_URL, apiKey: env:ES_API_KEY }
  shop:   { kind: duckdb, path: ./data/commerce.duckdb }
packs:
  - { pack: ./packs/hcm/pack.yaml, source: hcm_es, boards: ./packs/hcm/boards, tenant: ng.state }
store: { kind: duckdb, path: ./data/boards.duckdb }    # or the SQL source
ui: ./ui                                              # optional static app
```

Secrets appear only as `env:NAME` references and are never written in YAML.

## 6. DSS compiler (`lenspack dss`)

```
lenspack dss ChartApiConfig.json [--dashboards MasterDashboardConfig.json] --out packs/dss
```

It walks each chart's `aggrQuery` tree:

- predicates (`bool.must` term/terms/match_phrase/range, `must_not`) collect
  into `where`;
- the first bucket agg (`terms`, `date_histogram`) becomes the query shape;
- the metric leaf becomes a measure (`value_count` → count(field), `sum`,
  `avg`, `cardinality`); the unique-count `scripted_metric` becomes
  count_distinct;
- a `bucket_script` of the form `params.x * k` becomes `scale`;
- `filters` buckets each become a measure;
- a two-query `percentage` or `PercentageComputedField` becomes a
  cross-entity derived measure.

Measures are deduplicated on (index, agg, field, where), so 60 per-level
copies fold to one key. `requestQueryMap` gives the dimensions; placeholders
such as `PVAR` become board filters.

Anything it cannot translate is listed in `report.md` with the chart and the
reason (painless scripts, `repsonseToDifferenceOfDates`, and similar). It is
never guessed.

Output: `pack.yaml`, one ops file per DSS dashboard, and `report.md`.

## Proof

- A synthetic ES index shaped like `project-task-index-v1`, plus
  `project-index-v1` for targets, with no real data.
- The hcm pack's measures compiled on ES and on DuckDB over the same synthetic
  rows must agree: exact for sums and counts, within 1% for approximate
  aggregations.
- The DSS config compiled to a pack and boards that load, check and render
  against the synthetic index. The report shows the coverage ratio.
- Numbers matching real DSS need a read-only UAT index from eGov. That is out
  of scope until one exists.
