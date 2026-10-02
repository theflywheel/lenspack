-- params: ["2026-06-09 00:00:00","2026-09-01 00:00:00"]
SELECT strftime('%Y-%m-%d 00:00:00', "tickets"."__t", '-' || ((CAST(strftime('%w', "tickets"."__t") AS INTEGER) + 6) % 7) || ' days') AS "bucket", avg("tickets"."__m_sla_breach_rate") AS "value", count(*) AS "n"
FROM (SELECT *, "created_at" AS "__t", CASE WHEN (resolved_at IS NOT NULL) THEN (CASE WHEN (unixepoch(resolved_at) - unixepoch(created_at)) / 3600.0 > sla_hours THEN 1 ELSE 0 END) END AS "__m_sla_breach_rate" FROM "tickets") AS "tickets"
WHERE (("tickets"."__t" >= CAST(? AS TEXT)) AND ("tickets"."__t" < CAST(? AS TEXT)))
GROUP BY strftime('%Y-%m-%d 00:00:00', "tickets"."__t", '-' || ((CAST(strftime('%w', "tickets"."__t") AS INTEGER) + 6) % 7) || ' days')
ORDER BY "bucket" ASC NULLS LAST
LIMIT 5000;

-- params: ["2026-08-02 00:00:00","2026-09-01 00:00:00","2026-08-02 00:00:00","2026-09-01 00:00:00","2026-07-03 00:00:00","2026-08-02 00:00:00","2026-07-03 00:00:00","2026-09-01 00:00:00"]
SELECT avg(CASE WHEN (("tickets"."__t" >= CAST(? AS TEXT)) AND ("tickets"."__t" < CAST(? AS TEXT))) THEN "tickets"."__m_sla_breach_rate" END) AS "value", count(CASE WHEN (("tickets"."__t" >= CAST(? AS TEXT)) AND ("tickets"."__t" < CAST(? AS TEXT))) THEN 1 END) AS "n", avg(CASE WHEN (("tickets"."__t" >= CAST(? AS TEXT)) AND ("tickets"."__t" < CAST(? AS TEXT))) THEN "tickets"."__m_sla_breach_rate" END) AS "previous"
FROM (SELECT *, "created_at" AS "__t", CASE WHEN (resolved_at IS NOT NULL) THEN (CASE WHEN (unixepoch(resolved_at) - unixepoch(created_at)) / 3600.0 > sla_hours THEN 1 ELSE 0 END) END AS "__m_sla_breach_rate" FROM "tickets") AS "tickets"
WHERE ("tickets"."__t" >= CAST(? AS TEXT)) AND ("tickets"."__t" < CAST(? AS TEXT))
LIMIT 1;

-- params: ["p1"]
SELECT "tickets"."__d_team" AS "team", "tickets"."__d_status" AS "status", "tickets"."__d_channel" AS "channel"
FROM (SELECT *, "created_at" AS "__t", (priority) AS "__d_priority", (team) AS "__d_team", (status) AS "__d_status", (channel) AS "__d_channel" FROM "tickets") AS "tickets"
WHERE ("tickets"."__d_priority" = ?)
LIMIT 10;

-- params: []
SELECT "status_history"."__d_transition" AS "group", count(*) AS "value", count(*) AS "n"
FROM (SELECT *, "changed_at" AS "__t", (status) AS "__d_transition" FROM "status_history") AS "status_history"
GROUP BY "status_history"."__d_transition"
ORDER BY "value" DESC NULLS LAST, "group" ASC NULLS LAST
LIMIT 6;

-- params: []
SELECT "tickets"."__d_channel" AS "group", avg("tickets"."__m_mean_first_response_min") AS "value", count(*) AS "n"
FROM (SELECT *, "created_at" AS "__t", (channel) AS "__d_channel", (first_response_minutes) AS "__m_mean_first_response_min" FROM "tickets") AS "tickets"
GROUP BY "tickets"."__d_channel"
ORDER BY "value" DESC NULLS LAST, "group" ASC NULLS LAST
LIMIT 6;

-- params: []
SELECT "tickets"."__d_priority" AS "group", avg("tickets"."__m_sla_breach_rate") AS "value", count(*) AS "n"
FROM (SELECT *, "created_at" AS "__t", (priority) AS "__d_priority", CASE WHEN (resolved_at IS NOT NULL) THEN (CASE WHEN (unixepoch(resolved_at) - unixepoch(created_at)) / 3600.0 > sla_hours THEN 1 ELSE 0 END) END AS "__m_sla_breach_rate" FROM "tickets") AS "tickets"
GROUP BY "tickets"."__d_priority"
ORDER BY "value" ASC NULLS LAST, "group" ASC NULLS LAST
LIMIT 3;

-- params: []
SELECT (CAST(count("tickets"."__m_resolved") AS REAL) / NULLIF(CAST(count(*) AS REAL), 0)) AS "value", count(*) AS "n"
FROM (SELECT *, "created_at" AS "__t", CASE WHEN (status = 'resolved') THEN 1 END AS "__m_resolved" FROM "tickets") AS "tickets"
LIMIT 1;

-- params: []
SELECT count("tickets"."__m_open") AS "value", count(*) AS "n"
FROM (SELECT *, "created_at" AS "__t", CASE WHEN (status IN ('open', 'pending')) THEN 1 END AS "__m_open" FROM "tickets") AS "tickets"
LIMIT 1;

-- params: []
SELECT strftime('%Y-%m-%d 00:00:00', "tickets"."__t", '-' || ((CAST(strftime('%w', "tickets"."__t") AS INTEGER) + 6) % 7) || ' days') AS "bucket", "tickets"."__d_priority" AS "series", count(*) AS "value", count(*) AS "n"
FROM (SELECT *, "created_at" AS "__t", (priority) AS "__d_priority" FROM "tickets") AS "tickets"
GROUP BY strftime('%Y-%m-%d 00:00:00', "tickets"."__t", '-' || ((CAST(strftime('%w', "tickets"."__t") AS INTEGER) + 6) % 7) || ' days'), "tickets"."__d_priority"
ORDER BY "bucket" ASC NULLS LAST, "series" ASC NULLS LAST
LIMIT 5000;
