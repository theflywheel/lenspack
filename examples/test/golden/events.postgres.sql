-- params: ["(internal)"]
SELECT "pageviews"."__d_referrer" AS "group", avg("pageviews"."__m_bounce_rate") AS "value", count(*) AS "n"
FROM (SELECT *, "ts" AS "__t", (referrer) AS "__d_referrer", (bounced::int) AS "__m_bounce_rate" FROM "pageviews") AS "pageviews"
WHERE ("pageviews"."__d_referrer" <> $1)
GROUP BY "pageviews"."__d_referrer"
ORDER BY "value" DESC NULLS LAST, "group" ASC NULLS LAST
LIMIT 8;

-- params: ["(internal)"]
SELECT "pageviews"."__d_referrer" AS "group", count(DISTINCT "pageviews"."__m_sessions") AS "value", count(*) AS "n"
FROM (SELECT *, "ts" AS "__t", (referrer) AS "__d_referrer", (session_id) AS "__m_sessions" FROM "pageviews") AS "pageviews"
WHERE ("pageviews"."__d_referrer" <> $1)
GROUP BY "pageviews"."__d_referrer"
ORDER BY "value" DESC NULLS LAST, "group" ASC NULLS LAST
LIMIT 8;

-- params: ["2026-08-02T00:00:00.000Z","2026-09-01T00:00:00.000Z"]
SELECT date_trunc('day', "pageviews"."__t") AS "bucket", "pageviews"."__d_device" AS "series", count(DISTINCT "pageviews"."__m_sessions") AS "value", count(*) AS "n"
FROM (SELECT *, "ts" AS "__t", (device) AS "__d_device", (session_id) AS "__m_sessions" FROM "pageviews") AS "pageviews"
WHERE (("pageviews"."__t" >= CAST($1 AS TIMESTAMP)) AND ("pageviews"."__t" < CAST($2 AS TIMESTAMP)))
GROUP BY date_trunc('day', "pageviews"."__t"), "pageviews"."__d_device"
ORDER BY "bucket" ASC NULLS LAST, "series" ASC NULLS LAST
LIMIT 5000;

-- params: ["2026-08-25T00:00:00.000Z","2026-09-01T00:00:00.000Z","2026-08-25T00:00:00.000Z","2026-09-01T00:00:00.000Z","2026-08-18T00:00:00.000Z","2026-08-25T00:00:00.000Z","2026-08-18T00:00:00.000Z","2026-09-01T00:00:00.000Z"]
SELECT count(CASE WHEN (("pageviews"."__t" >= CAST($1 AS TIMESTAMP)) AND ("pageviews"."__t" < CAST($2 AS TIMESTAMP))) THEN 1 END) AS "value", count(CASE WHEN (("pageviews"."__t" >= CAST($3 AS TIMESTAMP)) AND ("pageviews"."__t" < CAST($4 AS TIMESTAMP))) THEN 1 END) AS "n", count(CASE WHEN (("pageviews"."__t" >= CAST($5 AS TIMESTAMP)) AND ("pageviews"."__t" < CAST($6 AS TIMESTAMP))) THEN 1 END) AS "previous"
FROM (SELECT *, "ts" AS "__t" FROM "pageviews") AS "pageviews"
WHERE ("pageviews"."__t" >= CAST($7 AS TIMESTAMP)) AND ("pageviews"."__t" < CAST($8 AS TIMESTAMP))
LIMIT 1;

-- params: ["2026-08-25T00:00:00.000Z","2026-09-01T00:00:00.000Z","2026-08-25T00:00:00.000Z","2026-09-01T00:00:00.000Z","2026-08-18T00:00:00.000Z","2026-08-25T00:00:00.000Z","2026-08-18T00:00:00.000Z","2026-09-01T00:00:00.000Z"]
SELECT count(DISTINCT CASE WHEN (("pageviews"."__t" >= CAST($1 AS TIMESTAMP)) AND ("pageviews"."__t" < CAST($2 AS TIMESTAMP))) THEN "pageviews"."__m_sessions" END) AS "value", count(CASE WHEN (("pageviews"."__t" >= CAST($3 AS TIMESTAMP)) AND ("pageviews"."__t" < CAST($4 AS TIMESTAMP))) THEN 1 END) AS "n", count(DISTINCT CASE WHEN (("pageviews"."__t" >= CAST($5 AS TIMESTAMP)) AND ("pageviews"."__t" < CAST($6 AS TIMESTAMP))) THEN "pageviews"."__m_sessions" END) AS "previous"
FROM (SELECT *, "ts" AS "__t", (session_id) AS "__m_sessions" FROM "pageviews") AS "pageviews"
WHERE ("pageviews"."__t" >= CAST($7 AS TIMESTAMP)) AND ("pageviews"."__t" < CAST($8 AS TIMESTAMP))
LIMIT 1;

-- params: ["2026-08-25T00:00:00.000Z","2026-09-01T00:00:00.000Z"]
SELECT (CAST(count(*) AS DOUBLE PRECISION) / NULLIF(CAST(count(DISTINCT "pageviews"."__m_sessions") AS DOUBLE PRECISION), 0)) AS "value", count(*) AS "n"
FROM (SELECT *, "ts" AS "__t", (session_id) AS "__m_sessions" FROM "pageviews") AS "pageviews"
WHERE (("pageviews"."__t" >= CAST($1 AS TIMESTAMP)) AND ("pageviews"."__t" < CAST($2 AS TIMESTAMP)))
LIMIT 1;

-- params: ["2026-08-25T00:00:00.000Z","2026-09-01T00:00:00.000Z"]
SELECT avg("pageviews"."__m_bounce_rate") AS "value", count(*) AS "n"
FROM (SELECT *, "ts" AS "__t", (bounced::int) AS "__m_bounce_rate" FROM "pageviews") AS "pageviews"
WHERE (("pageviews"."__t" >= CAST($1 AS TIMESTAMP)) AND ("pageviews"."__t" < CAST($2 AS TIMESTAMP)))
LIMIT 1;

-- params: []
SELECT "pageviews"."__d_hour_of_day" AS "group", count(*) AS "value", count(*) AS "n"
FROM (SELECT *, "ts" AS "__t", (EXTRACT(HOUR FROM ts)::int) AS "__d_hour_of_day" FROM "pageviews") AS "pageviews"
GROUP BY "pageviews"."__d_hour_of_day"
ORDER BY "value" ASC NULLS LAST, "group" ASC NULLS LAST
LIMIT 24;

-- params: []
SELECT "pageviews"."__d_path" AS "group", count(*) AS "value", count(*) AS "n"
FROM (SELECT *, "ts" AS "__t", (path) AS "__d_path" FROM "pageviews") AS "pageviews"
GROUP BY "pageviews"."__d_path"
ORDER BY "value" DESC NULLS LAST, "group" ASC NULLS LAST
LIMIT 10;

-- params: []
SELECT date_trunc('week', "pageviews"."__t") AS "bucket", count(DISTINCT "pageviews"."__m_users") AS "value", count(*) AS "n"
FROM (SELECT *, "ts" AS "__t", (user_id) AS "__m_users" FROM "pageviews") AS "pageviews"
GROUP BY date_trunc('week', "pageviews"."__t")
ORDER BY "bucket" ASC NULLS LAST
LIMIT 5000;
