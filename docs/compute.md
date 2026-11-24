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
- **A ratio is taken wherever either measure has rows.** A group or bucket where the divisor has rows and the
  numerator has none is 0 for a count or a sum (nothing happened), and has no value for anything else.
- **Zero or missing bases are skipped, never counted as 0 or as infinite.** A ratio whose divisor is 0 or missing has
  no value. A % change from 0 has no value. A change from or to a bucket with no value has no value.
- **The first bucket changes from the bucket before the time range.** The source is asked for that one bucket
  too; it is read only for this change, and is not shown or counted. With no time range there is no bucket before
  the first, so the first bucket has no change.
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

## In words

Every computed answer carries a name for its numbers and the rules it followed, in plain words:

```
label:    average day-on-day % change in units dispatched
computed: average day-on-day % change in units dispatched: a day with no records counts as 0; the first day
          changes from the day before the time range; a change from 0 has no percentage and is skipped; days
          without a value are skipped in the average
```

The chart and table use the label; the agent's `query` tool returns `computed`, and `explain` starts with it.

## Superset

In Superset mode a widget is saved as an ordinary Superset chart, and Superset redraws it from its own controls. So
a computed widget is saved with controls Superset already has, and Superset does the arithmetic itself.

**A step over time on a series** is saved with the **advanced analytics** of Superset's line, bar and area charts,
which Superset turns into its chart-data post-processing (pandas `rolling`, `cum` and `compare`):

| step, on a series | Superset chart controls | Superset post-processing |
|---|---|---|
| `rolling` mean or sum, window `n` | `rolling_type`, `rolling_periods: n`, `min_periods: n` | `rolling` |
| `running_total` | `rolling_type: cumsum` | `cum` (sum) |
| `change`, difference or percent | `time_compare: ["1 day ago"]` (one grain back), `comparison_type` | `compare` |

Line, bar and area charts take all three; a KPI's big number with a trend line takes the first two. A change needs
a time range on the widget, as Superset's time comparison does.

**A summary of each group's buckets** (a breakdown whose one step is `over_time`) is saved as Superset's **pivot
table**: a row per group, a column per bucket at the grain, the measure in the cells, and the summary in each row's
total. The pivot table's aggregation function computes that total from the row's cells, in the browser:

| `over_time` | pivot table `aggregateFunction` |
|---|---|
| `mean` | `Average` |
| `median` | `Median` |
| `min` | `Minimum` |
| `max` | `Maximum` |
| `sum` | `Sum` |

The rows are sorted by their total (or by name, if the widget sorts by group), and the cells are shaded by value, so
the table also reads as a heatmap of the groups over time. A table or a bar chart widget is saved this way.

The pivot table has a cell only for a group and bucket that has records. So it summarises the buckets that have
records, where Lenspack counts a bucket with no records as 0 for a count or a sum. The two agree exactly, and the
summary is saved, when that 0 cannot change the answer:

- for an average, a percentile or a percentage: a bucket with no records has no value in both, and is skipped;
- for `sum` of a count or a sum: adding 0 changes nothing;
- for `max` of a count or a distinct count: a bucket with records counts at least 1, more than 0.

Otherwise it is refused when the widget is added, with the nearest chart Superset keeps exactly. The burn rate per
ward (the average daily units dispatched) is one: a ward's day with nothing dispatched is 0 for Lenspack and no cell
for the pivot table, so Superset's average would be higher wherever a ward had such a day. Superset keeps exactly the
total per ward with a column per day (`sum`), or the daily units dispatched by ward as a line chart.

**Read back.** Lenspack reads these charts back as computed widgets, including ones made in Superset when the
controls say exactly one of these steps: a time chart with one of the advanced analytics above, or a pivot table
with one pack dimension as its rows, the time column at a grain as its columns, one saved metric, row totals on,
and an aggregation function that agrees with Lenspack for that metric.

**Refused**, with what to do instead: a summary whose pivot table total would differ (above), a summary with a step
before it (an average day-on-day change per ward: Superset keeps the change by ward as a line chart), `last`
(the pivot table's "Last" is the largest value, not the latest bucket), a summary as one number (ask it per group),
a ratio of two metrics, and several steps on a series. The chat still answers all of these: through Superset, as
through every source, the engine asks for the base rows and computes the steps itself.

Superset's arithmetic differs from Lenspack's in a few other places, so a saved chart can differ from the chat's
answer there:

- Superset rolls over the buckets that have rows. A bucket with no rows at all is not counted, so on sparse data a
  7-day window can span more than 7 days.
- For a count or a sum, a bucket with no rows is 0 for Lenspack, so it has a change, and the next bucket changes
  from 0. Superset draws no point for that bucket, and the next bucket has no change. A % change from 0 has no
  value in both.
- When the time range ends now (the last 30 days, this month so far), Superset compares the last, unfinished bucket
  with the same part of the bucket before it; Lenspack compares it with the whole bucket before.
- From a negative bucket, Superset divides the change by the value itself and Lenspack by its size. Counts and sums
  of quantities are rarely negative.
- A group whose every cell is empty (a ward that dispatched nothing in the window) is listed by Lenspack, with 0 or
  no value, and left out of Superset's pivot table.
