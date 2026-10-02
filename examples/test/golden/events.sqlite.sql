-- params: ["(internal)"]
SELECT "pageviews"."__d_referrer" AS "group", avg("pageviews"."__m_bounce_rate") AS "value", count(*) AS "n"
FROM (SELECT *, "ts" AS "__t", (referrer) AS "__d_referrer", (CASE WHEN bounced THEN 1 ELSE 0 END) AS "__m_bounce_rate" FROM "pageviews") AS "pageviews"
WHERE ("pageviews"."__d_referrer" <> ?)
GROUP BY "pageviews"."__d_referrer"
ORDER BY "value" DESC NULLS LAST, "group" ASC NULLS LAST
LIMIT 8;

-- params: ["(internal)"]
SELECT "pageviews"."__d_referrer" AS "group", count(DISTINCT "pageviews"."__m_sessions") AS "value", count(*) AS "n"
FROM (SELECT *, "ts" AS "__t", (referrer) AS "__d_referrer", (session_id) AS "__m_sessions" FROM "pageviews") AS "pageviews"
WHERE ("pageviews"."__d_referrer" <> ?)
GROUP BY "pageviews"."__d_referrer"
ORDER BY "value" DESC NULLS LAST, "group" ASC NULLS LAST
LIMIT 8;

-- params: ["2026-08-02 00:00:00","2026-09-01 00:00:00"]
SELECT strftime('%Y-%m-%d 00:00:00', "pageviews"."__t") AS "bucket", "pageviews"."__d_device" AS "series", count(DISTINCT "pageviews"."__m_sessions") AS "value", count(*) AS "n"
FROM (SELECT *, "ts" AS "__t", (device) AS "__d_device", (session_id) AS "__m_sessions" FROM "pageviews") AS "pageviews"
WHERE (("pageviews"."__t" >= CAST(? AS TEXT)) AND ("pageviews"."__t" < CAST(? AS TEXT)))
GROUP BY strftime('%Y-%m-%d 00:00:00', "pageviews"."__t"), "pageviews"."__d_device"
ORDER BY "bucket" ASC NULLS LAST, "series" ASC NULLS LAST
LIMIT 5000;

-- params: ["2026-08-25 00:00:00","2026-09-01 00:00:00","2026-08-25 00:00:00","2026-09-01 00:00:00","2026-08-18 00:00:00","2026-08-25 00:00:00","2026-08-18 00:00:00","2026-09-01 00:00:00"]
SELECT count(CASE WHEN (("pageviews"."__t" >= CAST(? AS TEXT)) AND ("pageviews"."__t" < CAST(? AS TEXT))) THEN 1 END) AS "value", count(CASE WHEN (("pageviews"."__t" >= CAST(? AS TEXT)) AND ("pageviews"."__t" < CAST(? AS TEXT))) THEN 1 END) AS "n", count(CASE WHEN (("pageviews"."__t" >= CAST(? AS TEXT)) AND ("pageviews"."__t" < CAST(? AS TEXT))) THEN 1 END) AS "previous"
FROM (SELECT *, "ts" AS "__t" FROM "pageviews") AS "pageviews"
WHERE ("pageviews"."__t" >= CAST(? AS TEXT)) AND ("pageviews"."__t" < CAST(? AS TEXT))
LIMIT 1;

-- params: ["2026-08-25 00:00:00","2026-09-01 00:00:00","2026-08-25 00:00:00","2026-09-01 00:00:00","2026-08-18 00:00:00","2026-08-25 00:00:00","2026-08-18 00:00:00","2026-09-01 00:00:00"]
SELECT count(DISTINCT CASE WHEN (("pageviews"."__t" >= CAST(? AS TEXT)) AND ("pageviews"."__t" < CAST(? AS TEXT))) THEN "pageviews"."__m_sessions" END) AS "value", count(CASE WHEN (("pageviews"."__t" >= CAST(? AS TEXT)) AND ("pageviews"."__t" < CAST(? AS TEXT))) THEN 1 END) AS "n", count(DISTINCT CASE WHEN (("pageviews"."__t" >= CAST(? AS TEXT)) AND ("pageviews"."__t" < CAST(? AS TEXT))) THEN "pageviews"."__m_sessions" END) AS "previous"
FROM (SELECT *, "ts" AS "__t", (session_id) AS "__m_sessions" FROM "pageviews") AS "pageviews"
WHERE ("pageviews"."__t" >= CAST(? AS TEXT)) AND ("pageviews"."__t" < CAST(? AS TEXT))
LIMIT 1;

-- params: ["2026-08-25 00:00:00","2026-09-01 00:00:00"]
SELECT (CAST(count(*) AS REAL) / NULLIF(CAST(count(DISTINCT "pageviews"."__m_sessions") AS REAL), 0)) AS "value", count(*) AS "n"
FROM (SELECT *, "ts" AS "__t", (session_id) AS "__m_sessions" FROM "pageviews") AS "pageviews"
WHERE (("pageviews"."__t" >= CAST(? AS TEXT)) AND ("pageviews"."__t" < CAST(? AS TEXT)))
LIMIT 1;

-- params: ["2026-08-25 00:00:00","2026-09-01 00:00:00"]
SELECT avg("pageviews"."__m_bounce_rate") AS "value", count(*) AS "n"
FROM (SELECT *, "ts" AS "__t", (CASE WHEN bounced THEN 1 ELSE 0 END) AS "__m_bounce_rate" FROM "pageviews") AS "pageviews"
WHERE (("pageviews"."__t" >= CAST(? AS TEXT)) AND ("pageviews"."__t" < CAST(? AS TEXT)))
LIMIT 1;

-- params: []
SELECT "pageviews"."__d_hour_of_day" AS "group", count(*) AS "value", count(*) AS "n"
FROM (SELECT *, "ts" AS "__t", (CAST(strftime('%H', ts) AS INTEGER)) AS "__d_hour_of_day" FROM "pageviews") AS "pageviews"
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
SELECT strftime('%Y-%m-%d 00:00:00', "pageviews"."__t", '-' || ((CAST(strftime('%w', "pageviews"."__t") AS INTEGER) + 6) % 7) || ' days') AS "bucket", count(DISTINCT "pageviews"."__m_users") AS "value", count(*) AS "n"
FROM (SELECT *, "ts" AS "__t", (user_id) AS "__m_users" FROM "pageviews") AS "pageviews"
GROUP BY strftime('%Y-%m-%d 00:00:00', "pageviews"."__t", '-' || ((CAST(strftime('%w', "pageviews"."__t") AS INTEGER) + 6) % 7) || ' days')
ORDER BY "bucket" ASC NULLS LAST
LIMIT 5000;
