# Packs

A pack is one file that describes your data so a model can ask for numbers by name. This page explains what goes
in it and why it is the centre of Lenspack. It is for anyone who will write, review or read a pack.

## What a pack is

A pack is a YAML or JSON document. It names:

- the **entities**: the tables or indexes you measure, with the grain of each and how they join;
- the **dimensions**: what you can group and filter by;
- the **measures**: what you can count or add up;
- optional **instructions**: rules the keys cannot say, sent to the model on every turn;
- optional **examples**: questions with the query someone checked for each.

Here is the shop's pack, shortened:

```yaml
pack: commerce
version: 1
entities:
  orders:
    source: orders
    grain: one row per order
    time: placed_at
    joins:
      - { to: customers, on: orders.customer_id = customers.id, type: many_to_one }
  customers: { source: customers, grain: one row per customer }
dimensions:
  - { key: country, entity: customers, field: country, synonyms: [market, region] }
  - { key: channel, entity: orders,    field: channel, type: enum }
measures:
  - { key: orders,  entity: orders, agg: count }
  - { key: revenue, entity: orders, agg: sum, sql: total_cents / 100.0, format: currency }
```

## Why a pack

**People write it; the model reads it.** A person who knows the data writes the pack and reviews changes to it in
git, like any other code. The model is given the pack's keys (its *catalogue*) and can only name them. It never
sees table names it could misuse, and it never edits the pack.

**The vocabulary is closed.** Ask for `median_order_value` when the pack has none and the answer is a refusal
naming the nearest measure that exists. What the pack does not declare, the compiler will not build.

**The pack is trusted code.** Its `sql:` fragments are copied into queries as written, because they come from a
reviewed file and never from a request. Review pack changes the way you review database migrations.

**One pack, any source.** A pack that names columns with `field:` and conditions with `where:` (instead of SQL
fragments) runs unchanged on every SQL database and on Elasticsearch. See [Sources](sources.md).

## The catalogue

When Lenspack loads a pack it builds the **catalogue**: the keys, their labels, hints and synonyms, as the model
and the board app see them. A person whose access hides some keys gets a catalogue without them. See
[Pack access rules](../access/pack-rules.md).

## Where a pack comes from

- **Written by hand**, for a database you own. See [Write a pack](../extending/write-a-pack.md).
- **Built from Superset's datasets** at start-up, when Lenspack runs inside Superset: a dataset becomes an entity,
  its saved metrics become measures and its columns become dimensions. See
  [Datasets and dashboards](../hosts/superset/datasets-and-dashboards.md).
- **Compiled from another system's dashboard configuration.** See [Importers](../extending/importers.md).

## Versions

A pack has a `version` number. Bump it when keys change: boards record the version they were built against.
Inside a deployment, an admin can add [definitions](definitions.md) on top of the pack without touching the file.

---

**Next:** [Sources](sources.md).

**Related:** [Pack file reference](../reference/pack.md) · [Write a pack](../extending/write-a-pack.md)
