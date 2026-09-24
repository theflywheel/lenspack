# Pack spec

A pack is one YAML or JSON document describing a dataset so that a model can query it by name. `@lenspack/spec` validates it; `catalogueFrom(pack)` turns it into the model's vocabulary.

```yaml
pack: <slug>                # lowercase, [a-z][a-z0-9_]*
version: <int>              # bump when keys change; boards record the version they were built against
description: <text>         # optional

entities:
  <entity_key>:
    source: <table|schema.table|view>
    grain: <one line, surfaced to the model>      # optional but recommended
    time: <column>          # default time column for series, windows and comparisons
    # …or an expression, when time is stored as something else (epoch milliseconds in a BIGINT):
    # time: { sql: { postgres: "(to_timestamp(createdtime / 1000.0) AT TIME ZONE 'UTC')", duckdb: "epoch_ms(createdtime)" } }
    tenant: <column>        # when present, every query over this entity MUST carry a tenant
    filter: <predicate>     # carried by every query over this entity, e.g. soft deletes: isdeleted = false
    joins:
      - to: <entity_key>
        on: <a.col = b.col> # exactly the two entities, parsed, never inlined
        type: many_to_one | one_to_one | one_to_many

dimensions:
  - key: <slug>
    entity: <entity_key>
    sql: <fragment>         # OR
    json: [<column>, <key>, <key>…]   # JSON path; the printer emits ->> / #>> or json_extract_string
    type: string | number | boolean | time | enum   # default string
    grains: [hour, day, week, month, quarter, year] # time dimensions only
    label: <text>           # default: key title-cased
    hint: <text>            # shown to the model
    synonyms: [<text>…]     # for list_metrics search
    verified: true|false    # default true; a key in the file was reviewed

measures:
  - key: <slug>
    entity: <entity_key>
    agg: count | count_distinct | sum | avg | min | max | median | p90
    sql: <fragment>         # required unless agg is count
    filter: <predicate>     # optional; rows outside it are ignored by the aggregate
    format: number | percent | currency | compact | duration
  - key: <slug>
    entity: <entity_key>
    derived: <measure> / <measure>   # ratio of two aggregates on the same entity
    format: …
```

## Fragments

A `sql`, `filter` or dimension `sql` value is either a string or a per-dialect map:

```yaml
sql: { postgres: "EXTRACT(HOUR FROM ts)::int", duckdb: "hour(ts)", default: "…" }
```

Fragments are inlined verbatim inside a subquery over that entity's own table, so unqualified column names are unambiguous even under joins. **They are trusted code.** They come from the pack file, never from a request, and should be reviewed like code.

## Rules enforced at load

- Keys are unique across dimensions and measures.
- Every `entity` reference exists; every join's `on` names exactly the two entities involved.
- A dimension has exactly one of `sql` or `json`; `grains` only on `type: time`.
- A measure has `agg` (with `sql` unless `count`) or `derived`, not both; derived operands must be non-derived measures on the same entity.

## Semantics the compiler applies

- A measure is aggregated at its own entity's grain. The measure's entity is the query's root.
- A dimension on another entity is reached by the shortest join path using only `many_to_one` / `one_to_one` steps. If the only path crosses a `one_to_many` step, the query is refused (`FANOUT_REFUSED`).
- Rates (`agg: avg` over a 0/1 expression) are averages over base rows. A rate for the whole population and the same rate per group are computed identically; only the `GROUP BY` differs.
- `derived: a / b` compiles to `CAST(agg_a AS DOUBLE) / NULLIF(agg_b, 0)`.
- `filter` folds into `CASE WHEN filter THEN expr END`, so the aggregate ignores rows outside it.
- If any entity in the query declares `tenant`, the tenant predicate is pushed into that entity's subquery and a missing tenant is a compile error.
