# Query safety

This page explains how Lenspack keeps the queries it sends from overloading the database, which limits are on by
default, and how to change them. It is for operators of a Superset deployment.

The model never writes SQL. It asks for a value, a breakdown, a series, a list or a map, and Lenspack turns that into
a Superset chart-data query. Even so, some questions cost far more than others:

- a breakdown by a column with a different value for every record (an id, a phone number) makes the database build
  one group per record;
- an hourly series over a year draws 8,760 points;
- a question with no time range, on a table with one row per visit, reads every visit ever made;
- one question can turn into many queries (several measures, each compared with the previous period).

Lenspack checks every query against the limits below **before it is sent**. A query past a limit is refused with a
plain message the assistant passes on or acts on, for example "Use a coarser grain (day instead of hour) or a shorter
time range". Nothing reaches the database.

These limits are the first line of defence. The guarantee is the database user Superset reads with: give it its own
limits too (see [Limits on the database side](#limits-on-the-database-side)).

## What Lenspack can send

Every question becomes one or more of these query shapes. There is no other way for the assistant to reach the
database.

| shape | what the database does | already bounded by | checked by the limits | the risk left |
|---|---|---|---|---|
| a value (one number) | one aggregate over the rows in range | one row back | time range rules on heavy datasets | a full scan when no time range narrows it |
| a value compared with the previous period, or a ratio of two measures | the same, two or three times | one row each | the same, and `maxQueriesPerTurn` | as above, times the number of queries |
| a breakdown (top N by one dimension) | GROUP BY one column, sorted, top N | N at most 500 | `highCardinality`, `maxGroups`, time range rules | grouping by a column with a value per record builds one group per record before the top N is kept |
| a breakdown split by a second dimension | GROUP BY two columns | 10,000 rows | `maxRows`, `maxGroups` (the product), `highCardinality` | groups multiply |
| a series (over time, optionally one line per group) | GROUP BY a time bucket (and a column) | 20,000 rows | `maxSeriesPoints` (range ÷ grain × series), `maxWindowDays`, `highCardinality` | an hourly series over years |
| a computed answer (a change, a rolling mean, a running total, a total over time) | a series or breakdown underneath, computed by Lenspack | 20,000 rows | the same as its base query | as its base query |
| a list of rows | raw rows, filtered and sorted, with an offset | 1,000 rows, offset at most 10,000 | `maxRows`, time range rules | sorting a large table to page through it |
| a map | points or counts per area | 5,000 points | `maxRows`, time range rules | as a list |
| a board load, a dashboard filter's options | the same shapes, one per chart | as above | the same limits, and `maxConcurrent` | many charts at once on a busy morning |

The chat's tools and a board's charts go through the same check, so a limit applies to both.

## The limits

| limit | default | what it does |
|---|---|---|
| `maxRows` | 20,000 | the most rows one query returns. A series or a split breakdown is cut to it, and the answer says it was cut. A list, a map or a top N that asks for more is refused |
| `maxGroups` | 100,000 | the most groups a breakdown may make (its groups times its split). Counted only for dimensions whose number of values you give in `cardinality` |
| `maxSeriesPoints` | 20,000 | the most points a series may draw: its time range divided by its grain, times the number of series when known |
| `maxWindowDays` | none | the longest time range one query may read, in days |
| `requireTime` | off | every question needs a time range (on a dataset that has a time column) |
| `defaultWindowDays` | none | with `requireTime`, a question with no time range reads this many days up to now, and says so, instead of being refused |
| `maxQueriesPerTurn` | 100 | the most queries one chat question may send. Past it, the assistant is told to answer with what it has |
| `timeoutSeconds` | 30 | how long Lenspack waits for one answer from Superset |
| `maxConcurrent` | 8 | queries this server sends to Superset at once, across all users. More wait their turn. Each copy of the server counts its own |

The defaults are on, and set so that no answer changes: the row and point limits equal the largest answers Lenspack
already asked for, and groups are only counted where you say how many values a dimension has.

Superset's chart-data API takes no timeout per query. `timeoutSeconds` is how long Lenspack waits; the query itself
stops at the database user's own time limit.

### Heavy datasets

Mark a large, row-level dataset (one row per visit, per record) `heavy: true`. A heavy dataset starts from stricter
limits:

| limit | heavy default |
|---|---|
| `requireTime` | on |
| `defaultWindowDays` | 90 |
| `maxWindowDays` | 400 |
| `maxRows` | 10,000 |
| `maxGroups` | 10,000 |
| `maxSeriesPoints` | 5,000 |

So a question with no time range reads the last 90 days, and the answer says so; a question over more than 400 days is
refused. Summary tables (one row per day per area) usually need no marking.

### Columns with a value per record

List such columns in `highCardinality` for their dataset. Grouping by one (a breakdown, a split, a series' `by`) is
refused, and the message suggests the next coarser level from the pack's hierarchies. Listing a row is still allowed.
To stop the column being offered at all, also list it in `overlay.notDimensions`.

## Setting the limits

In `superset.yaml`:

```yaml
querySafety:
  maxQueriesPerTurn: 60
  timeoutSeconds: 45
  heavy: { defaultWindowDays: 30 }       # what a heavy dataset starts from
  datasets:
    visits:                              # by table name, dataset id or entity key
      heavy: true
      highCardinality: [household_id]
      cardinality: { ward: 4000, facility: 600 }
      maxWindowDays: 180
```

The environment wins over the file: `LENSPACK_QUERY_MAX_ROWS`, `LENSPACK_QUERY_MAX_GROUPS`,
`LENSPACK_QUERY_MAX_SERIES_POINTS`, `LENSPACK_QUERY_MAX_WINDOW_DAYS` (`none` for no limit),
`LENSPACK_QUERY_MAX_PER_TURN`, `LENSPACK_QUERY_TIMEOUT_SECONDS`, `LENSPACK_QUERY_MAX_CONCURRENT`, and
`LENSPACK_HEAVY_DATASETS` (dataset names separated by commas). A value out of range stops the server at start, naming
the key. The start-up log has one `query safety:` line with what is in force.

## Changing them on a running server

Admins read the limits in `GET /_superset/settings` (the `querySafety` field: what is in force, each dataset's
limits, the deployment's own values, and what an admin changed) and change them with
`PUT /_superset/settings/query-safety`. With the password sign-in, the same routes are under `/_admin`.

```json
{ "maxQueriesPerTurn": 40, "datasets": { "visits": { "heavy": true } } }
```

- A field left out is kept. `null` puts back the deployment's value (for `maxWindowDays` and `defaultWindowDays`,
  `null` means "none" and `"default"` puts back the deployment's value). A dataset set to `null` drops the admin's
  changes for it.
- **Tighter is always allowed.** A change that would let more through than the deployment's own settings (the file
  and the environment) is refused with `409`, listing each limit it would loosen. Send the same change with
  `"confirm": true` to apply it anyway.
- Every change, refused or not, is in the audit log.

## Checking a pack before go-live

### Warnings about the pack

At start, and each time an admin changes the pack while it runs, Lenspack reads the pack against the limits and the
datasets' columns (no query is sent) and logs what looks risky:

- a dimension that reads like one value per record (an id, a phone number, a coordinate) that grouping is allowed on;
- a distinct count on a heavy dataset that no time range narrows;
- a dataset marked heavy that has no time column, so no time range can narrow it;
- a hierarchy that drills down to a column with a value per record;
- a dataset that looks like one row per record but is not marked heavy (a note, not a warning);
- an example question the limits would refuse, so its button would answer with a refusal;
- a dataset named in `querySafety.datasets` that the pack does not have.

They are in `GET /_superset/settings` too, as `querySafety.packRisks`. They change nothing; they say where to look.

### The dry run

The dry run tries every query shape the pack allows (each measure as one number, by each dimension, split by a second
one, over time at each grain, as a list and as a map), up to a cap. Each goes through the same limits as a live
question, and the ones that pass are sent to Superset's chart-data API with `result_type: "query"`, which turns the
query into SQL and returns the SQL **without running it**. Lenspack then reads the SQL for:

- no `LIMIT` (dangerous: the database would return every row);
- `GROUP BY` over a column listed in `highCardinality` (dangerous);
- no condition on the time column on a heavy dataset (dangerous: it reads every row);
- `GROUP BY` over four or more columns (a warning).

It also lists the shapes Lenspack's own limits refuse (a live question would be refused the same way), the shapes
Superset could not compile, and the warnings about the pack.

From a terminal, with the deployment's `superset.yaml` and the same environment as the server:

```sh
lenspack query-check --config superset.yaml            # a report; exit code 1 if anything is dangerous
lenspack query-check --config superset.yaml --cap 50   # fewer shapes
lenspack query-check --config superset.yaml --json     # the report as JSON
```

With no server access, an admin runs it on the running server:

```sh
curl -X POST -H "Authorization: Bearer $LENSPACK_ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"cap": 200}' https://<your Superset>/lenspack/_admin/settings/query-safety/dry-run
```

The route is `POST /_superset/settings/query-safety/dry-run` (or `/_admin/…` with the password sign-in or an admin
API key), admins only, audited as `query-safety dry run`. The answer is the report as JSON, with `text` holding the same
report as lines.

Superset compiles each query, which touches its own metadata database but not yours. Run the dry run after any change
to the pack, the datasets or the limits, and before go-live. Fix what is dangerous by marking the dataset heavy,
listing the column in `highCardinality` or `overlay.notDimensions`, or changing the dataset in Superset.

## Limits on the database side

Lenspack's checks cover the queries Lenspack sends. Superset's own charts, SQL Lab and anyone else using the same
database user are not covered. Ask the people running the database to limit Superset's reader user. For ClickHouse, in
the user's settings profile:

| setting | suggested start | why |
|---|---|---|
| `max_execution_time` | 60 | stops a query that runs too long |
| `max_memory_usage` | a few GB, well below the server's memory | stops a GROUP BY or a distinct count that would hold too much |
| `max_rows_to_read` | a little over the largest table a question should read in full | stops a full scan of a large table |
| `max_result_rows` with `result_overflow_mode = 'break'` | 100,000 | caps what any one query returns |
| `max_concurrent_queries_for_user` | 20 | caps how many queries the user runs at once |
| `readonly` | 1 (or 2 if Superset needs to set settings) | the user can only read |

For PostgreSQL, on the role:

```sql
ALTER ROLE superset_reader SET statement_timeout = '60s';
ALTER ROLE superset_reader SET work_mem = '64MB';
ALTER ROLE superset_reader SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE superset_reader CONNECTION LIMIT 20;
ALTER ROLE superset_reader SET default_transaction_read_only = on;
```

MySQL has `max_execution_time`; BigQuery has the maximum bytes billed per query. In Superset itself, set
`SQLLAB_TIMEOUT`, `SUPERSET_WEBSERVER_TIMEOUT` and `ROW_LIMIT` in `superset_config.py`, and give the database
connection a pool size close to `maxConcurrent` times the number of Lenspack copies.

A short checklist before go-live:

1. The database user Superset reads with has a time limit, a memory limit and a concurrency limit, and can only read.
2. Every large row-level dataset is marked `heavy: true`, and every column with a value per record is in
   `highCardinality` (or `overlay.notDimensions`).
3. The dry run reports nothing dangerous, and no warning about the pack is left unexplained.
4. Large tables have an index (or, in ClickHouse, an order key) starting with the time column, so a time range reads
   only its part.

---

**Next:** [Costs and budgets](costs.md).

**Related:** [Configuration reference](../reference/config.md#supersetyaml) · [Refusal codes](../reference/errors.md) ·
[Busy hours](../features/busy-hours.md)
