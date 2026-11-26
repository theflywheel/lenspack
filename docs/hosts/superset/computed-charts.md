# Computed charts in Superset

This page explains how a widget with compute steps (a rolling average, a running total, a change, a summary per
group) is saved as an ordinary Superset chart, when Lenspack refuses to save one, and where Superset's arithmetic
differs from Lenspack's. It is for Superset admins and anyone comparing a chart with a chat answer. The steps
themselves are in [The compute step](../../features/compute.md).

A widget is saved as an ordinary Superset chart, and Superset redraws it from its own controls. So
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
region (the average daily units dispatched) is one: a region's day with nothing dispatched is 0 for Lenspack and no cell
for the pivot table, so Superset's average would be higher wherever a region had such a day. Superset keeps exactly the
total per region with a column per day (`sum`), or the daily units dispatched by region as a line chart.

**Read back.** Lenspack reads these charts back as computed widgets, including ones made in Superset when the
controls say exactly one of these steps: a time chart with one of the advanced analytics above, or a pivot table
with one pack dimension as its rows, the time column at a grain as its columns, one saved metric, row totals on,
and an aggregation function that agrees with Lenspack for that metric.

**Refused**, with what to do instead: a summary whose pivot table total would differ (above), a summary with a step
before it (an average day-on-day change per region: Superset keeps the change by region as a line chart), `last`
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
- A group whose every cell is empty (a region that dispatched nothing in the window) is listed by Lenspack, with 0 or
  no value, and left out of Superset's pivot table.

---

**Next:** [Who is asking](identity.md).

**Related:** [The compute step](../../features/compute.md) · [Datasets and dashboards](datasets-and-dashboards.md)
