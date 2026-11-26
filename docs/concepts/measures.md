# Measures and the compute step

A measure is a number you count or add up: orders, revenue, units sold. This page explains why Lenspack keeps
measures simple and gets everything else (rates, changes, averages per day) from the compute step. It is for pack
authors and anyone curious how an answer is worked out.

## Simple base measures

```yaml
measures:
  - { key: orders,  entity: orders,      agg: count }
  - { key: revenue, entity: orders,      agg: sum, sql: total_cents / 100.0, format: currency }
  - { key: units,   entity: order_items, agg: sum, field: qty }
  - { key: refunds, entity: orders,      agg: count, where: [{ field: status, value: refunded }] }
```

Each measure has a key, the entity it is counted on, and an aggregate: `count`, `count_distinct`, `sum`, `avg`,
`min`, `max`, `median`, `p90` or `p95`. A `filter` or `where` counts only some rows (`refunds` above). A `format`
says how to show it: `number`, `percent`, `currency`, `compact` or `duration`.

Lenspack's advice: **keep measures to simple counts and sums**, plus any filter that keeps them correct (soft
deletes, test orders). Do not add a measure for every rate someone might ask about.

## The compute step

People ask for more than counts: a refund rate, a day-on-day change, a 7-day average, the average orders per day
per country. Each of these is ordinary arithmetic on numbers the source has already counted. So a query can carry
**compute steps**, run by Lenspack on the source's answer:

| step | what it gives | example |
|---|---|---|
| `ratio` | one measure over another, per group | refunds per order |
| `change` | each time bucket against the one before | day-on-day % change |
| `rolling` | each bucket with the ones before it, averaged or added | 7-day average |
| `running_total` | the total so far | revenue to date |
| `over_time` | each group's buckets as one number | average orders per day, per country |

```json
{ "kind": "breakdown", "dimension": "country", "measure": "orders", "time": { "last": "30d" },
  "compute": { "grain": "day", "steps": [{ "op": "over_time", "fn": "mean" }] } }
```

The model still writes no SQL, and every number still comes from the source. The steps run the same way on every
source, with written rules for zeros, gaps and empty days, and the answer says in words which rules applied.
See [The compute step](../features/compute.md).

## Why simple measures win

- **Rates stay right when you slice them.** A rate stored as a measure cannot be split or compared correctly,
  because Lenspack does not know its parts. A ratio of two counts can be taken per group, per week, or against the
  previous period.
- **The pack stays small.** A catalogue of 20 clear measures is easier for a person to review and for a model to
  choose from than 200 near-duplicates.
- **Rates are never added up.** Lenspack refuses to add up a percentage, an average or a ratio, which a stored rate
  would invite.

## Other kinds of measure

The pack can still declare these when they help:

- **`derived`**: arithmetic over other measures, such as `revenue / orders` for average order value. Operands may
  live on different entities; each is counted on its own and combined per group.
- **`per`**: two stages, one value per key first, then an aggregate over those, such as the median items per
  order, or customers with three or more orders.
- **`levels`**: one number read at whichever level of a hierarchy is being viewed.
- **`scale`**: multiply the aggregate by a constant.

Measures written as a 0/1 average (`agg: avg` over a `CASE`) also work, and the example packs use them; prefer a
filtered count and a `ratio` step for new packs.

---

**Next:** [Queries](queries.md).

**Related:** [The compute step](../features/compute.md) · [Pack file reference](../reference/pack.md#measures)
