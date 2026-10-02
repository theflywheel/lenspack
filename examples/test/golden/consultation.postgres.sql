-- params: ["dopt","2026-08-11T00:00:00.000Z","2026-09-01T00:00:00.000Z"]
SELECT date_trunc('day', "submissions"."__t") AS "bucket", "submissions"."__d_channel" AS "series", count(*) AS "value", count(*) AS "n"
FROM (SELECT *, "submitted_at" AS "__t", (channel) AS "__d_channel" FROM "submissions" WHERE ("tenant_id" = $1)) AS "submissions"
WHERE (("submissions"."__t" >= CAST($2 AS TIMESTAMP)) AND ("submissions"."__t" < CAST($3 AS TIMESTAMP)))
GROUP BY date_trunc('day', "submissions"."__t"), "submissions"."__d_channel"
ORDER BY "bucket" ASC NULLS LAST, "series" ASC NULLS LAST
LIMIT 5000;

-- params: ["dopt","dopt"]
SELECT "submissions"."__d_channel" AS "group", avg("wait_signal"."__m_wants_human_rate") AS "value", count(*) AS "n"
FROM (SELECT *, (wants_human::int) AS "__m_wants_human_rate" FROM "v_signal_wait" WHERE ("tenant_id" = $1)) AS "wait_signal"
LEFT JOIN (SELECT *, "submitted_at" AS "__t", (channel) AS "__d_channel" FROM "submissions" WHERE ("tenant_id" = $2)) AS "submissions" ON "wait_signal"."submission_id" = "submissions"."id"
GROUP BY "submissions"."__d_channel"
ORDER BY "value" DESC NULLS LAST, "group" ASC NULLS LAST
LIMIT 6;

-- params: ["dopt","dopt"]
SELECT "submissions"."__d_district" AS "group", avg("wait_signal"."__m_mean_wait_months") AS "value", count(*) AS "n"
FROM (SELECT *, (months_waiting) AS "__m_mean_wait_months" FROM "v_signal_wait" WHERE ("tenant_id" = $1)) AS "wait_signal"
LEFT JOIN (SELECT *, "submitted_at" AS "__t", ("metadata" ->> 'district') AS "__d_district" FROM "submissions" WHERE ("tenant_id" = $2)) AS "submissions" ON "wait_signal"."submission_id" = "submissions"."id"
GROUP BY "submissions"."__d_district"
ORDER BY "value" DESC NULLS LAST, "group" ASC NULLS LAST
LIMIT 12;

-- params: ["dopt"]
SELECT "submissions"."__d_age_band" AS "group", avg("theme_of"."__m_mean_severity") AS "value", count(*) AS "n"
FROM (SELECT *, (severity) AS "__m_mean_severity" FROM "v_submission_theme") AS "theme_of"
LEFT JOIN (SELECT *, "submitted_at" AS "__t", ("metadata" #>> ARRAY['respondent','age_band']) AS "__d_age_band" FROM "submissions" WHERE ("tenant_id" = $1)) AS "submissions" ON "theme_of"."submission_id" = "submissions"."id"
GROUP BY "submissions"."__d_age_band"
ORDER BY "value" DESC NULLS LAST, "group" ASC NULLS LAST
LIMIT 6;

-- params: ["dopt"]
SELECT "submissions"."__d_district" AS "group", count(*) AS "value", count(*) AS "n"
FROM (SELECT *, "submitted_at" AS "__t", ("metadata" ->> 'district') AS "__d_district" FROM "submissions" WHERE ("tenant_id" = $1)) AS "submissions"
GROUP BY "submissions"."__d_district"
ORDER BY "value" DESC NULLS LAST, "group" ASC NULLS LAST
LIMIT 12;

-- params: ["dopt"]
SELECT "submissions"."__d_language" AS "group", avg("submissions"."__m_flagged_rate") AS "value", count(*) AS "n"
FROM (SELECT *, "submitted_at" AS "__t", (language) AS "__d_language", ((moderation_status = 'flagged')::int) AS "__m_flagged_rate" FROM "submissions" WHERE ("tenant_id" = $1)) AS "submissions"
GROUP BY "submissions"."__d_language"
ORDER BY "value" DESC NULLS LAST, "group" ASC NULLS LAST
LIMIT 5;

-- params: ["dopt"]
SELECT avg("submissions"."__m_flagged_rate") AS "value", count(*) AS "n"
FROM (SELECT *, "submitted_at" AS "__t", ((moderation_status = 'flagged')::int) AS "__m_flagged_rate" FROM "submissions" WHERE ("tenant_id" = $1)) AS "submissions"
LIMIT 1;

-- params: ["dopt"]
SELECT avg("submissions"."__m_redaction_rate") AS "value", count(*) AS "n"
FROM (SELECT *, "submitted_at" AS "__t", (redacted::int) AS "__m_redaction_rate" FROM "submissions" WHERE ("tenant_id" = $1)) AS "submissions"
LIMIT 1;

-- params: ["dopt"]
SELECT count(*) AS "value", count(*) AS "n"
FROM (SELECT *, "submitted_at" AS "__t" FROM "submissions" WHERE ("tenant_id" = $1)) AS "submissions"
LIMIT 1;

-- params: []
SELECT "theme_of"."__d_theme" AS "group", avg("theme_of"."__m_priority") AS "value", count(*) AS "n"
FROM (SELECT *, (theme) AS "__d_theme", (severity * actionability) AS "__m_priority" FROM "v_submission_theme") AS "theme_of"
GROUP BY "theme_of"."__d_theme"
ORDER BY "value" DESC NULLS LAST, "group" ASC NULLS LAST
LIMIT 10;

-- params: []
SELECT "theme_of"."__d_theme" AS "group", count(*) AS "value", count(*) AS "n"
FROM (SELECT *, (theme) AS "__d_theme" FROM "v_submission_theme") AS "theme_of"
GROUP BY "theme_of"."__d_theme"
ORDER BY "value" DESC NULLS LAST, "group" ASC NULLS LAST
LIMIT 10;
