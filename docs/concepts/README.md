# Concepts in one page

This page introduces every idea Lenspack is built from, in the order they depend on each other, using one running
example. Read it before configuring anything; each idea has its own page after this one.

## The running example

A small online shop, with made-up data. It is the `commerce` example in this repository, and
`pnpm seed commerce ./commerce.duckdb` creates it.

| table | one row per | some columns |
|---|---|---|
| `orders` | order | `placed_at`, `status`, `channel`, `total_cents`, `customer_id` |
| `customers` | customer | `country`, `segment`, `signed_up_at` |
| `order_items` | line on an order | `order_id`, `product_id`, `qty`, `unit_cents` |
| `products` | product | `category` |

The shop's team wants a dashboard of revenue and orders, and its readers want to ask things like "revenue by
country last month" or "the 7-day average of orders".

## The ideas, in order

```
                 ┌──────────── pack (reviewed in git) ─────────────┐
                 │ entities · joins · dimensions · measures · rules │
                 └───────────────┬─────────────────────────────────┘
                                 │ names every key
   person ──► host ──► policy ──► turn ──► query ──► engine ──► source
   (asks)    (who is    (what      (model    (keys      (checks,    (database
             asking)    they may   + tools)  only)      compiles)   runs it)
                         see)        │
                                     └──► edits ──► board (widgets, filters, layout)
```

1. **[Pack](packs.md).** One reviewed file that describes the shop's data. Everything the model can ask for is a
   key in it.
2. **[Source](sources.md).** Where the rows live: here, a DuckDB file. The same pack can run on Postgres, ClickHouse
   or Elasticsearch.
3. **[Entities and joins](entities.md).** Each table the pack uses is an entity with a grain ("one row per order")
   and declared joins. The direction of each join is what lets Lenspack refuse a question that would count orders
   twice.
4. **[Dimensions](dimensions.md).** What you group or filter by: `country`, `channel`, `category`.
5. **[Measures](measures.md).** What you count or add up: `orders`, `revenue`. Kept simple; rates and changes
   come from the **compute step**, arithmetic done on the source's answer.
6. **[Queries](queries.md).** A question for the source, in one of five shapes, naming only pack keys:
   `{ kind: "breakdown", dimension: "country", measure: "revenue" }`.
7. **[Filters](filters.md).** A query's own filters, a board's filter bar, and the row scope a person is held to.
8. **[Boards and widgets](boards.md).** A dashboard as a document: widgets, each with a query, plus filters and a
   layout. Changed only through checked edit operations; every change is a new version.
9. **[Turns](turns.md).** One message in the chat and everything Lenspack does to answer it: the model, its tools,
   the checks and the reply.
10. **[Hosts](hosts.md).** The app Lenspack runs inside: Superset, its own server, your React app, or an MCP
    client. The host says who is asking and keeps the boards.
11. **[Policy](policy.md).** What the person asking may see and change: the host's answer, narrowed by
    Lenspack's rules, enforced on every query.
12. **[Definitions and open questions](definitions.md).** What a word means in this deployment ("this month" is
    the calendar month), added by an admin on top of the pack.
13. **[Saved answers](saved-answers.md).** A question answered well before is answered again by re-running its
    queries, without the model.

## Three promises that follow

- **Every figure comes from a measure the pack approved.** The model picks keys; it does not write SQL.
- **A mistake is a refusal, not a wrong number.** An unknown key, a join that would multiply, a percentile the
  database cannot compute: each is refused with a reason and the nearest thing that works.
- **Nobody sees more than the host allows.** Lenspack can only narrow what the host grants.

---

**Next:** [Packs](packs.md).

**Related:** [Glossary](../reference/glossary.md) · [Architecture](../architecture/README.md)
