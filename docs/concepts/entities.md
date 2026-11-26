# Entities and joins

An entity is a table (or view, or index) the pack measures. This page explains grain, time, joins and the one
refusal that matters most: fan-out. It is for anyone writing or reviewing a pack.

## Entities and their grain

Each entity names its source table and its **grain**: what one row is.

```yaml
entities:
  orders:      { source: orders,      grain: one row per order,           time: placed_at }
  order_items: { source: order_items, grain: one row per line on an order }
  customers:   { source: customers,   grain: one row per customer }
```

The grain is shown to the model, and it keeps the pack's author honest. A measure is always counted at its own
entity's grain: `orders` counts order rows, `units` adds up line rows.

An entity can also say:

- **`time`**: the column series, windows and comparisons use by default. It can be a timestamp, a number of
  seconds or milliseconds since 1970, or a column of calendar dates.
- **`tenant`**: a column that every query must be narrowed by. See [Row scope and tenancy](../access/scope-and-tenancy.md).
- **`filter`** or **`where`**: a condition every query on the entity carries, such as leaving out soft-deleted
  rows. No query can forget it.
- **`geo`**: latitude and longitude columns, so its rows can be drawn on a map.

## Joins, with their direction

```yaml
  orders:
    joins:
      - { to: customers,   on: orders.customer_id = customers.id,   type: many_to_one }
      - { to: order_items, on: order_items.order_id = orders.id,    type: one_to_many }
```

The `type` says how many rows on each side match: many orders to one customer (`many_to_one`), one order to many
lines (`one_to_many`). Lenspack follows only `many_to_one` and `one_to_one` steps when it reaches a dimension on
another entity.

## Fan-out

Ask for revenue by country: revenue lives on orders, country on customers, and each order has one customer. The
join is safe, and Lenspack answers.

Ask for revenue by product category: category lives on products, reached through order lines. An order has many
lines, so joining would repeat each order's revenue once per line and inflate the total. Lenspack refuses:

> `FANOUT_REFUSED`: category lives on products, which has many rows per order, so grouping an order-level measure
> by it would multiply the numbers.

The refusal suggests what works: a measure at line grain (`item_revenue`), or a dimension on orders. A number that
silently multiplies is worse than no number, so Lenspack never computes one.

## Search indexes

An Elasticsearch index cannot join. A dimension that lives on another entity is refused there, with the
dimensions it can group by, unless the pack declares the same dimension on both entities with `also:`. See
[Elasticsearch](../sources/elasticsearch.md).

---

**Next:** [Dimensions](dimensions.md).

**Related:** [Pack file reference](../reference/pack.md#entities) · [The life of a query](../architecture/life-of-a-query.md)
