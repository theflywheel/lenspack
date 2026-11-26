# Dimensions

A dimension is something you group or filter by: a country, a channel, a date. This page explains how dimensions
are declared and the options that help the model find the right one. It is for pack authors.

## Declaring one

```yaml
dimensions:
  - { key: country,  entity: customers, field: country, label: Country, synonyms: [market, region] }
  - { key: channel,  entity: orders,    field: channel, type: enum }
  - { key: placed,   entity: orders,    sql: placed_at, type: time, grains: [day, week, month, quarter] }
```

Each dimension has a **key** (the name the model uses), the **entity** it lives on, and exactly one way to read
it: a column or field path (`field`), a SQL fragment (`sql`), or a path inside a JSON column (`json`).

## Helping the model choose

- **`label`**: how people see it ("Country").
- **`synonyms`**: other words people use ("market", "region"). The model's `list_metrics` search uses them.
- **`hint`**: one line for the model ("ISO country code of the shipping address").
- **`type`**: `string` (the default), `number`, `boolean`, `enum` (a short fixed list) or `time`.

## Hierarchies

Some dimensions nest: region, then district, then site. A pack can say so:

```yaml
hierarchies:
  place: [region, district, site]
```

Picking a value on one level narrows the board to it, and anything grouped at or above that level moves one level
down. A measure can also be read at whichever level is being viewed when the source keeps a row per level, such as
targets set per region and per district (`levels:` on the measure).

## The same dimension on several entities

A dimension can be declared on more than one entity with `also:`, when the same idea lives in two tables. This is
what lets one `region` group measures from different entities, and what a ratio across entities joins its two
sides on.

```yaml
  - key: region
    entity: visits
    field: region
    also: { targets: { field: region_name } }
```

## Time

Time is handled two ways:

- each entity's `time` column drives series ("orders per week") and windows ("the last 30 days");
- a `type: time` dimension can also be listed as a column in a rows query.

A breakdown by a time dimension is refused: ask for a series instead. Days, weeks and months start in the pack's
`timeZone` (UTC when absent), and weeks start on Monday. See [Query format](../reference/query.md#time).

---

**Next:** [Measures and the compute step](measures.md).

**Related:** [Pack file reference](../reference/pack.md#dimensions) · [Filters](filters.md)
