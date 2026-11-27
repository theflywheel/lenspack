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

Other databases have the same ideas under other names: PostgreSQL's `statement_timeout` and `work_mem` on the role,
MySQL's `max_execution_time`, BigQuery's maximum bytes billed. In Superset itself, set `SQLLAB_TIMEOUT`,
`SUPERSET_WEBSERVER_TIMEOUT` and `ROW_LIMIT` in `superset_config.py`.

---

**Next:** [Costs and budgets](costs.md).

**Related:** [Configuration reference](../reference/config.md#supersetyaml) · [Refusal codes](../reference/errors.md) ·
[Busy hours](../features/busy-hours.md)
