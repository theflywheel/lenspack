# tickets

A support desk: `tickets` and their `status_history`. Chosen to prove durations and state: median and P90 hours to resolve (`percentile_cont` on Postgres, `quantile_cont` on DuckDB — the printer's job), an SLA breach rate as a filtered rate, a resolution rate as a derived measure, and a status funnel read from the history table.

The join is declared in both directions: `tickets → status_history` is one-to-many, so "tickets by transition" is refused, while "transitions by team" is fine because `status_history → tickets` is many-to-one.
