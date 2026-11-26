# The compute step

This page explains compute steps: rates, changes, rolling averages, running totals and summaries per group, worked
out by Lenspack on numbers the source has already counted. It is for pack authors, admins checking an answer, and
anyone building widgets by hand.

A pack defines simple measures: units dispatched, visits, orders placed. People ask for more than that:
a burn rate, a day-on-day change, a 7-day average, the average daily change per region. None of these needs a new
measure. Each is ordinary arithmetic on numbers the source has already aggregated.

A query can carry `compute`: a short list of steps run in order on the source's answer. The model still never
writes SQL, and every number still comes from the source. The steps only combine those aggregated numbers, in
plain TypeScript in the engine, the same way for every source (SQL databases, Elasticsearch, Superset).

```ts
compute?: {
  grain?: "hour" | "day" | "week" | "month" | "quarter" | "year"; // the time buckets the steps run over
  steps: Step[];                                                   // 1 to 4, in order
}
```

`compute` is allowed on `breakdown`, `series` and `value` queries.

## The steps

| step | what it does | example |
|---|---|---|
| `{ op: "ratio", to: m, percent? }` | the measure divided by measure `m`, per group (and per time bucket) | units dispatched per unit received |
| `{ op: "change", percent? }` | each time bucket against the bucket just before it: the difference, or the relative change | day-on-day % change |
| `{ op: "rolling", fn: "mean" \| "sum", window: n }` | each time bucket with the `n - 1` before it, averaged or added | 7-day average |
| `{ op: "running_total" }` | the total so far, from the first bucket shown | stock dispatched to date |
| `{ op: "over_time", fn }` | the time buckets of each group as one number: `mean`, `sum`, `min`, `max`, `median` or `last` | average daily units dispatched |

Where each step may go:

- `ratio` comes first. It divides the two measures at the query's own grain, before any step over time.
- `over_time` comes last. It collapses the time buckets, so it ends a `breakdown` (one number per group) or a
  `value` (one number). A `series` keeps its buckets and never ends with it.
- The other steps work on time buckets. A `series` runs them over its own grain. A `breakdown` or `value` must name
  the grain in `compute.grain`: there is no default, because "average per day" and "average per week" are
  different numbers.
- A computed query has no `compare`, `share`, `other` or further `measures`, and a computed breakdown with steps
  over time groups by one dimension (no `by`).

The query's kind is the shape of the answer. A computed `breakdown` draws as bars or a table, a computed `series`
as a line, a computed `value` as a single number.

A KPI is one number. Over a `series` it shows the latest bucket, with the trend where the host draws one. A summary
of the buckets (the average per day, the total over the weeks) is a `value` whose steps end with `over_time`, so it
follows the rules below like any other computed number.

Boards saved before this carry an `aggregate` field on a KPI: how the renderer used to fold a series into one number.
It is read when the board loads, and never saved again:

| saved `aggregate` | read as |
|---|---|
| none, or `last` | dropped: the KPI shows the series' latest bucket, as it did |
| `sum`, `avg`, `max`, `min`, on a series | a `value` over the same window and filters, with `compute: { grain: <the series' grain>, steps: [<its steps>, { op: "over_time", fn }] }` (`avg` becomes `mean`) |
| anything else | dropped, and the KPI shows the series' latest bucket |

"Anything else" is `count` (how many buckets came back, which no step gives), a series split by a dimension (the old
fold added every split's buckets together), a series that already has four steps, and any value on a `value` query,
where the field never did anything. A summary read this way obeys the rules below: a percentage or an average is not
added up, so such a `sum` is refused on the widget, with a way forward, instead of showing a wrong number.

## Examples

These use a made-up stock pack with two count measures, `dispatched` and `received`, and a `region` dimension.

**Burn rate per region.** The source answers units dispatched per region and day; the engine averages each region's days.

```json
{ "kind": "breakdown", "dimension": "region", "measure": "dispatched", "time": { "period": "month", "offset": -1 },
  "compute": { "grain": "day", "steps": [{ "op": "over_time", "fn": "mean" }] } }
```

**Day-on-day % change**, as a line:

```json
{ "kind": "series", "measure": "dispatched", "grain": "day", "time": { "last": "30d" },
  "compute": { "steps": [{ "op": "change", "percent": true }] } }
```

**Average day-on-day % change per region**: the change per region and day, then its average per region.

```json
{ "kind": "breakdown", "dimension": "region", "measure": "dispatched", "time": { "last": "30d" },
  "compute": { "grain": "day", "steps": [{ "op": "change", "percent": true }, { "op": "over_time", "fn": "mean" }] } }
```

**Units dispatched as a share of units received**, per region.

```json
{ "kind": "breakdown", "dimension": "region", "measure": "dispatched",
  "compute": { "steps": [{ "op": "ratio", "to": "received", "percent": true }] } }
```

The agent's tools take the same steps as one string, like filters: `compute: "pct_change, mean"` with
`grain: day`. They also accept `change`, `rolling_mean 7`, `rolling_sum 7`, `running_total`, `ratio received`, and
a closing `mean`, `sum`, `min`, `max`, `median` or `last`.

## How zeros and gaps are treated

These rules are the same on every source, and the answer says which ones applied (the `computed` text below).

- **The window is the measure's own days.** A summary (`over_time`) runs from the first bucket where the measure has
  a value to the last, in the pack's time zone. A bucket of 0 for a count or a sum is not a value here: rows that
  are only of another measure (receipts, on days with no dispatch) do not stretch the window, nor do days of 0 at
  either end. The window is the same for every group, so each group is averaged over the same days. With a time
  range, the window stays inside it; when no bucket in the range has a value, the window is the whole range. A
  series with a time range runs over the whole range; with none, over the measure's own buckets, like a summary.
- **Never past now.** No window goes past the bucket holding the current time in the pack's time zone (today, for
  days). A row dated later is not counted, and the answer says so.
- **Empty buckets.** Inside the window the steps run over every bucket. A bucket with no records is **0 for a
  count, a sum or a distinct count** (nothing happened). For anything else (an average, a percentile, a ratio) it
  **has no value** and is skipped.
- **A ratio is taken wherever either measure has rows.** A group or bucket where the divisor has rows and the
  numerator has none is 0 for a count or a sum (nothing happened), and has no value for anything else.
- **Zero or missing bases are skipped, never counted as 0 or as infinite.** A ratio whose divisor is 0 or missing has
  no value. A % change from 0 has no value. A change from or to a bucket with no value has no value.
- **The first bucket changes from the bucket before it.** With a time range, the source is asked for one bucket
  before the range too, so the window's first bucket has one to change from even at the start of the range; it is
  read only for this change, and is not shown or counted. With no time range there is no bucket before the first,
  so the first bucket has no change.
- **A rolling window is full or nothing.** The first `window - 1` buckets of the window are left out of the answer,
  and a window that contains a bucket with no value has no value.
- **A running total** starts at the first bucket shown; a bucket with no value adds nothing.
- **A summary skips buckets with no value.** A group with none has no value and sorts last.
- **Ratios and percentages are never added up.** `sum` over time, `rolling` sums and running totals are refused for
  a percentage, an average, a ratio, a % change, a rolling average or a running total. A distinct count is not
  added up either (one key seen on two days would count twice), nor is a count or sum taken per key (users with 3+
  sessions); use `mean`, or ask for it over the whole window without steps. The rule is checked when a widget is
  added or changed, and again when it is run. The same rule decides which measures take a share or an Other row.
- **Relative change** is `(this - before) / |before|`, as the previous-period comparison already computes it.

## Size

The source is asked for the base grain: the measure per group and time bucket, for every group (not a top few),
at most 20,000 numbers. An answer that would be larger, or that the source says it cut, is refused with a way
forward (a shorter time range, a coarser grain, a filter), never computed from part of the data. A split series still shows its top 12 series,
ranked by the measure's total.

## Not yet

Planned additions, each worked out by the engine after the source answers, so every source gets them at once:

- **a filter on a group's value**: "regions below 80%", not just "the worst 10";
- **a summary across groups**: "how many regions are below 80%", "the average across regions";
- **a previous-period comparison of a ratio, per group**: "which regions improved since yesterday";
- **periods from a calendar of your own**: "since the start", "round 2 against round 1".

## In words

Every computed answer carries a name for its numbers and the rules it followed, in plain words:

```
label:    average day-on-day % change in units dispatched
computed: average day-on-day % change in units dispatched: a day with no records counts as 0; the first day
          changes from the day before it, even when that is before the time range; a change from 0 has no
          percentage and is skipped; days without a value are skipped in the average; averaged over 20 days,
          2026-03-01 to 2026-03-20 (the first to the last day with units dispatched in the time range)
```

The answer also carries the window itself, `window: { from, to, buckets, grain }` (the first and last bucket, named
as the rows name them, and how many), so a reply can say "averaged over 20 days, 1 to 20 March".

The chart and table use the label; the agent's `query` tool returns `computed`, and `explain` starts with the rules
(the window is known only once the source has answered).

## Inside Superset

A computed widget saved to a Superset dashboard is kept as an ordinary Superset chart, and Superset redraws it
with its own arithmetic. Lenspack saves it only when Superset's chart gives the same number, and refuses it
otherwise, with the nearest chart Superset keeps exactly. The chat still answers every computed question. See
[Computed charts in Superset](../hosts/superset/computed-charts.md).

---

**Next:** [How this was worked out](explain.md).

**Related:** [Measures and the compute step](../concepts/measures.md) · [Query format](../reference/query.md#compute) ·
[How this was worked out](explain.md)
