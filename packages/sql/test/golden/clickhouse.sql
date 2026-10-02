-- {"kind":"breakdown","dimension":"colour","measure":"things","limit":10,"sort":"desc"}
-- params: ["ke_1","ke\\\\_1.%","test"]
SELECT "things"."__d_colour" AS "group", count(*) AS "value", count(*) AS "n"
FROM (SELECT *, "made_at" AS "__t", (colour) AS "__d_colour" FROM "app"."things" WHERE ((("tenant_id" = {p1:String}) OR ("tenant_id" LIKE {p2:String}))) AND (deleted = false) AND ("kind" IS NULL OR "kind" <> {p3:String})) AS "things"
GROUP BY "things"."__d_colour"
ORDER BY "value" DESC NULLS LAST, "group" ASC NULLS LAST
LIMIT 10;

-- {"kind":"breakdown","dimension":"colour","measure":"weight","limit":10,"sort":"asc","sortBy":"group"}
-- params: ["ke_1","ke\\\\_1.%","test"]
SELECT "things"."__d_colour" AS "group", sum("things"."__m_weight") AS "value", count(*) AS "n"
FROM (SELECT *, "made_at" AS "__t", (colour) AS "__d_colour", (weight_g / 1000.0) AS "__m_weight" FROM "app"."things" WHERE ((("tenant_id" = {p1:String}) OR ("tenant_id" LIKE {p2:String}))) AND (deleted = false) AND ("kind" IS NULL OR "kind" <> {p3:String})) AS "things"
GROUP BY "things"."__d_colour"
ORDER BY "group" ASC NULLS LAST
LIMIT 10;

-- {"kind":"breakdown","dimension":"colour","measure":"broken","limit":10,"sort":"desc","sortBy":"measure"}
-- params: ["ke_1","ke\\\\_1.%","test"]
SELECT "things"."__d_colour" AS "group", count("things"."__m_broken") AS "value", count(*) AS "n"
FROM (SELECT *, "made_at" AS "__t", (colour) AS "__d_colour", CASE WHEN (status = 'broken') THEN 1 END AS "__m_broken" FROM "app"."things" WHERE ((("tenant_id" = {p1:String}) OR ("tenant_id" LIKE {p2:String}))) AND (deleted = false) AND ("kind" IS NULL OR "kind" <> {p3:String})) AS "things"
GROUP BY "things"."__d_colour"
ORDER BY "value" DESC NULLS LAST
LIMIT 10;

-- {"kind":"breakdown","dimension":"colour","measure":"big","limit":10,"sort":"desc","sortBy":"none"}
-- params: ["30","red","blue","ke_1","ke\\\\_1.%","test"]
SELECT "things"."__d_colour" AS "group", count("things"."__m_big") AS "value", count(*) AS "n"
FROM (SELECT *, "made_at" AS "__t", (colour) AS "__d_colour", CASE WHEN (("size" >= {p1:Int64}) AND ("colour" IN ({p2:String}, {p3:String}))) THEN 1 END AS "__m_big" FROM "app"."things" WHERE ((("tenant_id" = {p4:String}) OR ("tenant_id" LIKE {p5:String}))) AND (deleted = false) AND ("kind" IS NULL OR "kind" <> {p6:String})) AS "things"
GROUP BY "things"."__d_colour"
LIMIT 10;

-- {"kind":"breakdown","dimension":"tier","measure":"sized","by":"colour","limit":10,"sort":"desc"}
-- params: ["ke_1","ke\\\\_1.%","test"]
SELECT "owners"."__d_tier" AS "group", "things"."__d_colour" AS "series", count("things"."__m_sized") AS "value", count(*) AS "n"
FROM (SELECT *, "made_at" AS "__t", (colour) AS "__d_colour", "size" AS "__m_sized" FROM "app"."things" WHERE ((("tenant_id" = {p1:String}) OR ("tenant_id" LIKE {p2:String}))) AND (deleted = false) AND ("kind" IS NULL OR "kind" <> {p3:String})) AS "things"
LEFT JOIN (SELECT *, (upper(tier)) AS "__d_tier" FROM "Owners") AS "owners" ON "things"."owner_id" = "owners"."id"
GROUP BY "owners"."__d_tier", "things"."__d_colour"
ORDER BY "value" DESC NULLS LAST, "group" ASC NULLS LAST, "series" ASC NULLS LAST
LIMIT 10;

-- {"kind":"breakdown","dimension":"origin","measure":"labelled","limit":10,"sort":"desc"}
-- params: ["99","ke_1","ke\\\\_1.%","test"]
SELECT "things"."__d_origin" AS "group", count("things"."__m_labelled") AS "value", count(*) AS "n"
FROM (SELECT *, "made_at" AS "__t", JSONExtract("attrs", 'origin', 'Nullable(String)') AS "__d_origin", CASE WHEN ((("label" IS NOT NULL) AND ("note" IS NULL)) AND ("size" < {p1:Int64})) THEN 1 END AS "__m_labelled" FROM "app"."things" WHERE ((("tenant_id" = {p2:String}) OR ("tenant_id" LIKE {p3:String}))) AND (deleted = false) AND ("kind" IS NULL OR "kind" <> {p4:String})) AS "things"
GROUP BY "things"."__d_origin"
ORDER BY "value" DESC NULLS LAST, "group" ASC NULLS LAST
LIMIT 10;

-- {"kind":"breakdown","dimension":"nested","measure":"light","limit":10,"sort":"desc"}
-- params: ["10","1","red","ke_1","ke\\\\_1.%","test"]
SELECT "things"."__d_nested" AS "group", count("things"."__m_light") AS "value", count(*) AS "n"
FROM (SELECT *, "made_at" AS "__t", JSONExtract("attrs", 'meta', 'grade', 'Nullable(String)') AS "__d_nested", CASE WHEN ((("size" <= {p1:Int64}) AND ("size" > {p2:Int64})) AND ("colour" = {p3:String})) THEN 1 END AS "__m_light" FROM "app"."things" WHERE ((("tenant_id" = {p4:String}) OR ("tenant_id" LIKE {p5:String}))) AND (deleted = false) AND ("kind" IS NULL OR "kind" <> {p6:String})) AS "things"
GROUP BY "things"."__d_nested"
ORDER BY "value" DESC NULLS LAST, "group" ASC NULLS LAST
LIMIT 10;

-- {"kind":"breakdown","dimension":"colour","measure":"parts","limit":10,"sort":"desc","time":{"last":"30d"}}
-- params: ["ke_1","ke_1","ke\\\\_1.%","test","1768566896000","1771158896000"]
SELECT "things"."__d_colour" AS "group", count(*) AS "value", count(*) AS "n"
FROM (SELECT *, fromUnixTimestamp64Milli(CAST("added_ms" AS Int64), 'UTC') AS "__t", "added_ms" AS "__t_raw" FROM "parts" WHERE ("tenant_id" = {p1:String})) AS "parts"
LEFT JOIN (SELECT *, "made_at" AS "__t", (colour) AS "__d_colour" FROM "app"."things" WHERE ((("tenant_id" = {p2:String}) OR ("tenant_id" LIKE {p3:String}))) AND (deleted = false) AND ("kind" IS NULL OR "kind" <> {p4:String})) AS "things" ON "parts"."thing_id" = "things"."id"
WHERE (("parts"."__t_raw" >= CAST({p5:Int64} AS Int64)) AND ("parts"."__t_raw" < CAST({p6:Int64} AS Int64)))
GROUP BY "things"."__d_colour"
ORDER BY "value" DESC NULLS LAST, "group" ASC NULLS LAST
LIMIT 10;

-- {"kind":"breakdown","dimension":"level","measure":"logs","limit":10,"sort":"desc","time":{"from":"2026-01-01T00:00:00Z","to":"2026-02-01T00:00:00Z"}}
-- params: ["1767225600","1769904000"]
SELECT "logs"."__d_level" AS "group", count(*) AS "value", count(*) AS "n"
FROM (SELECT *, fromUnixTimestamp64Milli(CAST("at_s" AS Int64) * 1000, 'UTC') AS "__t", "at_s" AS "__t_raw", "level" AS "__d_level" FROM "logs") AS "logs"
WHERE (("logs"."__t_raw" >= CAST({p1:Int64} AS Int64)) AND ("logs"."__t_raw" < CAST({p2:Int64} AS Int64)))
GROUP BY "logs"."__d_level"
ORDER BY "value" DESC NULLS LAST, "group" ASC NULLS LAST
LIMIT 10;

-- {"kind":"value","measure":"avg_size"}
-- params: ["ke_1","ke\\\\_1.%","test"]
SELECT avg("things"."__m_avg_size") AS "value", count(*) AS "n"
FROM (SELECT *, "made_at" AS "__t", "size" AS "__m_avg_size" FROM "app"."things" WHERE ((("tenant_id" = {p1:String}) OR ("tenant_id" LIKE {p2:String}))) AND (deleted = false) AND ("kind" IS NULL OR "kind" <> {p3:String})) AS "things"
LIMIT 1;

-- {"kind":"value","measure":"min_size"}
-- params: ["ke_1","ke\\\\_1.%","test"]
SELECT min("things"."__m_min_size") AS "value", count(*) AS "n"
FROM (SELECT *, "made_at" AS "__t", "size" AS "__m_min_size" FROM "app"."things" WHERE ((("tenant_id" = {p1:String}) OR ("tenant_id" LIKE {p2:String}))) AND (deleted = false) AND ("kind" IS NULL OR "kind" <> {p3:String})) AS "things"
LIMIT 1;

-- {"kind":"value","measure":"max_size"}
-- params: ["ke_1","ke\\\\_1.%","test"]
SELECT max("things"."__m_max_size") AS "value", count(*) AS "n"
FROM (SELECT *, "made_at" AS "__t", "size" AS "__m_max_size" FROM "app"."things" WHERE ((("tenant_id" = {p1:String}) OR ("tenant_id" LIKE {p2:String}))) AND (deleted = false) AND ("kind" IS NULL OR "kind" <> {p3:String})) AS "things"
LIMIT 1;

-- {"kind":"value","measure":"median_size"}
-- params: ["ke_1","ke\\\\_1.%","test"]
SELECT quantileExactInclusive(0.5)("things"."__m_median_size") AS "value", count(*) AS "n"
FROM (SELECT *, "made_at" AS "__t", (size) AS "__m_median_size" FROM "app"."things" WHERE ((("tenant_id" = {p1:String}) OR ("tenant_id" LIKE {p2:String}))) AND (deleted = false) AND ("kind" IS NULL OR "kind" <> {p3:String})) AS "things"
LIMIT 1;

-- {"kind":"value","measure":"p90_size"}
-- params: ["ke_1","ke\\\\_1.%","test"]
SELECT quantileExactInclusive(0.9)("things"."__m_p90_size") AS "value", count(*) AS "n"
FROM (SELECT *, "made_at" AS "__t", (size) AS "__m_p90_size" FROM "app"."things" WHERE ((("tenant_id" = {p1:String}) OR ("tenant_id" LIKE {p2:String}))) AND (deleted = false) AND ("kind" IS NULL OR "kind" <> {p3:String})) AS "things"
LIMIT 1;

-- {"kind":"value","measure":"distinct_owners"}
-- params: ["ke_1","ke\\\\_1.%","test"]
SELECT count(DISTINCT "things"."__m_distinct_owners") AS "value", count(*) AS "n"
FROM (SELECT *, "made_at" AS "__t", (owner_id) AS "__m_distinct_owners" FROM "app"."things" WHERE ((("tenant_id" = {p1:String}) OR ("tenant_id" LIKE {p2:String}))) AND (deleted = false) AND ("kind" IS NULL OR "kind" <> {p3:String})) AS "things"
LIMIT 1;

-- {"kind":"value","measure":"scaled"}
-- params: ["ke_1","ke\\\\_1.%","test"]
SELECT (CAST(sum("things"."__m_scaled") AS Float64) * 1.8) AS "value", count(*) AS "n"
FROM (SELECT *, "made_at" AS "__t", "size" AS "__m_scaled" FROM "app"."things" WHERE ((("tenant_id" = {p1:String}) OR ("tenant_id" LIKE {p2:String}))) AND (deleted = false) AND ("kind" IS NULL OR "kind" <> {p3:String})) AS "things"
LIMIT 1;

-- {"kind":"value","measure":"per_thing"}
-- params: ["ke_1","ke\\\\_1.%","test"]
SELECT (((CAST(sum("things"."__m_weight") AS Float64) - CAST(count("things"."__m_broken") AS Float64)) / NULLIF(CAST(count(*) AS Float64), 0)) * 100) AS "value", count(*) AS "n"
FROM (SELECT *, "made_at" AS "__t", (weight_g / 1000.0) AS "__m_weight", CASE WHEN (status = 'broken') THEN 1 END AS "__m_broken" FROM "app"."things" WHERE ((("tenant_id" = {p1:String}) OR ("tenant_id" LIKE {p2:String}))) AND (deleted = false) AND ("kind" IS NULL OR "kind" <> {p3:String})) AS "things"
LIMIT 1;

-- {"kind":"value","measure":"negated"}
-- params: ["ke_1","ke\\\\_1.%","test"]
SELECT ((-1 * CAST(sum("things"."__m_weight") AS Float64)) + 1) AS "value", count(*) AS "n"
FROM (SELECT *, "made_at" AS "__t", (weight_g / 1000.0) AS "__m_weight" FROM "app"."things" WHERE ((("tenant_id" = {p1:String}) OR ("tenant_id" LIKE {p2:String}))) AND (deleted = false) AND ("kind" IS NULL OR "kind" <> {p3:String})) AS "things"
LIMIT 1;

-- {"kind":"value","measure":"owners"}
-- params: []
SELECT count(*) AS "value", count(*) AS "n"
FROM (SELECT * FROM "Owners") AS "owners"
LIMIT 1;

-- {"kind":"value","measure":"events","time":{"last":"7d"}}
-- params: ["2026-02-08 12:34:56.000","2026-02-15 12:34:56.000"]
SELECT count(*) AS "value", count(*) AS "n"
FROM (SELECT *, (toDateTime(t, 'UTC')) AS "__t" FROM "events") AS "events"
WHERE (("events"."__t" >= CAST({p1:DateTime64(3, 'UTC')} AS DateTime64(3, 'UTC'))) AND ("events"."__t" < CAST({p2:DateTime64(3, 'UTC')} AS DateTime64(3, 'UTC'))))
LIMIT 1;

-- {"kind":"value","measure":"weight","compare":"previous_period","time":{"last":"30d"}}
-- params: ["2026-01-16 12:34:56.000","2026-02-15 12:34:56.000","2026-01-16 12:34:56.000","2026-02-15 12:34:56.000","2025-12-17 12:34:56.000","2026-01-16 12:34:56.000","ke_1","ke\\\\_1.%","test","2025-12-17 12:34:56.000","2026-02-15 12:34:56.000"]
SELECT sum(CASE WHEN (("things"."__t" >= CAST({p1:DateTime64(3, 'UTC')} AS DateTime64(3, 'UTC'))) AND ("things"."__t" < CAST({p2:DateTime64(3, 'UTC')} AS DateTime64(3, 'UTC')))) THEN "things"."__m_weight" END) AS "value", count(CASE WHEN (("things"."__t" >= CAST({p3:DateTime64(3, 'UTC')} AS DateTime64(3, 'UTC'))) AND ("things"."__t" < CAST({p4:DateTime64(3, 'UTC')} AS DateTime64(3, 'UTC')))) THEN 1 END) AS "n", sum(CASE WHEN (("things"."__t" >= CAST({p5:DateTime64(3, 'UTC')} AS DateTime64(3, 'UTC'))) AND ("things"."__t" < CAST({p6:DateTime64(3, 'UTC')} AS DateTime64(3, 'UTC')))) THEN "things"."__m_weight" END) AS "previous"
FROM (SELECT *, "made_at" AS "__t", (weight_g / 1000.0) AS "__m_weight" FROM "app"."things" WHERE ((("tenant_id" = {p7:String}) OR ("tenant_id" LIKE {p8:String}))) AND (deleted = false) AND ("kind" IS NULL OR "kind" <> {p9:String})) AS "things"
WHERE ("things"."__t" >= CAST({p10:DateTime64(3, 'UTC')} AS DateTime64(3, 'UTC'))) AND ("things"."__t" < CAST({p11:DateTime64(3, 'UTC')} AS DateTime64(3, 'UTC')))
LIMIT 1;

-- {"kind":"value","measure":"parts","compare":"previous_period","time":{"from":"2026-01-01T00:00:00Z","to":"2026-02-01T00:00:00Z"}}
-- params: ["1767225600000","1769904000000","1767225600000","1769904000000","1764547200000","1767225600000","ke_1","1764547200000","1769904000000"]
SELECT count(CASE WHEN (("parts"."__t_raw" >= CAST({p1:Int64} AS Int64)) AND ("parts"."__t_raw" < CAST({p2:Int64} AS Int64))) THEN 1 END) AS "value", count(CASE WHEN (("parts"."__t_raw" >= CAST({p3:Int64} AS Int64)) AND ("parts"."__t_raw" < CAST({p4:Int64} AS Int64))) THEN 1 END) AS "n", count(CASE WHEN (("parts"."__t_raw" >= CAST({p5:Int64} AS Int64)) AND ("parts"."__t_raw" < CAST({p6:Int64} AS Int64))) THEN 1 END) AS "previous"
FROM (SELECT *, fromUnixTimestamp64Milli(CAST("added_ms" AS Int64), 'UTC') AS "__t", "added_ms" AS "__t_raw" FROM "parts" WHERE ("tenant_id" = {p7:String})) AS "parts"
WHERE ("parts"."__t_raw" >= CAST({p8:Int64} AS Int64)) AND ("parts"."__t_raw" < CAST({p9:Int64} AS Int64))
LIMIT 1;

-- {"kind":"value","measure":"logs","compare":"previous_period","time":{"from":"2026-01-01T00:00:00Z","to":"2026-02-01T00:00:00Z"}}
-- params: ["1767225600","1769904000","1767225600","1769904000","1764547200","1767225600","1764547200","1769904000"]
SELECT count(CASE WHEN (("logs"."__t_raw" >= CAST({p1:Int64} AS Int64)) AND ("logs"."__t_raw" < CAST({p2:Int64} AS Int64))) THEN 1 END) AS "value", count(CASE WHEN (("logs"."__t_raw" >= CAST({p3:Int64} AS Int64)) AND ("logs"."__t_raw" < CAST({p4:Int64} AS Int64))) THEN 1 END) AS "n", count(CASE WHEN (("logs"."__t_raw" >= CAST({p5:Int64} AS Int64)) AND ("logs"."__t_raw" < CAST({p6:Int64} AS Int64))) THEN 1 END) AS "previous"
FROM (SELECT *, fromUnixTimestamp64Milli(CAST("at_s" AS Int64) * 1000, 'UTC') AS "__t", "at_s" AS "__t_raw" FROM "logs") AS "logs"
WHERE ("logs"."__t_raw" >= CAST({p7:Int64} AS Int64)) AND ("logs"."__t_raw" < CAST({p8:Int64} AS Int64))
LIMIT 1;

-- {"kind":"value","measure":"broken","compare":"previous_period","time":{"from":"2026-01-01T00:00:00Z","to":"2026-02-01T00:00:00Z"}}
-- params: ["2026-01-01 00:00:00.000","2026-02-01 00:00:00.000","2026-01-01 00:00:00.000","2026-02-01 00:00:00.000","2025-12-01 00:00:00.000","2026-01-01 00:00:00.000","ke_1","ke\\\\_1.%","test","2025-12-01 00:00:00.000","2026-02-01 00:00:00.000"]
SELECT count(CASE WHEN (("things"."__t" >= CAST({p1:DateTime64(3, 'UTC')} AS DateTime64(3, 'UTC'))) AND ("things"."__t" < CAST({p2:DateTime64(3, 'UTC')} AS DateTime64(3, 'UTC')))) THEN "things"."__m_broken" END) AS "value", count(CASE WHEN (("things"."__t" >= CAST({p3:DateTime64(3, 'UTC')} AS DateTime64(3, 'UTC'))) AND ("things"."__t" < CAST({p4:DateTime64(3, 'UTC')} AS DateTime64(3, 'UTC')))) THEN 1 END) AS "n", count(CASE WHEN (("things"."__t" >= CAST({p5:DateTime64(3, 'UTC')} AS DateTime64(3, 'UTC'))) AND ("things"."__t" < CAST({p6:DateTime64(3, 'UTC')} AS DateTime64(3, 'UTC')))) THEN "things"."__m_broken" END) AS "previous"
FROM (SELECT *, "made_at" AS "__t", CASE WHEN (status = 'broken') THEN 1 END AS "__m_broken" FROM "app"."things" WHERE ((("tenant_id" = {p7:String}) OR ("tenant_id" LIKE {p8:String}))) AND (deleted = false) AND ("kind" IS NULL OR "kind" <> {p9:String})) AS "things"
WHERE ("things"."__t" >= CAST({p10:DateTime64(3, 'UTC')} AS DateTime64(3, 'UTC'))) AND ("things"."__t" < CAST({p11:DateTime64(3, 'UTC')} AS DateTime64(3, 'UTC')))
LIMIT 1;

-- {"kind":"series","measure":"things","grain":"hour"}
-- params: ["ke_1","ke\\\\_1.%","test"]
SELECT toDateTime(toStartOfHour("things"."__t"), 'UTC') AS "bucket", count(*) AS "value", count(*) AS "n"
FROM (SELECT *, "made_at" AS "__t" FROM "app"."things" WHERE ((("tenant_id" = {p1:String}) OR ("tenant_id" LIKE {p2:String}))) AND (deleted = false) AND ("kind" IS NULL OR "kind" <> {p3:String})) AS "things"
GROUP BY toDateTime(toStartOfHour("things"."__t"), 'UTC')
ORDER BY "bucket" ASC NULLS LAST
LIMIT 5000;

-- {"kind":"series","measure":"things","grain":"day"}
-- params: ["ke_1","ke\\\\_1.%","test"]
SELECT toDateTime(toStartOfDay("things"."__t"), 'UTC') AS "bucket", count(*) AS "value", count(*) AS "n"
FROM (SELECT *, "made_at" AS "__t" FROM "app"."things" WHERE ((("tenant_id" = {p1:String}) OR ("tenant_id" LIKE {p2:String}))) AND (deleted = false) AND ("kind" IS NULL OR "kind" <> {p3:String})) AS "things"
GROUP BY toDateTime(toStartOfDay("things"."__t"), 'UTC')
ORDER BY "bucket" ASC NULLS LAST
LIMIT 5000;

-- {"kind":"series","measure":"things","grain":"week"}
-- params: ["ke_1","ke\\\\_1.%","test"]
SELECT toDateTime(toMonday("things"."__t"), 'UTC') AS "bucket", count(*) AS "value", count(*) AS "n"
FROM (SELECT *, "made_at" AS "__t" FROM "app"."things" WHERE ((("tenant_id" = {p1:String}) OR ("tenant_id" LIKE {p2:String}))) AND (deleted = false) AND ("kind" IS NULL OR "kind" <> {p3:String})) AS "things"
GROUP BY toDateTime(toMonday("things"."__t"), 'UTC')
ORDER BY "bucket" ASC NULLS LAST
LIMIT 5000;

-- {"kind":"series","measure":"things","grain":"month"}
-- params: ["ke_1","ke\\\\_1.%","test"]
SELECT toDateTime(toStartOfMonth("things"."__t"), 'UTC') AS "bucket", count(*) AS "value", count(*) AS "n"
FROM (SELECT *, "made_at" AS "__t" FROM "app"."things" WHERE ((("tenant_id" = {p1:String}) OR ("tenant_id" LIKE {p2:String}))) AND (deleted = false) AND ("kind" IS NULL OR "kind" <> {p3:String})) AS "things"
GROUP BY toDateTime(toStartOfMonth("things"."__t"), 'UTC')
ORDER BY "bucket" ASC NULLS LAST
LIMIT 5000;

-- {"kind":"series","measure":"things","grain":"quarter"}
-- params: ["ke_1","ke\\\\_1.%","test"]
SELECT toDateTime(toStartOfQuarter("things"."__t"), 'UTC') AS "bucket", count(*) AS "value", count(*) AS "n"
FROM (SELECT *, "made_at" AS "__t" FROM "app"."things" WHERE ((("tenant_id" = {p1:String}) OR ("tenant_id" LIKE {p2:String}))) AND (deleted = false) AND ("kind" IS NULL OR "kind" <> {p3:String})) AS "things"
GROUP BY toDateTime(toStartOfQuarter("things"."__t"), 'UTC')
ORDER BY "bucket" ASC NULLS LAST
LIMIT 5000;

-- {"kind":"series","measure":"things","grain":"year"}
-- params: ["ke_1","ke\\\\_1.%","test"]
SELECT toDateTime(toStartOfYear("things"."__t"), 'UTC') AS "bucket", count(*) AS "value", count(*) AS "n"
FROM (SELECT *, "made_at" AS "__t" FROM "app"."things" WHERE ((("tenant_id" = {p1:String}) OR ("tenant_id" LIKE {p2:String}))) AND (deleted = false) AND ("kind" IS NULL OR "kind" <> {p3:String})) AS "things"
GROUP BY toDateTime(toStartOfYear("things"."__t"), 'UTC')
ORDER BY "bucket" ASC NULLS LAST
LIMIT 5000;

-- {"kind":"series","measure":"weight","grain":"week","by":"tier","time":{"last":"12w"}}
-- params: ["ke_1","ke\\\\_1.%","test","2025-11-23 12:34:56.000","2026-02-15 12:34:56.000"]
SELECT toDateTime(toMonday("things"."__t"), 'UTC') AS "bucket", "owners"."__d_tier" AS "series", sum("things"."__m_weight") AS "value", count(*) AS "n"
FROM (SELECT *, "made_at" AS "__t", (weight_g / 1000.0) AS "__m_weight" FROM "app"."things" WHERE ((("tenant_id" = {p1:String}) OR ("tenant_id" LIKE {p2:String}))) AND (deleted = false) AND ("kind" IS NULL OR "kind" <> {p3:String})) AS "things"
LEFT JOIN (SELECT *, (upper(tier)) AS "__d_tier" FROM "Owners") AS "owners" ON "things"."owner_id" = "owners"."id"
WHERE (("things"."__t" >= CAST({p4:DateTime64(3, 'UTC')} AS DateTime64(3, 'UTC'))) AND ("things"."__t" < CAST({p5:DateTime64(3, 'UTC')} AS DateTime64(3, 'UTC'))))
GROUP BY toDateTime(toMonday("things"."__t"), 'UTC'), "owners"."__d_tier"
ORDER BY "bucket" ASC NULLS LAST, "series" ASC NULLS LAST
LIMIT 5000;

-- {"kind":"series","measure":"parts","grain":"day","time":{"last":"60d"}}
-- params: ["ke_1","1765974896000","1771158896000"]
SELECT toDateTime(toStartOfDay("parts"."__t"), 'UTC') AS "bucket", count(*) AS "value", count(*) AS "n"
FROM (SELECT *, fromUnixTimestamp64Milli(CAST("added_ms" AS Int64), 'UTC') AS "__t", "added_ms" AS "__t_raw" FROM "parts" WHERE ("tenant_id" = {p1:String})) AS "parts"
WHERE (("parts"."__t_raw" >= CAST({p2:Int64} AS Int64)) AND ("parts"."__t_raw" < CAST({p3:Int64} AS Int64)))
GROUP BY toDateTime(toStartOfDay("parts"."__t"), 'UTC')
ORDER BY "bucket" ASC NULLS LAST
LIMIT 5000;

-- {"kind":"series","measure":"logs","grain":"month"}
-- params: []
SELECT toDateTime(toStartOfMonth("logs"."__t"), 'UTC') AS "bucket", count(*) AS "value", count(*) AS "n"
FROM (SELECT *, fromUnixTimestamp64Milli(CAST("at_s" AS Int64) * 1000, 'UTC') AS "__t", "at_s" AS "__t_raw" FROM "logs") AS "logs"
GROUP BY toDateTime(toStartOfMonth("logs"."__t"), 'UTC')
ORDER BY "bucket" ASC NULLS LAST
LIMIT 5000;

-- {"kind":"series","measure":"events","grain":"hour","time":{"last":"2d"}}
-- params: ["2026-02-13 12:34:56.000","2026-02-15 12:34:56.000"]
SELECT toDateTime(toStartOfHour("events"."__t"), 'UTC') AS "bucket", count(*) AS "value", count(*) AS "n"
FROM (SELECT *, (toDateTime(t, 'UTC')) AS "__t" FROM "events") AS "events"
WHERE (("events"."__t" >= CAST({p1:DateTime64(3, 'UTC')} AS DateTime64(3, 'UTC'))) AND ("events"."__t" < CAST({p2:DateTime64(3, 'UTC')} AS DateTime64(3, 'UTC'))))
GROUP BY toDateTime(toStartOfHour("events"."__t"), 'UTC')
ORDER BY "bucket" ASC NULLS LAST
LIMIT 5000;

-- {"kind":"value","measure":"things","filters":[{"dimension":"colour","op":"eq","value":"red"},{"dimension":"colour","op":"neq","value":"blue"},{"dimension":"size","op":"gte","value":10},{"dimension":"size","op":"lte","value":90},{"dimension":"colour","op":"in","value":["red","green"]},{"dimension":"size","op":"between","value":[20,40]},{"dimension":"path","op":"segment","value":["B%1","C"]},{"dimension":"path","op":"subtree","value":"a_b"},{"dimension":"colour","op":"contains","value":"E%D"},{"dimension":"tier","op":"eq","value":"GOLD"}]}
-- params: ["ke_1","ke\\\\_1.%","test","red","blue","10","90","red","green","20","40","B%1","C","a_b","a\\\\_b.%","%E\\\\%D%","GOLD"]
SELECT count(*) AS "value", count(*) AS "n"
FROM (SELECT *, "made_at" AS "__t", (colour) AS "__d_colour", "size" AS "__d_size", "path" AS "__d_path" FROM "app"."things" WHERE ((("tenant_id" = {p1:String}) OR ("tenant_id" LIKE {p2:String}))) AND (deleted = false) AND ("kind" IS NULL OR "kind" <> {p3:String})) AS "things"
LEFT JOIN (SELECT *, (upper(tier)) AS "__d_tier" FROM "Owners") AS "owners" ON "things"."owner_id" = "owners"."id"
WHERE ("things"."__d_colour" = {p4:String}) AND ("things"."__d_colour" <> {p5:String}) AND ("things"."__d_size" >= {p6:Int64}) AND ("things"."__d_size" <= {p7:Int64}) AND ("things"."__d_colour" IN ({p8:String}, {p9:String})) AND (("things"."__d_size" >= {p10:Int64}) AND ("things"."__d_size" <= {p11:Int64})) AND hasAny(splitByChar('|', ifNull(CAST("things"."__d_path" AS String), '')), [{p12:String}, {p13:String}]) AND ((("things"."__d_path" = {p14:String}) OR ("things"."__d_path" LIKE {p15:String}))) AND (CAST("things"."__d_colour" AS String) ILIKE {p16:String}) AND ("owners"."__d_tier" = {p17:String})
LIMIT 1;

-- {"kind":"rows","entity":"things","columns":["colour","size","origin"],"limit":4,"orderBy":{"key":"size","dir":"desc"}}
-- params: ["ke_1","ke\\\\_1.%","test"]
SELECT "things"."__d_colour" AS "colour", "things"."__d_size" AS "size", "things"."__d_origin" AS "origin"
FROM (SELECT *, "made_at" AS "__t", (colour) AS "__d_colour", "size" AS "__d_size", JSONExtract("attrs", 'origin', 'Nullable(String)') AS "__d_origin" FROM "app"."things" WHERE ((("tenant_id" = {p1:String}) OR ("tenant_id" LIKE {p2:String}))) AND (deleted = false) AND ("kind" IS NULL OR "kind" <> {p3:String})) AS "things"
ORDER BY "things"."__d_size" DESC NULLS LAST, "things"."__d_colour" ASC NULLS LAST, "things"."__d_origin" ASC NULLS LAST
LIMIT 4;

-- {"kind":"rows","entity":"things","columns":["colour","nested"],"limit":20}
-- params: ["ke_1","ke\\\\_1.%","test"]
SELECT "things"."__d_colour" AS "colour", "things"."__d_nested" AS "nested"
FROM (SELECT *, "made_at" AS "__t", (colour) AS "__d_colour", JSONExtract("attrs", 'meta', 'grade', 'Nullable(String)') AS "__d_nested" FROM "app"."things" WHERE ((("tenant_id" = {p1:String}) OR ("tenant_id" LIKE {p2:String}))) AND (deleted = false) AND ("kind" IS NULL OR "kind" <> {p3:String})) AS "things"
LIMIT 20;
