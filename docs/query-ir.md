# Query IR

The intermediate representation is a closed union. Every string in it is a key that must exist in the pack's catalogue; there is no free-text field anywhere.

```ts
type Query =
  | { kind: "breakdown"; dimension: string; measure: string; limit?: number; sort?: "asc"|"desc"; compare?: "previous_period"; share?: boolean; other?: boolean; compute?: Compute; time?: TimeRange; filters?: Filter[] }
  | { kind: "series";    measure: string; grain?: Grain; by?: string; compute?: Compute; time?: TimeRange; filters?: Filter[] }
  | { kind: "value";     measure: string; compare?: "previous_period"; compute?: Compute; time?: TimeRange; filters?: Filter[] }
  | { kind: "rows";      entity: string; columns: string[]; limit?: number; orderBy?: { key: string; dir: "asc"|"desc" }; time?: TimeRange; filters?: Filter[] }
  | { kind: "points";    entity: string; color?: string; size?: string; label?: string; limit?: number; time?: TimeRange; filters?: Filter[] };

type Filter    = { dimension: string; op: "eq"|"neq"|"in"|"gte"|"lte"|"between"|"contains"; value: Scalar | Scalar[] };
type TimeRange =
  | { last: "30d" | "12w" | "6m" | "2y" | "48h" }
  | { from: ISO8601; to: ISO8601 }
  | { period: "day"|"week"|"month"|"quarter"|"year"; offset?: number /* <= 0, default 0 */; count?: number /* default 1 */ };
type Grain     = "hour"|"day"|"week"|"month"|"quarter"|"year";
```

| shape | answers | notes |
|---|---|---|
| `breakdown` | a measure per group | `limit` 2–50 (default 12); ties broken by group name; time dimensions are refused (use `series`). `compare` adds `compare: { previous, delta }` per row; groups are the current period's. `share`: value over the whole population's (a measure that adds up: a count, a sum or a sum of those; or a distinct or per-key count, whose shares can sum past 1). `other`: one `"(other)"` row (`other: true`) for the rest, for a measure that adds up only, not with `by` or `measures`. Split by `by`, a source returns at most 10,000 rows; past that the answer is marked `truncated` and says the groups are ranked on part of the data. Otherwise `NOT_SUPPORTED`, as is `compare` on a cross-entity ratio |
| `series` | a measure per time bucket | uses the root entity's `time` column; `by` splits into at most 12 series (top by total, the rest dropped, never bucketed as "other"; on SQL sources the answer's `notes` say how many). A source returns at most 20,000 rows for a series, latest buckets first: past that the answer keeps its latest whole buckets, is marked `truncated`, and its `notes` say how many it shows |
| `value` | one number | `compare` needs a `time` range and returns `previous` and `delta` from one statement; the previous span is set out under Time below |
| `rows` | records | `columns` are dimension keys on that entity; `limit` 1–500 |
| `points` | where the entity's rows are | the entity must declare `geo`. One row per location: `{lat, lon}` plus `color` and `label` (dimensions on the entity; `color` not a time dimension) and `size` (a measure on the entity, summed per location). Rows without coordinates are left out. `limit` 1–5000 (default 5000); with a `size` the largest points are kept, and a cut list says so in `notes`. Only for connectors with the `points` capability (SQL, Superset); the search and DSS connectors refuse it. Drawn by a `map` chart or listed by a table |

`compute` is arithmetic run by the engine on the source's aggregated answer: a ratio of two measures, a change
between consecutive time buckets, a rolling window, a running total, and a summary of each group's buckets (an
average per day per group). The steps, their order and how they treat zeros and empty buckets are in
[compute.md](compute.md).

Relative `time` is resolved against `now` at query time, so a saved board keeps meaning "the last 30 days".

A filter must narrow every operand of a cross-entity derived measure, or the query is refused (`NOT_SUPPORTED`, naming the operands that can be narrowed), at edit time as at run time. The one exception is a reference value that only divides (a target, a capacity: `delivered / target`, not a count of events over time) when no other divisor is narrowed by that filter: it stays whole ("this kind over the whole goal") and the answer's `notes` say so.

### Time

- `last` rolls back from now by a fixed length: `h` hours, `d` days, `w` 7 days, `m` 30 days, `y` 365 days.
- `period` is calendar time in the pack's `timeZone` (UTC when absent), weeks from Monday. `offset: 0` is the current period up to now, `-1` the previous whole one; `count` takes that many periods ending at `offset`. "Last month" is `{ period: "month", offset: -1 }`, month to date `{ period: "month" }`, the three whole months before this one `{ period: "month", offset: -1, count: 3 }`.
- `compare: "previous_period"` reads the span just before the window. For `last` and `from`/`to` it is the same length of time; for `period`, the `count` periods before it. A range that runs to now is compared as far into the previous span as now is into the current one, in local days and time of day, and never past that span's end: this month to the 28th at noon against last month to the 28th at noon, the 31st against the whole of a shorter month.
- Series buckets start at local midnight, local Monday and the local first of the month in the pack's `timeZone`, and hour buckets at local hours (30-minute zones included); a bucket's label is its local date. SQLite and MySQL bucket in UTC only, so a series in any other zone is refused there (`NOT_SUPPORTED`).
- A time column of calendar dates (`time: { field: …, type: date }`) needs no zone: a day, week or month of dates is the same in every zone, so its dates are bucketed as they are, on every source (SQLite, MySQL and Superset included). A window is read as whole local days in the pack's `timeZone` and compared with the dates: a date is in it when its day starts in it. So `{ last: "7d" }` is today and the 6 days before, today being the date in the pack's zone, and `{ period: "day" }` is that date. An exact `from`/`to` end at local midnight is that day; any other end is read by the date written in it (an end written in UTC still names the day it says), and an end partway through a day starts the next day.

## Compiler

```
resolve : (Query, Pack, Ctx) → BoundPlan | ResolveError    keys, join paths, tenant, windows
plan    : (BoundPlan, Pack) → Ast                           one subquery per entity, projections, aggregates
print   : (Ast, Dialect) → { sql, params }                  postgres | duckdb | sqlite | mysql | clickhouse | a registered driver's
```

`ResolveError` carries `{ code, key, nearest }`. Codes: `UNKNOWN_MEASURE`, `UNKNOWN_DIMENSION`, `UNKNOWN_ENTITY`, `NO_JOIN_PATH`, `FANOUT_REFUSED`, `TENANT_REQUIRED`, `NO_TIME`, `NEEDS_TIME_RANGE`, `WRONG_ENTITY`, `TIME_DIMENSION`, `NEEDS_JOIN`, `OUT_OF_SCOPE`, and `NOT_SUPPORTED` (what the source cannot compute: a percentile on MySQL or SQLite, a two-stage `per` measure on Elasticsearch, a fragment with no entry for its dialect).

### Invariants

1. Every identifier in emitted SQL originates from the pack.
2. Every request value is a bound parameter (`$n`, `?` or a typed `{pN:Type}`, as the dialect binds).
3. A declared tenant is always present in the predicate, or compilation fails.
4. `LIMIT` is always emitted.
5. Read-only, one statement, a statement timeout and a row cap are applied by the driver, never expressed in SQL.
6. Fan-out is refused, not computed.
7. Population and per-group rates share the same base rows.

### What the printer owns

Identifier quoting, placeholders, JSON access, time buckets and week start, epoch conversion, casts, percentiles (or their refusal), `LIKE` escapes, `IS DISTINCT FROM`, NULL ordering. Each dialect is a table of rules ([drivers.md](drivers.md)); nothing above the printer mentions a dialect, and golden files pin what each one prints.

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
