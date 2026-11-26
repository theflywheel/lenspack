# The life of a query

This page follows one query from the moment a widget or a tool asks for it to the rows that come back, and names
every check on the way. It is for developers and for reviewers who want to know why a query is safe.

## The path

```
query (keys only)
  │  checked by zod: a closed shape, no free text
  ▼
resolve      keys → pack, join paths, fan-out, tenant, time window, scope, hidden keys, capabilities
  │  a bound plan, or a ResolveError with a code and the nearest key
  ▼
plan         one subquery per entity, projections, aggregates          (SQL sources)
  ▼
print        quoting, placeholders, time buckets, per-database rules   (one table of rules per database)
  │  { sql, params }
  ▼
driver       read-only, one statement, a time limit, a row cap
  │  rows
  ▼
compute      ratio, change, rolling, running total, summary over time   (engine, same for every source)
  ▼
answer       rows, notes, the window, the words of "How this was worked out"
```

## Resolve

`resolve` takes a query, the pack and a context (`ctx`: the tenant, the scope, hidden keys, the time "now") and
returns a bound plan or refuses. It:

- finds each key, or refuses with `UNKNOWN_MEASURE`, `UNKNOWN_DIMENSION` or `UNKNOWN_ENTITY` and the nearest key;
- takes the measure's entity as the query's root, and reaches each dimension by the shortest path of
  `many_to_one` and `one_to_one` joins, or refuses (`FANOUT_REFUSED`, `NO_JOIN_PATH`);
- pushes the tenant condition into each entity that declares one, or refuses (`TENANT_REQUIRED`);
- turns a relative window into exact bounds, in the pack's time zone;
- adds the caller's scope and refuses a query the scope cannot narrow (`OUT_OF_SCOPE`);
- refuses a hidden key (`NOT_PERMITTED`) or a key the host keeps from the caller (`ACCESS_HIDDEN`);
- refuses what the connector says it cannot do (`NOT_SUPPORTED`).

Every path to a source goes through `resolve`: board widgets, filter menus, explain, and the chat's tools.

## Compile

**SQL sources** plan, then print. The planner builds one subquery per entity over that entity's own table, so a
pack fragment's unqualified column names stay unambiguous under joins. The printer asks a table of rules for
everything that differs between databases: quoting, placeholders, time buckets, week start, JSON access,
percentiles. Nothing above the printer mentions a database by name. See [SQL databases](../sources/sql.md#the-dialect).

The SQL for revenue by country, last 30 days:

```sql
SELECT "customers"."__d_country" AS "group", sum("orders"."__m_revenue") AS "value", count(*) AS "n"
FROM (SELECT *, (total_cents / 100.0) AS "__m_revenue" FROM "orders") AS "orders"
LEFT JOIN (SELECT *, (country) AS "__d_country" FROM "customers") AS "customers"
  ON "orders"."customer_id" = "customers"."id"
WHERE "orders"."placed_at" >= CAST($1 AS TIMESTAMP) AND "orders"."placed_at" < CAST($2 AS TIMESTAMP)
GROUP BY "customers"."__d_country"
ORDER BY "value" DESC NULLS LAST, "group" ASC NULLS LAST
LIMIT 10
```

**Elasticsearch** turns the plan into aggregations. **Superset** turns it into a chart-data request.

## Run

The driver runs the statement read-only, as one statement, under a time limit and a row cap. A result over the cap
is an error, never a shorter answer. See [SQL databases](../sources/sql.md#the-guards-belong-to-the-driver).

## Compute and answer

If the query has compute steps, the engine asks the source for the base numbers (the measure per group and time
bucket) and runs the steps itself, with the same rules on every source. The answer carries the rows, any notes
("showing the top 12 series"), the window the steps covered, and a plain-words description. See
[The compute step](../features/compute.md).

## The invariants

1. Every identifier in the SQL comes from the pack.
2. Every value from a request is a bound parameter.
3. A declared tenant is always in the condition, or the query does not compile.
4. A `LIMIT` is always there.
5. Read-only, one statement, a time limit and a row cap are applied by the driver, never written into the SQL.
6. Fan-out is refused, not computed.
7. A rate for the whole population and the same rate per group are counted from the same rows.

Property tests check these, and golden files pin what each database is sent.

---

**Next:** [The life of a turn](life-of-a-turn.md).

**Related:** [Query format](../reference/query.md) · [Refusal codes](../reference/errors.md) · [Entities and
joins](../concepts/entities.md)
