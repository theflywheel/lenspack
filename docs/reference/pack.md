# Pack file reference

This page is the full format of a pack file, the rules checked when it loads, and how the compiler reads it. It is
for whoever writes or reviews packs. For why packs exist, read [Packs](../concepts/packs.md); for a walk-through,
[Write a pack](../extending/write-a-pack.md).

A pack is one YAML or JSON document. `@lenspack/pack` checks it, and `catalogueFrom(pack)` turns it into the list of
keys the model sees.

## The shape

### The pack

```yaml
pack: <slug>                # lowercase: a letter, then letters, digits or _
version: <int>              # 1 or more; bump it when keys change. Boards record the version they were built against
description: <text>         # optional, up to 500 characters
timeZone: <IANA zone>       # optional, such as Europe/Lisbon: where days start for calendar ranges and series
                            # buckets. UTC when absent. A name, never an offset like +03:00
```

### Entities

An entity is one table, with its grain, its time column and its joins.

```yaml
entities:
  <entity_key>:
    source: <table | schema.table | view>
    grain: <one line, shown to the model>     # optional but recommended: "one row per order"
    time: <column>          # the time column for series, windows and comparisons
    # …or a field holding epoch numbers, which every source converts:
    # time: { field: created_ms, unit: epoch_ms }          # or epoch_s
    # …or a column of calendar dates with no time of day (a DATE column), the same days in every zone:
    # time: { field: shipped_on, type: date }
    # …or an expression, one per database where they differ:
    # time: { sql: { postgres: "to_timestamp(created_ms / 1000.0)", duckdb: "epoch_ms(created_ms)" } }
    tenant: <column>        # every query over this entity must carry a tenant
    # …or tenant ids that nest ("north" owns "north.east"), so a parent tenant reads its descendants' rows too:
    # tenant: { field: tenant_id, match: subtree }
    geo: { lat: <column>, lon: <column> }     # optional: degrees; lets a points query and a map show each row
    filter: <fragment>      # carried by every query over this entity, such as soft deletes: is_deleted = false
    where:                  # the same, written as structured conditions that every source reads (up to 20)
      - { field: is_deleted, op: eq, value: false }
    joins:
      - to: <entity_key>
        on: <a.col = b.col> # exactly the two entities; parsed, never pasted into SQL
        type: many_to_one | one_to_one | one_to_many
```

### Dimensions

What you group and filter by.

```yaml
dimensions:
  - key: <slug>
    entity: <entity_key>
    field: <column>         # exactly one of field, sql or json
    sql: <fragment>
    json: [<column>, <key>, <key>…]          # a path into a JSON column; each database reads it its own way
    also:                   # the same idea on other entities, so one "region" groups measures from both
      <other_entity>: { field: <column> }
    type: string | number | boolean | time | enum   # default string
    grains: [hour, day, week, month, quarter, year] # time dimensions only
    label: <text>           # default: the key, title-cased (up to 80 characters)
    hint: <text>            # shown to the model (up to 400)
    synonyms: [<text>…]     # other words people use, for search (up to 20)
    verified: true | false  # default true: a key in the file was reviewed. Model proposals start false
```

### Measures

What you count or add up. A measure has exactly one of `agg`, `derived` or `levels`.

```yaml
measures:
  - key: <slug>
    entity: <entity_key>
    agg: count | count_distinct | sum | avg | min | max | median | p90 | p95
    sql: <fragment>         # or field: <column>; needed unless agg is count (count takes a field or nothing)
    filter: <fragment>      # optional: rows outside it are ignored by this aggregate
    where: [ … ]            # the same, as structured conditions
    scale: <number>         # optional: multiplies the result, such as people per item handed out
    format: number | percent | currency | compact | duration   # default number
  - key: <slug>
    entity: <entity_key>
    agg: <any agg above>    # over the values per key
    per:                    # two stages: one value per key first
      key: <column>         # or { sql: <fragment> }
      agg: count | count_distinct | sum | min | max | avg
      sql: <fragment>       # or field; needed unless agg is count
      filter: <fragment>    # optional, as on a measure (or where)
      having: { op: eq | neq | gt | gte | lt | lte, value: <number> }   # optional: keys whose value fails are skipped
                            # or { op: between, value: [<low>, <high>] }, both ends kept
  - key: <slug>
    entity: <entity_key>    # one of its operands' entities
    derived: <arithmetic>   # measure keys with + - * / and parentheses: "revenue / orders", "(a + b) / c * 100"
  - key: <slug>
    entity: <entity_key>
    levels:                 # one number kept per level of a hierarchy (a target set per country and per city)
      country: target_at_country
      city: target_at_city
```

### Hierarchies, instructions and examples

```yaml
hierarchies:                # dimensions that nest, coarse to fine (2 to 10 levels)
  place: [country, city]

instructions: <text>        # optional, up to 2000 characters: rules the keys cannot say, sent with every chat turn
examples:                   # optional, up to 12: checked questions and the query that answers each
  - question: <text>
    query: { kind: breakdown, dimension: <key>, measure: <key> }
    note: <text>            # optional: why this query and not the obvious one
    wordings: [<text>]      # optional, up to 10: the same question in other words or languages, answered by the same query
```

For example, the median items per order, and the customers with three or more orders:

```yaml
  - { key: median_items_per_order, entity: order_items, agg: median, per: { key: order_id, agg: count } }
  - { key: repeat_customers, entity: orders, agg: count, per: { key: customer_id, agg: count, having: { op: gte, value: 3 } } }
```

A `where` condition takes `op` `eq` (the default), `neq`, `in` (with a list of up to 100 values), `gt`, `gte`, `lt`,
`lte`, `exists` or `missing` (these two take no value). Prefer `field` and `where` over `sql` and `filter` when you
can: they read the same on every source, Elasticsearch included.

## Fragments

A `sql`, `filter` or time `sql` value is a **fragment**: either a string or a map with one entry per database.

```yaml
sql: { postgres: "EXTRACT(HOUR FROM ts)::int", duckdb: "hour(ts)", mysql: "HOUR(ts)", sqlite: "CAST(strftime('%H', ts) AS INTEGER)", clickhouse: "toHour(ts)" }
```

A fragment must be **portable or per-database**. Every SQL source reads a bare string, so write it in SQL they all
accept (`CASE WHEN status = 'refunded' THEN 1 ELSE 0 END`, not `(status = 'refunded')::int`). Where they really
differ, the map gives each its own entry: `postgres`, `duckdb`, `mysql` (MariaDB too), `sqlite`, `clickhouse`, the
name of a database added from outside, or `elasticsearch` (query DSL or Painless). `default` serves the SQL
databases not named. A query that needs a fragment its source has no entry for is refused with `NOT_SUPPORTED`,
naming the fragment. A YAML anchor writes a map once and reuses it. [SQL databases](../sources/sql.md#pack-fragments)
lists what differs.

Fragments are pasted as written inside a subquery over that entity's own table, so plain column names are never
ambiguous, even under joins. **They are trusted code.** They come from the pack file, never from a request, and
should be reviewed like code.

## Rules checked at load

The loader lists every problem with its path, and `lenspack serve` and `lenspack check` refuse to start until each is
fixed.

- Keys are unique across dimensions and measures.
- Every `entity` named exists; every join's `on` names exactly the two entities involved.
- A dimension has exactly one of `field`, `sql` or `json`, and so does each entry under `also`. `also` names other
  entities, not its own. `grains` only on `type: time`.
- A measure has exactly one of `agg`, `derived` or `levels`. `sql`, `field`, `filter`, `where` and `scale` belong to
  a measure with `agg`. `sql` and `field` are never both set. `count` takes no `sql`.
- A `derived` measure names existing measures, and its `entity` is one of its operands' entities.
- A `levels` measure's targets exist, have no `levels` of their own, and its levels come from one hierarchy.
- A measure with `per` has `agg` and no `sql`, `field`, `filter` or `where` of its own: those go inside `per`.
- A hierarchy's levels are dimensions.
- An example's query names only verified keys the pack has. `lenspack serve` and `lenspack check` also run each
  example against its source and refuse to start on one that would be refused.
- `timeZone` is a known IANA name.

## How the compiler reads a pack

- A measure is added up at its own entity's grain. The measure's entity is the query's root.
- A dimension on another entity is reached by the shortest join path that uses only `many_to_one` and `one_to_one`
  steps. If the only path crosses a `one_to_many` step, the query is refused (`FANOUT_REFUSED`). See
  [Entities and joins](../concepts/entities.md#fan-out).
- `filter` and `where` fold into `CASE WHEN … THEN expr END`, so the aggregate ignores rows outside them.
- A rate written as `agg: avg` over a 0/1 expression is an average over base rows. The rate for everyone and the same
  rate per group are computed the same way; only the grouping differs.
- `derived` is worked out from its operands' totals. Division by zero gives no value rather than an error. Operands
  on different entities are computed separately and combined per group, joined on a dimension they share (through
  `also`).
- A `per` measure groups the rows the query reads (after its time window, filters, tenant and the entity's own
  condition) by the key and by the answer's groups (a breakdown's groups, a series' buckets), then aggregates the one
  value per key. A key with rows in two groups or two buckets counts in each, rows with no key are not counted, and
  `n` counts keys. A filter inside `per` narrows the rows behind each value, not the keys: a key with no matching rows
  counts 0 under `count`. `having` folds into the outer aggregate like a filter, so a group whose keys all fail it
  still shows, as 0 under `count`. A comparison with the previous period groups each period on its own.
- If any entity in the query declares `tenant`, the tenant condition is pushed into that entity's subquery, and a
  query with no tenant is a compile error. See [Scope and tenancy](../access/scope-and-tenancy.md).
- Rates, changes and averages per day are not measures: keep measures simple and let the
  [compute step](../concepts/measures.md#the-compute-step) do the arithmetic.

## Every key

Generated from the schema by `pnpm docs:keys`; the text above is written by hand.

<!-- keys:pack -->

| key | type | required | default |
|---|---|---|---|
| `pack` | string | yes |  |
| `version` | number | yes |  |
| `description` | string |  |  |
| `timeZone` | string |  |  |
| `entities` | map of object | yes |  |
| `entities.<name>.source` | string | yes |  |
| `entities.<name>.grain` | string |  |  |
| `entities.<name>.time` | string or object |  |  |
| `entities.<name>.time (form 2).sql` | SQL fragment (text, or one per database) | yes |  |
| `entities.<name>.time (form 2).type` | `"date"` |  |  |
| `entities.<name>.time (form 3).field` | string | yes |  |
| `entities.<name>.time (form 3).unit` | `epoch_ms`, `epoch_s` | yes |  |
| `entities.<name>.time (form 4).field` | string | yes |  |
| `entities.<name>.time (form 4).type` | `"date"` | yes |  |
| `entities.<name>.tenant` | string or object |  |  |
| `entities.<name>.tenant (form 2).field` | string | yes |  |
| `entities.<name>.tenant (form 2).match` | `exact`, `subtree` |  | `"exact"` |
| `entities.<name>.filter` | SQL fragment (text, or one per database) |  |  |
| `entities.<name>.where` | list of object |  |  |
| `entities.<name>.where[].field` | string | yes |  |
| `entities.<name>.where[].op` | `eq`, `neq`, `in`, `gt`, `gte`, `lt`, `lte`, `exists`, `missing` |  | `"eq"` |
| `entities.<name>.where[].value` | string or number or boolean or list of string or number or boolean |  |  |
| `entities.<name>.joins` | list of object |  | `[]` |
| `entities.<name>.joins[].to` | string | yes |  |
| `entities.<name>.joins[].on` | string | yes |  |
| `entities.<name>.joins[].type` | `many_to_one`, `one_to_one`, `one_to_many` | yes |  |
| `entities.<name>.geo` | object |  |  |
| `entities.<name>.geo.lat` | string | yes |  |
| `entities.<name>.geo.lon` | string | yes |  |
| `dimensions` | list of object |  | `[]` |
| `dimensions[].key` | string | yes |  |
| `dimensions[].entity` | string | yes |  |
| `dimensions[].field` | string |  |  |
| `dimensions[].sql` | SQL fragment (text, or one per database) |  |  |
| `dimensions[].json` | list of string |  |  |
| `dimensions[].also` | map of object |  |  |
| `dimensions[].also.<name>.field` | string |  |  |
| `dimensions[].also.<name>.sql` | SQL fragment (text, or one per database) |  |  |
| `dimensions[].also.<name>.json` | list of string |  |  |
| `dimensions[].type` | `string`, `number`, `boolean`, `time`, `enum` |  | `"string"` |
| `dimensions[].grains` | list of `hour`, `day`, `week`, `month`, `quarter`, `year` |  |  |
| `dimensions[].label` | string |  |  |
| `dimensions[].hint` | string |  |  |
| `dimensions[].synonyms` | list of string |  | `[]` |
| `dimensions[].verified` | boolean |  | `true` |
| `measures` | list of object |  | `[]` |
| `measures[].key` | string | yes |  |
| `measures[].entity` | string | yes |  |
| `measures[].agg` | `count`, `count_distinct`, `sum`, `avg`, `min`, `max`, `median`, `p90`, `p95` |  |  |
| `measures[].sql` | SQL fragment (text, or one per database) |  |  |
| `measures[].field` | string |  |  |
| `measures[].derived` | string |  |  |
| `measures[].filter` | SQL fragment (text, or one per database) |  |  |
| `measures[].where` | list of object |  |  |
| `measures[].where[].field` | string | yes |  |
| `measures[].where[].op` | `eq`, `neq`, `in`, `gt`, `gte`, `lt`, `lte`, `exists`, `missing` |  | `"eq"` |
| `measures[].where[].value` | string or number or boolean or list of string or number or boolean |  |  |
| `measures[].levels` | map of string |  |  |
| `measures[].per` | object |  |  |
| `measures[].per.key` | string or object | yes |  |
| `measures[].per.key (form 2).sql` | SQL fragment (text, or one per database) | yes |  |
| `measures[].per.agg` | `count`, `count_distinct`, `sum`, `avg`, `min`, `max` | yes |  |
| `measures[].per.sql` | SQL fragment (text, or one per database) |  |  |
| `measures[].per.field` | string |  |  |
| `measures[].per.filter` | SQL fragment (text, or one per database) |  |  |
| `measures[].per.where` | list of object |  |  |
| `measures[].per.where[].field` | string | yes |  |
| `measures[].per.where[].op` | `eq`, `neq`, `in`, `gt`, `gte`, `lt`, `lte`, `exists`, `missing` |  | `"eq"` |
| `measures[].per.where[].value` | string or number or boolean or list of string or number or boolean |  |  |
| `measures[].per.having` | object |  |  |
| `measures[].per.having (form 1).op` | `eq`, `neq`, `gt`, `gte`, `lt`, `lte` | yes |  |
| `measures[].per.having (form 1).value` | number | yes |  |
| `measures[].per.having (form 2).op` | `"between"` | yes |  |
| `measures[].per.having (form 2).value` | tuple | yes |  |
| `measures[].scale` | number |  |  |
| `measures[].format` | `number`, `percent`, `currency`, `compact`, `duration` |  | `"number"` |
| `measures[].label` | string |  |  |
| `measures[].hint` | string |  |  |
| `measures[].synonyms` | list of string |  | `[]` |
| `measures[].verified` | boolean |  | `true` |
| `hierarchies` | map of list of string |  | `{}` |
| `instructions` | string |  |  |
| `examples` | list of object |  | `[]` |
| `examples[].question` | string | yes |  |
| `examples[].query` | a query: see [Query format](query.md) | yes |  |
| `examples[].note` | string |  |  |
| `examples[].wordings` | list of string |  |  |

<!-- /keys:pack -->

---

**Next:** [Query format](query.md).

**Related:** [Packs](../concepts/packs.md) · [Write a pack](../extending/write-a-pack.md) ·
[SQL databases](../sources/sql.md)
