# Queries

A query is a question for the source, written only with pack keys. This page introduces the five shapes a query
can take and what makes them safe. It is for anyone reading a board's JSON, or building on Lenspack.

## Five shapes, closed

```ts
{ kind: "breakdown", dimension: "country", measure: "revenue", limit: 10 }                  // a measure per group
{ kind: "series",    measure: "orders", grain: "week", by: "channel", time: { last: "12w" } } // a measure per time bucket
{ kind: "value",     measure: "revenue", compare: "previous_period", time: { last: "30d" } }  // one number
{ kind: "rows",      entity: "orders", columns: ["status", "channel"], limit: 20 }           // records
{ kind: "points",    entity: "stores", color: "format", size: "revenue" }                    // one dot per location
```

The list is closed: there is no sixth kind and no field that holds free text. Every string is a key the pack must
know. A widget on a board holds one query; the model's `query` tool sends one; the board API takes them too.

## What a query can add

- **`time`**: a window. A rolling length (`{ last: "30d" }`), exact dates (`{ from, to }`), or calendar periods in
  the pack's time zone (`{ period: "month", offset: -1 }` is last month). Relative windows are worked out when the
  query runs, so a saved board keeps meaning "the last 30 days".
- **`filters`**: conditions on dimensions, such as `{ dimension: "channel", op: "eq", value: "web" }`.
- **`compare: "previous_period"`**: each number beside the same span just before.
- **`share`** and **`other`**: each group's share of the whole, and one row for everything outside the top groups.
- **`measures`**: more measures over the same groups, as extra columns or series.
- **`compute`**: arithmetic steps run on the answer. See [Measures and the compute step](measures.md#the-compute-step).

## Why queries are safe

The compiler turns a query into SQL (or a search request) and guarantees, and tests check, that:

- every identifier in the SQL came from the pack;
- every value is a bound parameter, never pasted into the text;
- a tenant condition is present whenever an entity declares one;
- a `LIMIT` is always there;
- a join that would multiply numbers is refused, not computed.

Ask for something the pack cannot answer and the compiler declines with a code, the reason and the nearest key:

| asked for | the answer |
|---|---|
| revenue by country | compiles, and returns the SQL it would run |
| revenue by product category | `FANOUT_REFUSED`, with a measure that works |
| revenue by contry | `UNKNOWN_DIMENSION`, nearest key `country` |
| median order value | `UNKNOWN_MEASURE`: the pack has no median; the nearest measure is named |

You can ask the running compiler yourself: `GET /api/<pack>/explain?q=<query JSON>` returns the SQL it would run,
or the refusal.

---

**Next:** [Filters](filters.md).

**Related:** [Query format reference](../reference/query.md) · [The life of a query](../architecture/life-of-a-query.md) ·
[Refusal codes](../reference/errors.md)
