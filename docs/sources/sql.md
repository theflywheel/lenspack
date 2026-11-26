# SQL databases

This page covers SQL databases as Lenspack sources: connection URLs, the drivers that ship, how each keeps
queries read-only, what each database can compute, and the differences worth knowing. It is for whoever connects
Lenspack to a database.

A SQL source is a connection URL. Its scheme picks a **driver**, and the driver is the only thing in Lenspack that talks
to the database. Everything it is ever sent is SQL text and bound parameters: no client-side query builder, no ORM, no
second path for "special" queries. The same idea Metabase uses, for the same reason: one place per database to get
right, and one test that says whether it is right.

```yaml
# lenspack.yaml
sources:
  shop:    { url: env:DATABASE_URL }                 # postgres://, mysql://, clickhouse://, …
  local:   { url: "duckdb:./data/shop.duckdb" }      # relative to this file
  archive: { url: "sqlite:///srv/archive.db", timeoutMs: 30000, maxRows: 50000 }
  search:  { kind: elasticsearch, url: env:ES_URL }  # not a driver; see Elasticsearch
```

Each SQL source also takes `timeoutMs` (the time limit for one query, 15 seconds by default), `maxRows` (the row cap;
see [below](#the-guards-belong-to-the-driver)) and `cacheTtlMs` (keep each distinct query's rows this long and answer a
repeat from memory; off by default).

`kind:` may still be written next to a URL and must then agree with it. The older `{ kind: duckdb, path: … }` form still
works.

A DuckDB or SQLite source with `optional: true` whose file is not there is skipped with a warning, and so is every pack
on it. Without it, a missing file stops the server.

## The drivers Lenspack ships

| driver | URL | client library (an optional peer dependency) |
|---|---|---|
| `postgres` | `postgres://user:pass@host:5432/db`, `postgresql://…` | `pg` |
| `duckdb` | `duckdb:///abs/file.duckdb`, `duckdb:./rel.duckdb`, `duckdb::memory:` | `@duckdb/node-api` |
| `sqlite` | `sqlite:///abs/file.db`, `sqlite:./rel.db` | `better-sqlite3` |
| `mysql` | `mysql://user:pass@host:3306/db`; MariaDB as `mysql://` or `mariadb://` | `mysql2` |
| `clickhouse` | `clickhouse://user:pass@host:8123/db`, `?secure=true` for HTTPS (port 8443) | none: its HTTP interface over `fetch` |

A driver loads its client only when a URL asks for it, so an install needs only the clients it uses.

## The dialect

`DialectRules` is the whole of what differs between databases. The printer never branches on a dialect name; it asks the
rules.

| rule | what it answers |
|---|---|
| `quote(id)` | identifier quoting: `"x"`, `` `x` `` |
| `param(i, value)` / `paramValue(v)` | the placeholder (`$1`, `?`, `{p1:String}`) and how a value is bound |
| `cast(to)` | type names for double, text, timestamp, date, int, bigint |
| `trunc(grain, x)` | the start of an hour, day, week (Monday), month, quarter or year |
| `zonedTrunc(grain, x, zone)` | the same start in the pack's `timeZone`, as a naive local time; leave it out (and say `zonedBuckets: false`) when the database cannot, and a zoned series is refused |
| `epoch(x, unit)` | a number of seconds or milliseconds since 1970 as a UTC timestamp |
| `json(col, path)` | a JSON path as text |
| `segment(x, values)` | "one of these is a whole `\|`-separated segment of x" |
| `percentile(fn, x)` | exact median, p90 and p95; leave it out when the database has none |
| `ops` | operators spelled differently: `ILIKE`, `LIKE` (and its escape), `IS DISTINCT FROM` |
| `aggregate` | an aggregate that needs help to return the same number (MySQL's `AVG`) |
| `orderBy(x, dir)` | one ORDER BY term with NULLs last |
| `capabilities` | what resolution refuses up front, e.g. `{ percentiles: false }` |

Time windows (`last: "30d"`, previous periods) are resolved in JavaScript and bound as parameters, so no dialect needs
`now()` or interval arithmetic. `LIMIT n` is the same everywhere.

## The guards belong to the driver

The caller (the engine, `run_sql`, a tool) never sets them and cannot remove them.

| | read-only | one statement | timeout | row cap |
|---|---|---|---|---|
| Postgres | `BEGIN TRANSACTION READ ONLY` per query | the extended protocol, always, so `…; COMMIT; …` is an error even without parameters | `SET LOCAL statement_timeout` | refused over `maxRows` |
| DuckDB | a source file is opened `READ_ONLY` with external access off and its settings locked; every statement must prepare as a `SELECT` | the text must hold exactly one statement | `interrupt()` on a timer | refused over `maxRows` |
| SQLite | the file is opened read-only; every statement must be one SQLite marks read-only | a second statement is a prepare error | the connection lives in a worker thread, which is ended on a timer (a fresh one serves the next query) | rows stream and stop past `maxRows` |
| MySQL / MariaDB | `SET SESSION TRANSACTION READ ONLY`, then `START TRANSACTION READ ONLY` per query (DDL is refused too) | prepared statements hold one statement | `max_execution_time` (MySQL) or `max_statement_time` (MariaDB), and a client timer | refused over `maxRows` |
| ClickHouse | `readonly=2` on every request | the HTTP interface takes one | `max_execution_time`, and a client timer | `max_result_rows` with `result_overflow_mode=throw` |

A result over the cap is an error, never a shorter answer: a cut-off list reads as a whole one. The default cap is
100,000 rows, above anything a compiled query asks for; `maxRows` on a source changes it. `run_sql` keeps its own rules
on top (one `SELECT` or `WITH`, wrapped in `LIMIT n`).

These guards are a second line. The first is a database role that can only read what Lenspack should see; give every
source one.

## Capability matrix

| | Postgres | DuckDB | SQLite | MySQL / MariaDB | ClickHouse |
|---|---|---|---|---|---|
| joins (many-to-one, fan-out refused) | yes | yes | yes | yes | yes, with `join_use_nulls=1` |
| `count_distinct` | exact | exact | exact | exact | exact (`uniqExact`) |
| `median`, `p90`, `p95` | `percentile_cont` | `quantile_cont` | **refused** (`NOT_SUPPORTED`) | **refused** (`NOT_SUPPORTED`) | `quantileExactInclusive` (same interpolation) |
| time buckets hour to year, Monday weeks | `date_trunc` | `date_trunc` | `strftime` on ISO text | `DATE_FORMAT`, `WEEKDAY` | `toStartOf…`, `toMonday` |
| buckets in a pack `timeZone` | `AT TIME ZONE` | `AT TIME ZONE` (ICU) | **refused** (`NOT_SUPPORTED`) | **refused** (`NOT_SUPPORTED`) | `toStartOf…(x, zone)` |
| a calendar-date time (`type: date`) in any `timeZone` | the dates as they are | the dates as they are | the dates as they are | the dates as they are | the dates as they are |
| epoch-second and -millisecond times | `to_timestamp` | `epoch_ms` | `strftime(…, 'unixepoch')` | `TIMESTAMPADD` from 1970 (no session time zone) | `fromUnixTimestamp64Milli` |
| JSON paths | `->>`, `#>>` | `json_extract_string` | `json_extract` | `JSON_UNQUOTE(JSON_EXTRACT())` | `JSONExtract(…, 'Nullable(String)')` |
| parameters | `$1` | `$1` | `?` | `?` (server-side prepared) | `{p1:Type}` |
| NULLs last | `NULLS LAST` | `NULLS LAST` | `NULLS LAST` | `x IS NULL, x` | `NULLS LAST` |
| `contains` | `ILIKE` | `ILIKE … ESCAPE` | `LOWER() LIKE LOWER() ESCAPE` | `LOWER() LIKE LOWER()` | `ILIKE` |
| `lenspack sources` row counts | planner estimate (`reltuples`) | `estimated_size` | `count(*)` | `information_schema.tables` estimate | `system.tables.total_rows` |

A refused percentile is refused when the board is edited (`checkOps`) and when it is drawn, with the measure's name. It
is never replaced by something that would print a different number under the same label.

### Differences you should know about

- **MySQL and MariaDB compare and group text by the column's collation.** Under the default case-insensitive collations
  `Red` and `red` are one group and an `eq` filter matches both, tenant columns included; Postgres, DuckDB, SQLite and
  ClickHouse keep them apart. Give such columns a binary collation (`utf8mb4_bin`) when the difference matters. The
  conformance data has no such pairs; the driver suite seeds `utf8mb4_bin` columns and shows the folding separately.
- **MySQL's `AVG` of an exact value is a DECIMAL** rounded to four more places than its input, so a rate would come back
  as 0.0713. The dialect averages a double instead. A fragment that divides by a decimal literal (`/ 3600.0`) is a
  DECIMAL too; divide by a float literal (`/ 3.6e9`) when the digits matter.
- **SQLite keeps time as ISO text.** Buckets are text in the same form and compare in the same order the instants do.
  Its `LIKE` and `lower()` fold ASCII case only.
- **ClickHouse** is sent the settings that make it answer as the others do: an outer join's missing side is NULL
  (`join_use_nulls`), an aggregate over no rows is NULL (`aggregate_functions_null_for_empty`), a cast keeps NULL
  (`cast_keep_nullable`), and times are UTC. Columns should be `Nullable` where the data has gaps. It has no correlated
  subqueries, so a fragment that uses one needs a `clickhouse:` entry.

## Pack fragments

A `sql:` or `filter:` fragment is inlined verbatim, so it must be **portable or per-dialect**. Prefer the portable form:
`CASE WHEN status = 'refunded' THEN 1 ELSE 0 END` runs everywhere, where `(status = 'refunded')::int` runs on Postgres
and DuckDB only. When databases genuinely differ, give each its own entry; `default` serves the rest:

```yaml
sql: { default: "EXTRACT(EPOCH FROM (resolved_at - created_at)) / 3600.0",
       mysql: "TIMESTAMPDIFF(MICROSECOND, created_at, resolved_at) / 3.6e9",
       sqlite: "(unixepoch(resolved_at) - unixepoch(created_at)) / 3600.0",
       clickhouse: "dateDiff('millisecond', created_at, resolved_at) / 3600000.0" }
```

A YAML anchor writes one such map once and reuses it (`examples/hcm/pack.yaml` does this for its epoch times). A pack
with no entry for a dialect refuses the query on that source with `NOT_SUPPORTED`, naming the fragment. Dimensions and
measures written with `field:` and `where:` need no fragment at all and run on every driver and on Elasticsearch.

## ClickHouse

A few more things to know when the source is ClickHouse:

- It is reached over its HTTP interface (port 8123, or 8443 with `?secure=true`); no client library is needed.
- Columns should be `Nullable` where the data has gaps, so a missing value is NULL as on other databases.
- It has no correlated subqueries, so a pack fragment that uses one needs a `clickhouse:` entry.
- **Through Superset 6.1**, a saved metric named like the column it adds up can break other metrics in the same chart.
  The Superset plugin fixes this; see [Superset
  versions](../hosts/superset/versions.md#clickhouse-column-names-on-superset-61). Through Superset, a heatmap over
  weeks or months is refused on ClickHouse; see [Datasets and
  dashboards](../hosts/superset/datasets-and-dashboards.md#heatmaps).

## Adding a database

A new database is one driver: its dialect rules, its connection and its guards, registered with `registerDriver()`,
and the test suites that prove it. Nothing under `packages/` changes. See
[Write a source](../extending/write-a-source.md#a-new-sql-database).

---

**Next:** [Elasticsearch](elasticsearch.md).

**Related:** [Sources](../concepts/sources.md) · [The life of a query](../architecture/life-of-a-query.md) ·
[Why the model cannot break things](../architecture/safety.md)
