# Compute: arithmetic after the source answers

A pack defines simple measures: units dispatched, visits, households reached. People ask for more than that:
a burn rate, a day-on-day change, a 7-day average, the average daily change per ward. None of these needs a new
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

## Examples

**Burn rate per ward.** The source answers units dispatched per ward and day; the engine averages each ward's days.

```json
{ "kind": "breakdown", "dimension": "ward", "measure": "dispatched", "time": { "period": "month", "offset": -1 },
  "compute": { "grain": "day", "steps": [{ "op": "over_time", "fn": "mean" }] } }
```

**Day-on-day % change**, as a line:

```json
{ "kind": "series", "measure": "dispatched", "grain": "day", "time": { "last": "30d" },
  "compute": { "steps": [{ "op": "change", "percent": true }] } }
```

**Average day-on-day % change per ward**: the change per ward and day, then its average per ward.

```json
{ "kind": "breakdown", "dimension": "ward", "measure": "dispatched", "time": { "last": "30d" },
  "compute": { "grain": "day", "steps": [{ "op": "change", "percent": true }, { "op": "over_time", "fn": "mean" }] } }
```

**Units dispatched as a share of units received**, per ward.

```json
{ "kind": "breakdown", "dimension": "ward", "measure": "dispatched",
  "compute": { "steps": [{ "op": "ratio", "to": "received", "percent": true }] } }
```

The agent's tools take the same steps as one string, like filters: `compute: "pct_change, mean"` with
`grain: day`. They also accept `change`, `rolling_mean 7`, `rolling_sum 7`, `running_total`, `ratio received`, and
a closing `mean`, `sum`, `min`, `max`, `median` or `last`.

## How zeros and gaps are treated

These rules are the same on every source, and the answer says which ones applied (the `computed` text below).

- **Empty buckets.** The steps run over every bucket of the window, from the bucket holding its start to the bucket
  holding its end, in the pack's time zone. With no time range, from the first bucket the source answered to the
  last. A bucket with no records is **0 for a count, a sum or a distinct count** (nothing happened). For anything
  else (an average, a percentile, a ratio) it **has no value** and is skipped.
- **Zero or missing bases are skipped, never counted as 0 or as infinite.** A ratio whose divisor is 0 or missing has
  no value. A % change from 0 has no value. A change from or to a bucket with no value has no value.
- **The first bucket has no change**: there is no bucket before it in the window.
- **A rolling window is full or nothing.** The first `window - 1` buckets of the window are left out of the answer,
  and a window that contains a bucket with no value has no value.
- **A running total** starts at the first bucket shown; a bucket with no value adds nothing.
- **A summary skips buckets with no value.** A group with none has no value and sorts last.
- **Ratios and percentages are never added up.** `sum` over time, `rolling` sums and running totals are refused for
  a percentage, an average, a ratio, a % change, a rolling average or a running total. A distinct count is not
  added up either (one key seen on two days would count twice); use `mean`, or ask for the distinct count over the
  whole window without steps.
- **Relative change** is `(this - before) / |before|`, as the previous-period comparison already computes it.

## Size

The source is asked for the base grain: the measure per group and time bucket, for every group (not a top few),
at most 20,000 numbers. An answer that would be larger is refused with a way forward (a shorter time range, a
coarser grain, a filter), never computed from part of the data. A split series still shows its top 12 series,
ranked by the measure's total.

## In words

Every computed answer carries a name for its numbers and the rules it followed, in plain words:

```
label:    average day-on-day % change in units dispatched
computed: average day-on-day % change in units dispatched: a day with no records counts as 0; the first day has
          no day before it, so it has no change; a change from 0 has no percentage and is skipped; days without a
          value are skipped in the average
```

The chart and table use the label; the agent's `query` tool returns `computed`, and `explain` starts with it.

## Superset

In Superset mode a widget is saved as an ordinary Superset chart, and Superset redraws it from its own controls. So
a computed widget is saved with Superset's own **advanced analytics**, which Superset turns into its chart-data
post-processing (pandas `rolling`, `cum` and `compare`):

| step, on a series | Superset chart controls | Superset post-processing |
|---|---|---|
| `rolling` mean or sum, window `n` | `rolling_type`, `rolling_periods: n`, `min_periods: n` | `rolling` |
| `running_total` | `rolling_type: cumsum` | `cum` (sum) |
| `change`, difference or percent | `time_compare: ["1 day ago"]` (one grain back), `comparison_type` | `compare` |

Line, bar and area charts take all three; a KPI's big number with a trend line takes the first two. A change needs
a time range on the widget, as Superset's time comparison does. Lenspack reads such charts back as computed
widgets, including ones made in Superset when the controls say exactly one of these steps.

What Superset has no chart for is refused when the widget is added, with what to do instead: a summary of the
buckets per group (the burn rate per ward), a ratio of two metrics, or several steps. The chat still answers these:
through Superset, as through every source, the engine asks for the base rows and computes the steps itself.

Superset's arithmetic differs from Lenspack's at the edges, so the saved chart can differ from the chat's answer
in these places:

- Superset rolls over the buckets that have rows. A bucket with no rows at all is not counted, so on sparse data a
  7-day window can span more than 7 days.
- Superset's change reads the bucket before the window for the first bucket, so it shows one more point.
- A change from a bucket with no rows is skipped in both, but Superset does not draw the empty bucket itself.
- From a negative bucket, Superset divides the change by the value itself and Lenspack by its size. Counts and sums
  of quantities are rarely negative.
