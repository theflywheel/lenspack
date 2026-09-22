# Query IR

The intermediate representation is a closed union. Every string in it is a key that must exist in the pack's catalogue; there is no free-text field anywhere.

```ts
type Query =
  | { kind: "breakdown"; dimension: string; measure: string; limit?: number; sort?: "asc"|"desc"; time?: TimeRange; filters?: Filter[] }
  | { kind: "series";    measure: string; grain?: Grain; by?: string; time?: TimeRange; filters?: Filter[] }
  | { kind: "value";     measure: string; compare?: "previous_period"; time?: TimeRange; filters?: Filter[] }
  | { kind: "rows";      entity: string; columns: string[]; limit?: number; orderBy?: { key: string; dir: "asc"|"desc" }; time?: TimeRange; filters?: Filter[] };

type Filter    = { dimension: string; op: "eq"|"neq"|"in"|"gte"|"lte"|"between"|"contains"; value: Scalar | Scalar[] };
type TimeRange = { last: "30d" | "12w" | "6m" | "2y" | "48h" } | { from: ISO8601; to: ISO8601 };
type Grain     = "hour"|"day"|"week"|"month"|"quarter"|"year";
```

| shape | answers | notes |
|---|---|---|
| `breakdown` | a measure per group | `limit` 2–50 (default 12); ties broken by group name; time dimensions are refused (use `series`) |
| `series` | a measure per time bucket | uses the root entity's `time` column; `by` splits into at most 12 series (top by total, the rest dropped — never bucketed as "other") |
| `value` | one number | `compare` needs a `time` range and returns `previous` and `delta` from one statement |
| `rows` | records | `columns` are dimension keys on that entity; `limit` 1–500 |

Relative `time` is resolved against `now` at query time, so a saved board keeps meaning "the last 30 days".

## Compiler

```
resolve : (Query, Pack, Ctx) → BoundPlan | ResolveError    keys, join paths, tenant, windows
plan    : (BoundPlan, Pack) → Ast                           one subquery per entity, projections, aggregates
print   : (Ast, Dialect) → { sql, params }                  postgres | duckdb
```

`ResolveError` carries `{ code, key, nearest }`. Codes: `UNKNOWN_MEASURE`, `UNKNOWN_DIMENSION`, `UNKNOWN_ENTITY`, `NO_JOIN_PATH`, `FANOUT_REFUSED`, `TENANT_REQUIRED`, `NO_TIME`, `NEEDS_TIME_RANGE`, `WRONG_ENTITY`, `TIME_DIMENSION`.

### Invariants

1. Every identifier in emitted SQL originates from the pack.
2. Every request value is a bound parameter (`$n` on both engines).
3. A declared tenant is always present in the predicate, or compilation fails.
4. `LIMIT` is always emitted.
5. Read-only transaction and statement timeout are applied by the executor, never expressed in SQL.
6. Fan-out is refused, not computed.
7. Population and per-group rates share the same base rows.

### What the printer owns

Identifier quoting, JSON access (`->>`/`#>>` vs `json_extract_string`), `date_trunc` and week start, casts (`DOUBLE PRECISION` vs `DOUBLE`), `percentile_cont … WITHIN GROUP` vs `quantile_cont`, `count(DISTINCT …)`. Nothing above the printer mentions a dialect.

### Shape of the SQL

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
