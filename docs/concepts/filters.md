# Filters

Lenspack has three kinds of filter, set by three different people. This page tells them apart, because they combine
and because only one of them can be removed by the person asking. It is for anyone designing boards or access.

## 1. A query's own filters

Part of the question. The model adds them ("revenue in France"), or a widget is saved with them.

```json
{ "kind": "value", "measure": "revenue", "filters": [{ "dimension": "country", "op": "eq", "value": "FR" }] }
```

The operators are `eq`, `neq`, `in`, `gte`, `lte`, `between`, `contains`, `subtree` (a node of a dotted path and
everything under it) and `segment` (one part of a `|`-separated path).

## 2. A board's filter bar

A board can carry filters that readers pick from: a list of values (`select`), a search box (`search`) or a date
range (`daterange`). Each says which widgets it applies to and may have a default. When a reader picks a value,
the widgets it applies to are narrowed.

```json
{ "id": "filter_country", "type": "select", "label": "Country", "field": "country", "applies": ["*"] }
```

What a reader has picked is sent with each chat question, so "how many orders today?" with one country picked is
answered for that country, and "How this was worked out" says whether each pick was applied. Inside Superset, a
dashboard's native filters are read as board filters; one Lenspack cannot express is kept exactly as Superset has
it. See [Datasets and dashboards](../hosts/superset/datasets-and-dashboards.md#the-filter-bar).

## 3. A person's row scope

Set by the deployment, not the person. A row scope narrows every query a person runs: board widgets, filter menus,
the chat's tools, everything. It comes from the host (Superset's row-level security, a sign-in's claims) or from a
pack access rule, and nothing the person does can remove it.

A query that cannot be narrowed by the scope is refused (`OUT_OF_SCOPE`) rather than answered for all rows. See
[Row scope and tenancy](../access/scope-and-tenancy.md).

## How they combine

All three apply together. A query filter and a board pick can narrow further, but they can never widen what the
scope allows: a person held to the North region who asks about the South gets nothing from the South.

---

**Next:** [Boards and widgets](boards.md).

**Related:** [Query format](../reference/query.md#filters) · [Board format](../reference/board.md#filters)
