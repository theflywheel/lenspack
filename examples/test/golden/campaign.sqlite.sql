-- params: ["HOUSEHOLD",0,""]
SELECT "task"."__d_not_delivered_reason" AS "group", count("task"."__m_households_not_delivered") AS "value", count(*) AS "n"
FROM (SELECT *, strftime('%Y-%m-%d %H:%M:%f', "Data.createdTime" / 1000.0, 'unixepoch') AS "__t", "Data.createdTime" AS "__t_raw", "Data.deliveryComments" AS "__d_not_delivered_reason", CASE WHEN (("Data.deliveredTo" = ?) AND ("Data.quantity" = ?)) THEN 1 END AS "__m_households_not_delivered" FROM "project-task-index-v1") AS "task"
WHERE ("task"."__d_not_delivered_reason" <> ?)
GROUP BY "task"."__d_not_delivered_reason"
ORDER BY "value" DESC NULLS LAST, "group" ASC NULLS LAST
LIMIT 6;

-- params: ["HOUSEHOLD",0]
SELECT "task"."__d_district" AS "group", count("task"."__m_households_delivered") AS "value", count(*) AS "n"
FROM (SELECT *, strftime('%Y-%m-%d %H:%M:%f', "Data.createdTime" / 1000.0, 'unixepoch') AS "__t", "Data.createdTime" AS "__t_raw", "Data.district" AS "__d_district", CASE WHEN (("Data.deliveredTo" = ?) AND ("Data.quantity" > ?)) THEN 1 END AS "__m_households_delivered" FROM "project-task-index-v1") AS "task"
GROUP BY "task"."__d_district"
ORDER BY "value" DESC NULLS LAST, "group" ASC NULLS LAST
LIMIT 10000;

-- params: ["HOUSEHOLD",0]
SELECT count("task"."__m_households_delivered") AS "value", count(*) AS "n"
FROM (SELECT *, strftime('%Y-%m-%d %H:%M:%f', "Data.createdTime" / 1000.0, 'unixepoch') AS "__t", "Data.createdTime" AS "__t_raw", CASE WHEN (("Data.deliveredTo" = ?) AND ("Data.quantity" > ?)) THEN 1 END AS "__m_households_delivered" FROM "project-task-index-v1") AS "task"
LIMIT 1;

-- params: ["HOUSEHOLD"]
SELECT "project"."__d_district" AS "group", sum("project"."__m_household_target_at_district") AS "value", count(*) AS "n"
FROM (SELECT *, strftime('%Y-%m-%d %H:%M:%f', "Data.startDate" / 1000.0, 'unixepoch') AS "__t", "Data.startDate" AS "__t_raw", "Data.district" AS "__d_district", CASE WHEN (("Data.targetType" = ?) AND ("Data.district" IS NOT NULL)) THEN "Data.overallTarget" END AS "__m_household_target_at_district" FROM "project-index-v1") AS "project"
GROUP BY "project"."__d_district"
ORDER BY "value" DESC NULLS LAST, "group" ASC NULLS LAST
LIMIT 10000;

-- params: ["HOUSEHOLD"]
SELECT "task"."__d_province" AS "group", sum("task"."__m_nets_distributed") AS "value", count(*) AS "n"
FROM (SELECT *, strftime('%Y-%m-%d %H:%M:%f', "Data.createdTime" / 1000.0, 'unixepoch') AS "__t", "Data.createdTime" AS "__t_raw", "Data.province" AS "__d_province", CASE WHEN ("Data.deliveredTo" = ?) THEN "Data.quantity" END AS "__m_nets_distributed" FROM "project-task-index-v1") AS "task"
GROUP BY "task"."__d_province"
ORDER BY "value" DESC NULLS LAST, "group" ASC NULLS LAST
LIMIT 10;

-- params: ["HOUSEHOLD"]
SELECT (CAST(sum("task"."__m_population_covered") AS REAL) * 1.8) AS "value", count(*) AS "n"
FROM (SELECT *, strftime('%Y-%m-%d %H:%M:%f', "Data.createdTime" / 1000.0, 'unixepoch') AS "__t", "Data.createdTime" AS "__t_raw", CASE WHEN ("Data.deliveredTo" = ?) THEN "Data.quantity" END AS "__m_population_covered" FROM "project-task-index-v1") AS "task"
LIMIT 1;

-- params: ["HOUSEHOLD"]
SELECT count("task"."__m_visits") AS "value", count(*) AS "n"
FROM (SELECT *, strftime('%Y-%m-%d %H:%M:%f', "Data.createdTime" / 1000.0, 'unixepoch') AS "__t", "Data.createdTime" AS "__t_raw", CASE WHEN ("Data.deliveredTo" = ?) THEN "Data.id" END AS "__m_visits" FROM "project-task-index-v1") AS "task"
LIMIT 1;

-- params: ["HOUSEHOLD"]
SELECT strftime('%Y-%m-%d 00:00:00', "task"."__t") AS "bucket", count("task"."__m_visits") AS "value", count(*) AS "n"
FROM (SELECT *, strftime('%Y-%m-%d %H:%M:%f', "Data.createdTime" / 1000.0, 'unixepoch') AS "__t", "Data.createdTime" AS "__t_raw", CASE WHEN ("Data.deliveredTo" = ?) THEN "Data.id" END AS "__m_visits" FROM "project-task-index-v1") AS "task"
GROUP BY strftime('%Y-%m-%d 00:00:00', "task"."__t")
ORDER BY "bucket" ASC NULLS LAST
LIMIT 5000;

-- params: ["HOUSEHOLD"]
SELECT strftime('%Y-%m-%d 00:00:00', "task"."__t", '-' || ((CAST(strftime('%w', "task"."__t") AS INTEGER) + 6) % 7) || ' days') AS "bucket", "task"."__d_product_variant" AS "series", sum("task"."__m_nets_distributed") AS "value", count(*) AS "n"
FROM (SELECT *, strftime('%Y-%m-%d %H:%M:%f', "Data.createdTime" / 1000.0, 'unixepoch') AS "__t", "Data.createdTime" AS "__t_raw", "Data.productVariant" AS "__d_product_variant", CASE WHEN ("Data.deliveredTo" = ?) THEN "Data.quantity" END AS "__m_nets_distributed" FROM "project-task-index-v1") AS "task"
GROUP BY strftime('%Y-%m-%d 00:00:00', "task"."__t", '-' || ((CAST(strftime('%w', "task"."__t") AS INTEGER) + 6) % 7) || ' days'), "task"."__d_product_variant"
ORDER BY "bucket" ASC NULLS LAST, "series" ASC NULLS LAST
LIMIT 5000;

-- params: ["HOUSEHOLD"]
SELECT sum("project"."__m_household_target_at_province") AS "value", count(*) AS "n"
FROM (SELECT *, strftime('%Y-%m-%d %H:%M:%f', "Data.startDate" / 1000.0, 'unixepoch') AS "__t", "Data.startDate" AS "__t_raw", CASE WHEN (("Data.targetType" = ?) AND ("Data.district" IS NULL)) THEN "Data.overallTarget" END AS "__m_household_target_at_province" FROM "project-index-v1") AS "project"
LIMIT 1;

-- params: ["HOUSEHOLD"]
SELECT sum("task"."__m_nets_distributed") AS "value", count(*) AS "n"
FROM (SELECT *, strftime('%Y-%m-%d %H:%M:%f', "Data.createdTime" / 1000.0, 'unixepoch') AS "__t", "Data.createdTime" AS "__t_raw", CASE WHEN ("Data.deliveredTo" = ?) THEN "Data.quantity" END AS "__m_nets_distributed" FROM "project-task-index-v1") AS "task"
LIMIT 1;
