-- params: ["2026-08-02 00:00:00","2026-09-01 00:00:00","2026-08-02 00:00:00","2026-09-01 00:00:00","2026-07-03 00:00:00","2026-08-02 00:00:00","ng.state","2026-07-03 00:00:00","2026-09-01 00:00:00"]
SELECT count(CASE WHEN (("tasks"."__t" >= CAST(? AS TEXT)) AND ("tasks"."__t" < CAST(? AS TEXT))) THEN 1 END) AS "value", count(CASE WHEN (("tasks"."__t" >= CAST(? AS TEXT)) AND ("tasks"."__t" < CAST(? AS TEXT))) THEN 1 END) AS "n", count(CASE WHEN (("tasks"."__t" >= CAST(? AS TEXT)) AND ("tasks"."__t" < CAST(? AS TEXT))) THEN 1 END) AS "previous"
FROM (SELECT *, (strftime('%Y-%m-%d %H:%M:%f', createdtime / 1000.0, 'unixepoch')) AS "__t" FROM "project_task" WHERE ("tenantid" = ?) AND (isdeleted = false)) AS "tasks"
WHERE ("tasks"."__t" >= CAST(? AS TEXT)) AND ("tasks"."__t" < CAST(? AS TEXT))
LIMIT 1;

-- params: ["ng.state","ng.state"]
SELECT "addresses"."__d_locality" AS "group", avg("tasks"."__m_success_rate") AS "value", count(*) AS "n"
FROM (SELECT *, (strftime('%Y-%m-%d %H:%M:%f', createdtime / 1000.0, 'unixepoch')) AS "__t", (CASE WHEN status = 'ADMINISTRATION_SUCCESS' THEN 1 ELSE 0 END) AS "__m_success_rate" FROM "project_task" WHERE ("tenantid" = ?) AND (isdeleted = false)) AS "tasks"
LEFT JOIN (SELECT *, (localitycode) AS "__d_locality" FROM "address" WHERE ("tenantid" = ?)) AS "addresses" ON "tasks"."addressid" = "addresses"."id"
GROUP BY "addresses"."__d_locality"
ORDER BY "value" ASC NULLS LAST, "group" ASC NULLS LAST
LIMIT 12;

-- params: ["ng.state","ng.state"]
SELECT "addresses"."__d_locality" AS "group", count(*) AS "value", count(*) AS "n"
FROM (SELECT *, (strftime('%Y-%m-%d %H:%M:%f', createdtime / 1000.0, 'unixepoch')) AS "__t" FROM "household" WHERE ("tenantid" = ?) AND (isdeleted = false)) AS "households"
LEFT JOIN (SELECT *, (localitycode) AS "__d_locality" FROM "address" WHERE ("tenantid" = ?)) AS "addresses" ON "households"."addressid" = "addresses"."id"
GROUP BY "addresses"."__d_locality"
ORDER BY "value" DESC NULLS LAST, "group" ASC NULLS LAST
LIMIT 15;

-- params: ["ng.state","ng.state"]
SELECT strftime('%Y-%m-%d 00:00:00', "tasks"."__t", '-' || ((CAST(strftime('%w', "tasks"."__t") AS INTEGER) + 6) % 7) || ' days') AS "bucket", "projects"."__d_campaign" AS "series", count(*) AS "value", count(*) AS "n"
FROM (SELECT *, (strftime('%Y-%m-%d %H:%M:%f', createdtime / 1000.0, 'unixepoch')) AS "__t" FROM "project_task" WHERE ("tenantid" = ?) AND (isdeleted = false)) AS "tasks"
LEFT JOIN (SELECT *, (root) AS "__d_campaign" FROM "v_project" WHERE ("tenantid" = ?)) AS "projects" ON "tasks"."projectid" = "projects"."id"
GROUP BY strftime('%Y-%m-%d 00:00:00', "tasks"."__t", '-' || ((CAST(strftime('%w', "tasks"."__t") AS INTEGER) + 6) % 7) || ' days'), "projects"."__d_campaign"
ORDER BY "bucket" ASC NULLS LAST, "series" ASC NULLS LAST
LIMIT 5000;

-- params: ["ng.state"]
SELECT "households"."__d_household_type" AS "group", avg("households"."__m_household_size") AS "value", count(*) AS "n"
FROM (SELECT *, (strftime('%Y-%m-%d %H:%M:%f', createdtime / 1000.0, 'unixepoch')) AS "__t", (householdtype) AS "__d_household_type", (numberofmembers) AS "__m_household_size" FROM "household" WHERE ("tenantid" = ?) AND (isdeleted = false)) AS "households"
GROUP BY "households"."__d_household_type"
ORDER BY "value" DESC NULLS LAST, "group" ASC NULLS LAST
LIMIT 5;

-- params: ["ng.state"]
SELECT "individuals"."__d_age_band" AS "group", count(*) AS "value", count(*) AS "n"
FROM (SELECT *, (strftime('%Y-%m-%d %H:%M:%f', createdtime / 1000.0, 'unixepoch')) AS "__t", (CASE WHEN dateofbirth IS NULL THEN 'unknown' WHEN (julianday(date('now')) - julianday(dateofbirth)) / 365.25 < 5 THEN '0-4' WHEN (julianday(date('now')) - julianday(dateofbirth)) / 365.25 < 15 THEN '5-14' WHEN (julianday(date('now')) - julianday(dateofbirth)) / 365.25 < 50 THEN '15-49' ELSE '50+' END) AS "__d_age_band" FROM "individual" WHERE ("tenantid" = ?) AND (isdeleted = false)) AS "individuals"
GROUP BY "individuals"."__d_age_band"
ORDER BY "value" DESC NULLS LAST, "group" ASC NULLS LAST
LIMIT 6;

-- params: ["ng.state"]
SELECT "individuals"."__d_gender" AS "group", count(*) AS "value", count(*) AS "n"
FROM (SELECT *, (strftime('%Y-%m-%d %H:%M:%f', createdtime / 1000.0, 'unixepoch')) AS "__t", (gender) AS "__d_gender" FROM "individual" WHERE ("tenantid" = ?) AND (isdeleted = false)) AS "individuals"
GROUP BY "individuals"."__d_gender"
ORDER BY "value" DESC NULLS LAST, "group" ASC NULLS LAST
LIMIT 5;

-- params: ["ng.state"]
SELECT "referrals"."__d_recipient_type" AS "group", count(*) AS "value", count(*) AS "n"
FROM (SELECT *, (strftime('%Y-%m-%d %H:%M:%f', createdtime / 1000.0, 'unixepoch')) AS "__t", (recipienttype) AS "__d_recipient_type" FROM "referral" WHERE ("tenantid" = ?) AND (isdeleted = false)) AS "referrals"
GROUP BY "referrals"."__d_recipient_type"
ORDER BY "value" DESC NULLS LAST, "group" ASC NULLS LAST
LIMIT 5;

-- params: ["ng.state"]
SELECT "resources"."__d_non_delivery_reason" AS "group", count("resources"."__m_undelivered") AS "value", count(*) AS "n"
FROM (SELECT *, (strftime('%Y-%m-%d %H:%M:%f', createdtime / 1000.0, 'unixepoch')) AS "__t", (reasonifnotdelivered) AS "__d_non_delivery_reason", CASE WHEN (isdelivered = false) THEN 1 END AS "__m_undelivered" FROM "task_resource" WHERE ("tenantid" = ?) AND (isdeleted = false)) AS "resources"
GROUP BY "resources"."__d_non_delivery_reason"
ORDER BY "value" DESC NULLS LAST, "group" ASC NULLS LAST
LIMIT 6;

-- params: ["ng.state"]
SELECT "side_effects"."__d_symptom" AS "group", count(*) AS "value", count(*) AS "n"
FROM (SELECT *, (strftime('%Y-%m-%d %H:%M:%f', createdtime / 1000.0, 'unixepoch')) AS "__t", (json_extract(symptoms, '$[0]')) AS "__d_symptom" FROM "side_effect" WHERE ("tenantid" = ?) AND (isdeleted = false)) AS "side_effects"
GROUP BY "side_effects"."__d_symptom"
ORDER BY "value" DESC NULLS LAST, "group" ASC NULLS LAST
LIMIT 8;

-- params: ["ng.state"]
SELECT avg("resources"."__m_delivered_rate") AS "value", count(*) AS "n"
FROM (SELECT *, (strftime('%Y-%m-%d %H:%M:%f', createdtime / 1000.0, 'unixepoch')) AS "__t", (CASE WHEN isdelivered THEN 1 ELSE 0 END) AS "__m_delivered_rate" FROM "task_resource" WHERE ("tenantid" = ?) AND (isdeleted = false)) AS "resources"
LIMIT 1;

-- params: ["ng.state"]
SELECT avg("tasks"."__m_success_rate") AS "value", count(*) AS "n"
FROM (SELECT *, (strftime('%Y-%m-%d %H:%M:%f', createdtime / 1000.0, 'unixepoch')) AS "__t", (CASE WHEN status = 'ADMINISTRATION_SUCCESS' THEN 1 ELSE 0 END) AS "__m_success_rate" FROM "project_task" WHERE ("tenantid" = ?) AND (isdeleted = false)) AS "tasks"
LIMIT 1;

-- params: ["ng.state"]
SELECT count(*) AS "value", count(*) AS "n"
FROM (SELECT *, (strftime('%Y-%m-%d %H:%M:%f', createdtime / 1000.0, 'unixepoch')) AS "__t" FROM "household" WHERE ("tenantid" = ?) AND (isdeleted = false)) AS "households"
LIMIT 1;

-- params: ["ng.state"]
SELECT strftime('%Y-%m-%d 00:00:00', "households"."__t", '-' || ((CAST(strftime('%w', "households"."__t") AS INTEGER) + 6) % 7) || ' days') AS "bucket", count(*) AS "value", count(*) AS "n"
FROM (SELECT *, (strftime('%Y-%m-%d %H:%M:%f', createdtime / 1000.0, 'unixepoch')) AS "__t" FROM "household" WHERE ("tenantid" = ?) AND (isdeleted = false)) AS "households"
GROUP BY strftime('%Y-%m-%d 00:00:00', "households"."__t", '-' || ((CAST(strftime('%w', "households"."__t") AS INTEGER) + 6) % 7) || ' days')
ORDER BY "bucket" ASC NULLS LAST
LIMIT 5000;
