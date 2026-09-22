# events

Web analytics: one wide `pageviews` table (200k rows by default, `LENSPACK_EVENTS_ROWS` to change). Chosen to prove the time axis — every grain from hour to month, relative windows, previous-period comparison — plus `count_distinct` measures, a high-cardinality dimension (`path`), and a per-dialect fragment (`hour_of_day` uses `EXTRACT(HOUR …)` on Postgres and `hour()` on DuckDB).

Questions it answers: sessions and unique users over time; bounce rate by referrer; views per session (a derived measure); the daily cycle by hour.
