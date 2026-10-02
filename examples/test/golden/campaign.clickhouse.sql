-- params: ["HOUSEHOLD","0",""]
SELECT "task"."__d_not_delivered_reason" AS "group", count("task"."__m_households_not_delivered") AS "value", count(*) AS "n"
FROM (SELECT *, fromUnixTimestamp64Milli(CAST("Data.createdTime" AS Int64), 'UTC') AS "__t", "Data.createdTime" AS "__t_raw", "Data.deliveryComments" AS "__d_not_delivered_reason", CASE WHEN (("Data.deliveredTo" = {p1:String}) AND ("Data.quantity" = {p2:Int64})) THEN 1 END AS "__m_households_not_delivered" FROM "project-task-index-v1") AS "task"
WHERE ("task"."__d_not_delivered_reason" <> {p3:String})
GROUP BY "task"."__d_not_delivered_reason"
ORDER BY "value" DESC NULLS LAST, "group" ASC NULLS LAST
LIMIT 6;

-- params: ["HOUSEHOLD","0"]
SELECT "task"."__d_district" AS "group", count("task"."__m_households_delivered") AS "value", count(*) AS "n"
FROM (SELECT *, fromUnixTimestamp64Milli(CAST("Data.createdTime" AS Int64), 'UTC') AS "__t", "Data.createdTime" AS "__t_raw", "Data.district" AS "__d_district", CASE WHEN (("Data.deliveredTo" = {p1:String}) AND ("Data.quantity" > {p2:Int64})) THEN 1 END AS "__m_households_delivered" FROM "project-task-index-v1") AS "task"
GROUP BY "task"."__d_district"
ORDER BY "value" DESC NULLS LAST, "group" ASC NULLS LAST
LIMIT 10000;

-- params: ["HOUSEHOLD","0"]
SELECT count("task"."__m_households_delivered") AS "value", count(*) AS "n"
FROM (SELECT *, fromUnixTimestamp64Milli(CAST("Data.createdTime" AS Int64), 'UTC') AS "__t", "Data.createdTime" AS "__t_raw", CASE WHEN (("Data.deliveredTo" = {p1:String}) AND ("Data.quantity" > {p2:Int64})) THEN 1 END AS "__m_households_delivered" FROM "project-task-index-v1") AS "task"
LIMIT 1;

-- params: ["HOUSEHOLD"]
SELECT "project"."__d_district" AS "group", sum("project"."__m_household_target_at_district") AS "value", count(*) AS "n"
FROM (SELECT *, fromUnixTimestamp64Milli(CAST("Data.startDate" AS Int64), 'UTC') AS "__t", "Data.startDate" AS "__t_raw", "Data.district" AS "__d_district", CASE WHEN (("Data.targetType" = {p1:String}) AND ("Data.district" IS NOT NULL)) THEN "Data.overallTarget" END AS "__m_household_target_at_district" FROM "project-index-v1") AS "project"
GROUP BY "project"."__d_district"
ORDER BY "value" DESC NULLS LAST, "group" ASC NULLS LAST
LIMIT 10000;

-- params: ["HOUSEHOLD"]
SELECT "task"."__d_province" AS "group", sum("task"."__m_nets_distributed") AS "value", count(*) AS "n"
FROM (SELECT *, fromUnixTimestamp64Milli(CAST("Data.createdTime" AS Int64), 'UTC') AS "__t", "Data.createdTime" AS "__t_raw", "Data.province" AS "__d_province", CASE WHEN ("Data.deliveredTo" = {p1:String}) THEN "Data.quantity" END AS "__m_nets_distributed" FROM "project-task-index-v1") AS "task"
GROUP BY "task"."__d_province"
ORDER BY "value" DESC NULLS LAST, "group" ASC NULLS LAST
LIMIT 10;

-- params: ["HOUSEHOLD"]
SELECT (CAST(sum("task"."__m_population_covered") AS Float64) * 1.8) AS "value", count(*) AS "n"
FROM (SELECT *, fromUnixTimestamp64Milli(CAST("Data.createdTime" AS Int64), 'UTC') AS "__t", "Data.createdTime" AS "__t_raw", CASE WHEN ("Data.deliveredTo" = {p1:String}) THEN "Data.quantity" END AS "__m_population_covered" FROM "project-task-index-v1") AS "task"
LIMIT 1;

-- params: ["HOUSEHOLD"]
SELECT count("task"."__m_visits") AS "value", count(*) AS "n"
FROM (SELECT *, fromUnixTimestamp64Milli(CAST("Data.createdTime" AS Int64), 'UTC') AS "__t", "Data.createdTime" AS "__t_raw", CASE WHEN ("Data.deliveredTo" = {p1:String}) THEN "Data.id" END AS "__m_visits" FROM "project-task-index-v1") AS "task"
LIMIT 1;

-- params: ["HOUSEHOLD"]
SELECT sum("project"."__m_household_target_at_province") AS "value", count(*) AS "n"
FROM (SELECT *, fromUnixTimestamp64Milli(CAST("Data.startDate" AS Int64), 'UTC') AS "__t", "Data.startDate" AS "__t_raw", CASE WHEN (("Data.targetType" = {p1:String}) AND ("Data.district" IS NULL)) THEN "Data.overallTarget" END AS "__m_household_target_at_province" FROM "project-index-v1") AS "project"
LIMIT 1;

-- params: ["HOUSEHOLD"]
SELECT sum("task"."__m_nets_distributed") AS "value", count(*) AS "n"
FROM (SELECT *, fromUnixTimestamp64Milli(CAST("Data.createdTime" AS Int64), 'UTC') AS "__t", "Data.createdTime" AS "__t_raw", CASE WHEN ("Data.deliveredTo" = {p1:String}) THEN "Data.quantity" END AS "__m_nets_distributed" FROM "project-task-index-v1") AS "task"
LIMIT 1;

-- params: ["HOUSEHOLD"]
SELECT toDateTime(toMonday("task"."__t"), 'UTC') AS "bucket", "task"."__d_product_variant" AS "series", sum("task"."__m_nets_distributed") AS "value", count(*) AS "n"
FROM (SELECT *, fromUnixTimestamp64Milli(CAST("Data.createdTime" AS Int64), 'UTC') AS "__t", "Data.createdTime" AS "__t_raw", "Data.productVariant" AS "__d_product_variant", CASE WHEN ("Data.deliveredTo" = {p1:String}) THEN "Data.quantity" END AS "__m_nets_distributed" FROM "project-task-index-v1") AS "task"
GROUP BY toDateTime(toMonday("task"."__t"), 'UTC'), "task"."__d_product_variant"
ORDER BY "bucket" ASC NULLS LAST, "series" ASC NULLS LAST
LIMIT 5000;

-- params: ["HOUSEHOLD"]
SELECT toDateTime(toStartOfDay("task"."__t"), 'UTC') AS "bucket", count("task"."__m_visits") AS "value", count(*) AS "n"
FROM (SELECT *, fromUnixTimestamp64Milli(CAST("Data.createdTime" AS Int64), 'UTC') AS "__t", "Data.createdTime" AS "__t_raw", CASE WHEN ("Data.deliveredTo" = {p1:String}) THEN "Data.id" END AS "__m_visits" FROM "project-task-index-v1") AS "task"
GROUP BY toDateTime(toStartOfDay("task"."__t"), 'UTC')
ORDER BY "bucket" ASC NULLS LAST
LIMIT 5000;
