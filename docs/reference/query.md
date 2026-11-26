# Query format

This page is the full format of a query: the five shapes, their fields and limits, time ranges, filters and the
compute step. It is for developers who build queries by hand, and for reviewers checking what a model asked for.
For the idea, read [Queries](../concepts/queries.md).

A query is a closed union. Every string in it is a key that must exist in the pack's catalogue; there is no free-text
field anywhere. `querySchema` in `@lenspack/core` is the source of truth.

```ts
type Query =
  | { kind: "breakdown"; dimension: string; measure: string; by?: string; measures?: string[]; limit?: number;
      sort?: "asc" | "desc"; sortBy?: "value" | "measure" | "group" | "none"; compare?: "previous_period";
      share?: boolean; other?: boolean; compute?: Compute; time?: TimeRange; filters?: Filter[] }
  | { kind: "series"; measure: string; grain?: Grain; by?: string; measures?: string[]; compute?: Compute;
      time?: TimeRange; filters?: Filter[] }
  | { kind: "value"; measure: string; compare?: "previous_period"; measures?: string[]; compute?: Compute;
      time?: TimeRange; filters?: Filter[] }
  | { kind: "rows"; entity: string; columns: string[]; limit?: number; orderBy?: { key: string; dir: "asc" | "desc" };
      offset?: number; time?: TimeRange; filters?: Filter[] }
  | { kind: "points"; entity: string; color?: string; size?: string; label?: string; limit?: number;
      time?: TimeRange; filters?: Filter[] };

type Grain = "hour" | "day" | "week" | "month" | "quarter" | "year";
```

## The shapes

| shape | answers | fields and limits |
|---|---|---|
| `breakdown` | a measure per group | `limit` 2–500 (default 12). `sort` `desc` by default. `sortBy`: `value` (the default; ties broken by group name, so the same data always lists the same way), `measure` (the measure alone), `group` (the group's own order: a date, a code) or `none` (the source's order, for a dashboard moved from another system that must list tied rows the same way). Time dimensions are refused; use `series`. |
| `series` | a measure per time bucket | uses the root entity's `time`. `grain` defaults to `day`. |
| `value` | one number for the whole population | its own shape because a rate over everyone is not the average of the per-group rates. |
| `rows` | records | `columns`: 1–20 dimension keys on that entity. `limit` 1–1000 (default 50). `orderBy.dir` defaults to `desc`. `offset` (0–10,000) skips rows for a later page of a table; it is set per request and never stored on a board. |
| `points` | where an entity's rows are | the entity must declare `geo`. One row per location: `lat`, `lon`, plus `color` and `label` (dimensions on the entity; `color` not a time dimension) and `size` (a measure on the entity, added up per location). Rows without coordinates are left out. `limit` 1–5000 (default 5000); with a `size` the largest points are kept, and a cut list says so in `notes`. Only for sources that say they can (SQL databases, Superset); Elasticsearch refuses it. Drawn by a `map` chart or listed by a table. |

### Options on breakdown, series and value

- **`by`** splits a breakdown into one row per (group, `by`) pair, drawn as stacked or grouped bars, or a series into
  at most 12 lines (the top ones by total; the rest are dropped, never lumped into "other", and on SQL sources the
  answer's `notes` say how many). Split by `by`, a source returns at most 10,000 rows for a breakdown; past that the
  answer is marked `truncated` and says the groups are ranked on part of the data.
- **`measures`** adds up to 11 more measures over the same groups, drawn as extra table columns or lines. `measure`
  stays the one that is sorted and ranked.
- **`compare: "previous_period"`** (breakdown and value) adds the previous period's value and the change. A value
  compare needs a `time` range and gets both numbers from one statement. A breakdown's groups are the current
  period's. Not on a cross-entity ratio (`NOT_SUPPORTED`).
- **`share`** (breakdown) gives each group's value over the whole population's: for a measure that adds up (a count,
  a sum, or a sum of those), or a distinct or per-key count, whose shares can sum past 1.
- **`other`** (breakdown) adds one `"(other)"` row (`other: true`) for the rest of the population, for a measure that
  adds up only, and not with `by` or `measures`.
- A source returns at most 20,000 rows for a series, latest buckets first. Past that the answer keeps its latest
  whole buckets, is marked `truncated`, and its `notes` say how many it shows.

## Time

```ts
type TimeRange =
  | { last: string }                       // "30d", "12w", "6m", "2y", "48h": 1 to 9999, then h, d, w, m or y
  | { from: string; to: string }           // ISO 8601 with an offset
  | { period: "day" | "week" | "month" | "quarter" | "year"; offset?: number; count?: number };
```

Relative time is resolved against "now" when the query runs, so a saved board keeps meaning "the last 30 days".

- `last` rolls back from now by a fixed length: `h` hours, `d` days, `w` 7 days, `m` 30 days, `y` 365 days.
- `period` is calendar time in the pack's `timeZone` (UTC when absent), weeks from Monday. `offset` runs from −500
  to 0: `0` is the current period up to now, `-1` the previous whole one. `count` (1–500) takes that many periods
  ending at `offset`. "Last month" is `{ period: "month", offset: -1 }`, month to date `{ period: "month" }`, the
  three whole months before this one `{ period: "month", offset: -1, count: 3 }`.
- `compare: "previous_period"` reads the span just before the window. For `last` and `from`/`to` it is the same
  length of time; for `period`, the `count` periods before it. A range that runs to now is compared with the same
  stretch of the previous span, in local days and time of day. For example, this month up to the 28th at noon is
  compared with last month up to the 28th at noon. The comparison never runs past the previous span's end, so the
  31st is compared with the whole of a shorter month.
- Series buckets start at local midnight, local Monday and the local first of the month in the pack's `timeZone`,
  and hour buckets at local hours (30-minute zones included); a bucket's label is its local date. SQLite and MySQL
  bucket in UTC only, so a series in any other zone is refused there (`NOT_SUPPORTED`).
- A time column of calendar dates (`time: { field: …, type: date }`) needs no zone: a day, week or month of dates is
  the same in every zone, so its dates are bucketed as they are, on every source (SQLite, MySQL and Superset
  included). A window is read as whole local days in the pack's `timeZone` and compared with the dates: a date is in
  it when its day starts in it. So `{ last: "7d" }` is today and the 6 days before, today being the date in the
  pack's zone, and `{ period: "day" }` is that date. An exact `from`/`to` end at local midnight is that day; any
  other end is read by the date written in it (an end written in UTC still names the day it says), and an end
  partway through a day starts the next day.

## Filters

```ts
type Filter = { dimension: string; op: FilterOp; value: string | number | boolean | (string | number | boolean)[] };
```

Up to 20 per query; a value list holds 1–100 values.

| op | keeps rows where the dimension… |
|---|---|
| `eq`, `neq` | equals, or does not equal, the value |
| `in` | is one of the values |
| `gte`, `lte` | is at least, or at most, the value |
| `between` | is between two values, both ends kept |
| `contains` | contains the text |
| `subtree` | is a node of a dotted path or anything under it: `north.east` matches `north.east` and `north.east.coast`, not `north.eastern` |
| `segment` | has the value as one whole segment of a `\|`-separated path: `NORTH\|EAST\|COAST` has segment `EAST`, not `EA` |

A filter must narrow every operand of a cross-entity derived measure, or the query is refused (`NOT_SUPPORTED`,
naming the operands that can be narrowed), when the board is edited as when it runs. The one exception is a
reference value that only divides (a target or a capacity: `revenue / sales_target`, not a count of events over time)
when no other divisor is narrowed by that filter: it stays whole ("this kind over the whole goal") and the answer's
`notes` say so.

How a board's filter bar and a person's row scope add their own filters is in [Filters](../concepts/filters.md).

## Compute

`compute` is arithmetic the engine runs on the source's added-up answer. It is allowed on breakdown, series and
value.

```ts
type Compute = { grain?: Grain; steps: Step[] };   // 1 to 4 steps, run in order
type Step =
  | { op: "ratio"; to: string; percent?: boolean }                    // the measure over another, per group and bucket; first
  | { op: "change"; percent?: boolean }                                // each bucket against the one before
  | { op: "rolling"; fn: "mean" | "sum"; window: number }              // window 2–366 buckets
  | { op: "running_total" }
  | { op: "over_time"; fn: "mean" | "sum" | "min" | "max" | "median" | "last" };   // the buckets as one number; last
```

A series has its own grain; a breakdown or a value with a step over time names one in `compute.grain`. What each
step does with zeros and empty buckets is in [The compute step](../features/compute.md).

## What the compiler adds

Every query also gets, without asking: the entity's own `filter` and `where`, the tenant when an entity declares
one, the person's row scope, and a `LIMIT`. How a query becomes SQL, and the rules it never breaks, are in
[The life of a query](../architecture/life-of-a-query.md). What each refusal means is in
[Refusal codes](errors.md).

---

**Next:** [Board format](board.md).

**Related:** [Queries](../concepts/queries.md) · [Filters](../concepts/filters.md) ·
[The compute step](../features/compute.md)
