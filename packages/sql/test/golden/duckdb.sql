-- {"kind":"breakdown","dimension":"colour","measure":"things","limit":10,"sort":"desc"}
-- params: ["ke_1","ke\\_1.%","test"]
SELECT "things"."__d_colour" AS "group", count(*) AS "value", count(*) AS "n"
FROM (SELECT *, "made_at" AS "__t", (colour) AS "__d_colour" FROM "app"."things" WHERE ((("tenant_id" = $1) OR ("tenant_id" LIKE $2 ESCAPE '\'))) AND (deleted = false) AND ("kind" IS DISTINCT FROM $3)) AS "things"
GROUP BY "things"."__d_colour"
ORDER BY "value" DESC NULLS LAST, "group" ASC NULLS LAST
LIMIT 10;

-- {"kind":"breakdown","dimension":"colour","measure":"weight","limit":10,"sort":"asc","sortBy":"group"}
-- params: ["ke_1","ke\\_1.%","test"]
SELECT "things"."__d_colour" AS "group", sum("things"."__m_weight") AS "value", count(*) AS "n"
FROM (SELECT *, "made_at" AS "__t", (colour) AS "__d_colour", (weight_g / 1000.0) AS "__m_weight" FROM "app"."things" WHERE ((("tenant_id" = $1) OR ("tenant_id" LIKE $2 ESCAPE '\'))) AND (deleted = false) AND ("kind" IS DISTINCT FROM $3)) AS "things"
GROUP BY "things"."__d_colour"
ORDER BY "group" ASC NULLS LAST
LIMIT 10;

-- {"kind":"breakdown","dimension":"colour","measure":"broken","limit":10,"sort":"desc","sortBy":"measure"}
-- params: ["ke_1","ke\\_1.%","test"]
SELECT "things"."__d_colour" AS "group", count("things"."__m_broken") AS "value", count(*) AS "n"
FROM (SELECT *, "made_at" AS "__t", (colour) AS "__d_colour", CASE WHEN (status = 'broken') THEN 1 END AS "__m_broken" FROM "app"."things" WHERE ((("tenant_id" = $1) OR ("tenant_id" LIKE $2 ESCAPE '\'))) AND (deleted = false) AND ("kind" IS DISTINCT FROM $3)) AS "things"
GROUP BY "things"."__d_colour"
ORDER BY "value" DESC NULLS LAST
LIMIT 10;

-- {"kind":"breakdown","dimension":"colour","measure":"big","limit":10,"sort":"desc","sortBy":"none"}
-- params: [30,"red","blue","ke_1","ke\\_1.%","test"]
SELECT "things"."__d_colour" AS "group", count("things"."__m_big") AS "value", count(*) AS "n"
FROM (SELECT *, "made_at" AS "__t", (colour) AS "__d_colour", CASE WHEN (("size" >= $1) AND ("colour" IN ($2, $3))) THEN 1 END AS "__m_big" FROM "app"."things" WHERE ((("tenant_id" = $4) OR ("tenant_id" LIKE $5 ESCAPE '\'))) AND (deleted = false) AND ("kind" IS DISTINCT FROM $6)) AS "things"
GROUP BY "things"."__d_colour"
LIMIT 10;

-- {"kind":"breakdown","dimension":"tier","measure":"sized","by":"colour","limit":10,"sort":"desc"}
-- params: ["ke_1","ke\\_1.%","test"]
SELECT "owners"."__d_tier" AS "group", "things"."__d_colour" AS "series", count("things"."__m_sized") AS "value", count(*) AS "n"
FROM (SELECT *, "made_at" AS "__t", (colour) AS "__d_colour", "size" AS "__m_sized" FROM "app"."things" WHERE ((("tenant_id" = $1) OR ("tenant_id" LIKE $2 ESCAPE '\'))) AND (deleted = false) AND ("kind" IS DISTINCT FROM $3)) AS "things"
LEFT JOIN (SELECT *, (upper(tier)) AS "__d_tier" FROM "Owners") AS "owners" ON "things"."owner_id" = "owners"."id"
GROUP BY "owners"."__d_tier", "things"."__d_colour"
ORDER BY "value" DESC NULLS LAST, "group" ASC NULLS LAST, "series" ASC NULLS LAST
LIMIT 10;

-- {"kind":"breakdown","dimension":"origin","measure":"labelled","limit":10,"sort":"desc"}
-- params: [99,"ke_1","ke\\_1.%","test"]
SELECT "things"."__d_origin" AS "group", count("things"."__m_labelled") AS "value", count(*) AS "n"
FROM (SELECT *, "made_at" AS "__t", json_extract_string("attrs", '$."origin"') AS "__d_origin", CASE WHEN ((("label" IS NOT NULL) AND ("note" IS NULL)) AND ("size" < $1)) THEN 1 END AS "__m_labelled" FROM "app"."things" WHERE ((("tenant_id" = $2) OR ("tenant_id" LIKE $3 ESCAPE '\'))) AND (deleted = false) AND ("kind" IS DISTINCT FROM $4)) AS "things"
GROUP BY "things"."__d_origin"
ORDER BY "value" DESC NULLS LAST, "group" ASC NULLS LAST
LIMIT 10;

-- {"kind":"breakdown","dimension":"nested","measure":"light","limit":10,"sort":"desc"}
-- params: [10,1,"red","ke_1","ke\\_1.%","test"]
SELECT "things"."__d_nested" AS "group", count("things"."__m_light") AS "value", count(*) AS "n"
FROM (SELECT *, "made_at" AS "__t", json_extract_string("attrs", '$."meta"."grade"') AS "__d_nested", CASE WHEN ((("size" <= $1) AND ("size" > $2)) AND ("colour" = $3)) THEN 1 END AS "__m_light" FROM "app"."things" WHERE ((("tenant_id" = $4) OR ("tenant_id" LIKE $5 ESCAPE '\'))) AND (deleted = false) AND ("kind" IS DISTINCT FROM $6)) AS "things"
GROUP BY "things"."__d_nested"
ORDER BY "value" DESC NULLS LAST, "group" ASC NULLS LAST
LIMIT 10;

-- {"kind":"breakdown","dimension":"colour","measure":"parts","limit":10,"sort":"desc","time":{"last":"30d"}}
-- params: ["ke_1","ke_1","ke\\_1.%","test","1768566896000n","1771158896000n"]
SELECT "things"."__d_colour" AS "group", count(*) AS "value", count(*) AS "n"
FROM (SELECT *, epoch_ms(CAST("added_ms" AS BIGINT)) AS "__t", "added_ms" AS "__t_raw" FROM "parts" WHERE ("tenant_id" = $1)) AS "parts"
LEFT JOIN (SELECT *, "made_at" AS "__t", (colour) AS "__d_colour" FROM "app"."things" WHERE ((("tenant_id" = $2) OR ("tenant_id" LIKE $3 ESCAPE '\'))) AND (deleted = false) AND ("kind" IS DISTINCT FROM $4)) AS "things" ON "parts"."thing_id" = "things"."id"
WHERE (("parts"."__t_raw" >= CAST($5 AS BIGINT)) AND ("parts"."__t_raw" < CAST($6 AS BIGINT)))
GROUP BY "things"."__d_colour"
ORDER BY "value" DESC NULLS LAST, "group" ASC NULLS LAST
LIMIT 10;

-- {"kind":"breakdown","dimension":"level","measure":"logs","limit":10,"sort":"desc","time":{"from":"2026-01-01T00:00:00Z","to":"2026-02-01T00:00:00Z"}}
-- params: [1767225600,1769904000]
SELECT "logs"."__d_level" AS "group", count(*) AS "value", count(*) AS "n"
FROM (SELECT *, epoch_ms(CAST("at_s" AS BIGINT) * 1000) AS "__t", "at_s" AS "__t_raw", "level" AS "__d_level" FROM "logs") AS "logs"
WHERE (("logs"."__t_raw" >= CAST($1 AS BIGINT)) AND ("logs"."__t_raw" < CAST($2 AS BIGINT)))
GROUP BY "logs"."__d_level"
ORDER BY "value" DESC NULLS LAST, "group" ASC NULLS LAST
LIMIT 10;

-- {"kind":"value","measure":"avg_size"}
-- params: ["ke_1","ke\\_1.%","test"]
SELECT avg("things"."__m_avg_size") AS "value", count(*) AS "n"
FROM (SELECT *, "made_at" AS "__t", "size" AS "__m_avg_size" FROM "app"."things" WHERE ((("tenant_id" = $1) OR ("tenant_id" LIKE $2 ESCAPE '\'))) AND (deleted = false) AND ("kind" IS DISTINCT FROM $3)) AS "things"
LIMIT 1;

-- {"kind":"value","measure":"min_size"}
-- params: ["ke_1","ke\\_1.%","test"]
SELECT min("things"."__m_min_size") AS "value", count(*) AS "n"
FROM (SELECT *, "made_at" AS "__t", "size" AS "__m_min_size" FROM "app"."things" WHERE ((("tenant_id" = $1) OR ("tenant_id" LIKE $2 ESCAPE '\'))) AND (deleted = false) AND ("kind" IS DISTINCT FROM $3)) AS "things"
LIMIT 1;

-- {"kind":"value","measure":"max_size"}
-- params: ["ke_1","ke\\_1.%","test"]
SELECT max("things"."__m_max_size") AS "value", count(*) AS "n"
FROM (SELECT *, "made_at" AS "__t", "size" AS "__m_max_size" FROM "app"."things" WHERE ((("tenant_id" = $1) OR ("tenant_id" LIKE $2 ESCAPE '\'))) AND (deleted = false) AND ("kind" IS DISTINCT FROM $3)) AS "things"
LIMIT 1;

-- {"kind":"value","measure":"median_size"}
-- params: ["ke_1","ke\\_1.%","test"]
SELECT quantile_cont("things"."__m_median_size", 0.5) AS "value", count(*) AS "n"
FROM (SELECT *, "made_at" AS "__t", (size) AS "__m_median_size" FROM "app"."things" WHERE ((("tenant_id" = $1) OR ("tenant_id" LIKE $2 ESCAPE '\'))) AND (deleted = false) AND ("kind" IS DISTINCT FROM $3)) AS "things"
LIMIT 1;

-- {"kind":"value","measure":"p90_size"}
-- params: ["ke_1","ke\\_1.%","test"]
SELECT quantile_cont("things"."__m_p90_size", 0.9) AS "value", count(*) AS "n"
FROM (SELECT *, "made_at" AS "__t", (size) AS "__m_p90_size" FROM "app"."things" WHERE ((("tenant_id" = $1) OR ("tenant_id" LIKE $2 ESCAPE '\'))) AND (deleted = false) AND ("kind" IS DISTINCT FROM $3)) AS "things"
LIMIT 1;

-- {"kind":"value","measure":"distinct_owners"}
-- params: ["ke_1","ke\\_1.%","test"]
SELECT count(DISTINCT "things"."__m_distinct_owners") AS "value", count(*) AS "n"
FROM (SELECT *, "made_at" AS "__t", (owner_id) AS "__m_distinct_owners" FROM "app"."things" WHERE ((("tenant_id" = $1) OR ("tenant_id" LIKE $2 ESCAPE '\'))) AND (deleted = false) AND ("kind" IS DISTINCT FROM $3)) AS "things"
LIMIT 1;

-- {"kind":"value","measure":"scaled"}
-- params: ["ke_1","ke\\_1.%","test"]
SELECT (CAST(sum("things"."__m_scaled") AS DOUBLE) * 1.8) AS "value", count(*) AS "n"
FROM (SELECT *, "made_at" AS "__t", "size" AS "__m_scaled" FROM "app"."things" WHERE ((("tenant_id" = $1) OR ("tenant_id" LIKE $2 ESCAPE '\'))) AND (deleted = false) AND ("kind" IS DISTINCT FROM $3)) AS "things"
LIMIT 1;

-- {"kind":"value","measure":"per_thing"}
-- params: ["ke_1","ke\\_1.%","test"]
SELECT (((CAST(sum("things"."__m_weight") AS DOUBLE) - CAST(count("things"."__m_broken") AS DOUBLE)) / NULLIF(CAST(count(*) AS DOUBLE), 0)) * 100) AS "value", count(*) AS "n"
FROM (SELECT *, "made_at" AS "__t", (weight_g / 1000.0) AS "__m_weight", CASE WHEN (status = 'broken') THEN 1 END AS "__m_broken" FROM "app"."things" WHERE ((("tenant_id" = $1) OR ("tenant_id" LIKE $2 ESCAPE '\'))) AND (deleted = false) AND ("kind" IS DISTINCT FROM $3)) AS "things"
LIMIT 1;

-- {"kind":"value","measure":"negated"}
-- params: ["ke_1","ke\\_1.%","test"]
SELECT ((-1 * CAST(sum("things"."__m_weight") AS DOUBLE)) + 1) AS "value", count(*) AS "n"
FROM (SELECT *, "made_at" AS "__t", (weight_g / 1000.0) AS "__m_weight" FROM "app"."things" WHERE ((("tenant_id" = $1) OR ("tenant_id" LIKE $2 ESCAPE '\'))) AND (deleted = false) AND ("kind" IS DISTINCT FROM $3)) AS "things"
LIMIT 1;

-- {"kind":"value","measure":"owners"}
-- params: []
SELECT count(*) AS "value", count(*) AS "n"
FROM (SELECT * FROM "Owners") AS "owners"
LIMIT 1;

-- {"kind":"value","measure":"events","time":{"last":"7d"}}
-- params: ["2026-02-08 12:34:56.000","2026-02-15 12:34:56.000"]
SELECT count(*) AS "value", count(*) AS "n"
FROM (SELECT *, (to_timestamp(t)) AS "__t" FROM "events") AS "events"
WHERE (("events"."__t" >= CAST($1 AS TIMESTAMP)) AND ("events"."__t" < CAST($2 AS TIMESTAMP)))
LIMIT 1;

-- {"kind":"value","measure":"weight","compare":"previous_period","time":{"last":"30d"}}
-- params: ["2026-01-16 12:34:56.000","2026-02-15 12:34:56.000","2026-01-16 12:34:56.000","2026-02-15 12:34:56.000","2025-12-17 12:34:56.000","2026-01-16 12:34:56.000","ke_1","ke\\_1.%","test","2025-12-17 12:34:56.000","2026-02-15 12:34:56.000"]
SELECT sum(CASE WHEN (("things"."__t" >= CAST($1 AS TIMESTAMP)) AND ("things"."__t" < CAST($2 AS TIMESTAMP))) THEN "things"."__m_weight" END) AS "value", count(CASE WHEN (("things"."__t" >= CAST($3 AS TIMESTAMP)) AND ("things"."__t" < CAST($4 AS TIMESTAMP))) THEN 1 END) AS "n", sum(CASE WHEN (("things"."__t" >= CAST($5 AS TIMESTAMP)) AND ("things"."__t" < CAST($6 AS TIMESTAMP))) THEN "things"."__m_weight" END) AS "previous"
FROM (SELECT *, "made_at" AS "__t", (weight_g / 1000.0) AS "__m_weight" FROM "app"."things" WHERE ((("tenant_id" = $7) OR ("tenant_id" LIKE $8 ESCAPE '\'))) AND (deleted = false) AND ("kind" IS DISTINCT FROM $9)) AS "things"
WHERE ("things"."__t" >= CAST($10 AS TIMESTAMP)) AND ("things"."__t" < CAST($11 AS TIMESTAMP))
LIMIT 1;

-- {"kind":"value","measure":"parts","compare":"previous_period","time":{"from":"2026-01-01T00:00:00Z","to":"2026-02-01T00:00:00Z"}}
-- params: ["1767225600000n","1769904000000n","1767225600000n","1769904000000n","1764547200000n","1767225600000n","ke_1","1764547200000n","1769904000000n"]
SELECT count(CASE WHEN (("parts"."__t_raw" >= CAST($1 AS BIGINT)) AND ("parts"."__t_raw" < CAST($2 AS BIGINT))) THEN 1 END) AS "value", count(CASE WHEN (("parts"."__t_raw" >= CAST($3 AS BIGINT)) AND ("parts"."__t_raw" < CAST($4 AS BIGINT))) THEN 1 END) AS "n", count(CASE WHEN (("parts"."__t_raw" >= CAST($5 AS BIGINT)) AND ("parts"."__t_raw" < CAST($6 AS BIGINT))) THEN 1 END) AS "previous"
FROM (SELECT *, epoch_ms(CAST("added_ms" AS BIGINT)) AS "__t", "added_ms" AS "__t_raw" FROM "parts" WHERE ("tenant_id" = $7)) AS "parts"
WHERE ("parts"."__t_raw" >= CAST($8 AS BIGINT)) AND ("parts"."__t_raw" < CAST($9 AS BIGINT))
LIMIT 1;

-- {"kind":"value","measure":"logs","compare":"previous_period","time":{"from":"2026-01-01T00:00:00Z","to":"2026-02-01T00:00:00Z"}}
-- params: [1767225600,1769904000,1767225600,1769904000,1764547200,1767225600,1764547200,1769904000]
SELECT count(CASE WHEN (("logs"."__t_raw" >= CAST($1 AS BIGINT)) AND ("logs"."__t_raw" < CAST($2 AS BIGINT))) THEN 1 END) AS "value", count(CASE WHEN (("logs"."__t_raw" >= CAST($3 AS BIGINT)) AND ("logs"."__t_raw" < CAST($4 AS BIGINT))) THEN 1 END) AS "n", count(CASE WHEN (("logs"."__t_raw" >= CAST($5 AS BIGINT)) AND ("logs"."__t_raw" < CAST($6 AS BIGINT))) THEN 1 END) AS "previous"
FROM (SELECT *, epoch_ms(CAST("at_s" AS BIGINT) * 1000) AS "__t", "at_s" AS "__t_raw" FROM "logs") AS "logs"
WHERE ("logs"."__t_raw" >= CAST($7 AS BIGINT)) AND ("logs"."__t_raw" < CAST($8 AS BIGINT))
LIMIT 1;

-- {"kind":"value","measure":"broken","compare":"previous_period","time":{"from":"2026-01-01T00:00:00Z","to":"2026-02-01T00:00:00Z"}}
-- params: ["2026-01-01 00:00:00.000","2026-02-01 00:00:00.000","2026-01-01 00:00:00.000","2026-02-01 00:00:00.000","2025-12-01 00:00:00.000","2026-01-01 00:00:00.000","ke_1","ke\\_1.%","test","2025-12-01 00:00:00.000","2026-02-01 00:00:00.000"]
SELECT count(CASE WHEN (("things"."__t" >= CAST($1 AS TIMESTAMP)) AND ("things"."__t" < CAST($2 AS TIMESTAMP))) THEN "things"."__m_broken" END) AS "value", count(CASE WHEN (("things"."__t" >= CAST($3 AS TIMESTAMP)) AND ("things"."__t" < CAST($4 AS TIMESTAMP))) THEN 1 END) AS "n", count(CASE WHEN (("things"."__t" >= CAST($5 AS TIMESTAMP)) AND ("things"."__t" < CAST($6 AS TIMESTAMP))) THEN "things"."__m_broken" END) AS "previous"
FROM (SELECT *, "made_at" AS "__t", CASE WHEN (status = 'broken') THEN 1 END AS "__m_broken" FROM "app"."things" WHERE ((("tenant_id" = $7) OR ("tenant_id" LIKE $8 ESCAPE '\'))) AND (deleted = false) AND ("kind" IS DISTINCT FROM $9)) AS "things"
WHERE ("things"."__t" >= CAST($10 AS TIMESTAMP)) AND ("things"."__t" < CAST($11 AS TIMESTAMP))
LIMIT 1;

-- {"kind":"series","measure":"things","grain":"hour"}
-- params: ["ke_1","ke\\_1.%","test"]
SELECT date_trunc('hour', "things"."__t") AS "bucket", count(*) AS "value", count(*) AS "n"
FROM (SELECT *, "made_at" AS "__t" FROM "app"."things" WHERE ((("tenant_id" = $1) OR ("tenant_id" LIKE $2 ESCAPE '\'))) AND (deleted = false) AND ("kind" IS DISTINCT FROM $3)) AS "things"
GROUP BY date_trunc('hour', "things"."__t")
ORDER BY "bucket" ASC NULLS LAST
LIMIT 5000;

-- {"kind":"series","measure":"things","grain":"day"}
-- params: ["ke_1","ke\\_1.%","test"]
SELECT date_trunc('day', "things"."__t") AS "bucket", count(*) AS "value", count(*) AS "n"
FROM (SELECT *, "made_at" AS "__t" FROM "app"."things" WHERE ((("tenant_id" = $1) OR ("tenant_id" LIKE $2 ESCAPE '\'))) AND (deleted = false) AND ("kind" IS DISTINCT FROM $3)) AS "things"
GROUP BY date_trunc('day', "things"."__t")
ORDER BY "bucket" ASC NULLS LAST
LIMIT 5000;

-- {"kind":"series","measure":"things","grain":"week"}
-- params: ["ke_1","ke\\_1.%","test"]
SELECT date_trunc('week', "things"."__t") AS "bucket", count(*) AS "value", count(*) AS "n"
FROM (SELECT *, "made_at" AS "__t" FROM "app"."things" WHERE ((("tenant_id" = $1) OR ("tenant_id" LIKE $2 ESCAPE '\'))) AND (deleted = false) AND ("kind" IS DISTINCT FROM $3)) AS "things"
GROUP BY date_trunc('week', "things"."__t")
ORDER BY "bucket" ASC NULLS LAST
LIMIT 5000;

-- {"kind":"series","measure":"things","grain":"month"}
-- params: ["ke_1","ke\\_1.%","test"]
SELECT date_trunc('month', "things"."__t") AS "bucket", count(*) AS "value", count(*) AS "n"
FROM (SELECT *, "made_at" AS "__t" FROM "app"."things" WHERE ((("tenant_id" = $1) OR ("tenant_id" LIKE $2 ESCAPE '\'))) AND (deleted = false) AND ("kind" IS DISTINCT FROM $3)) AS "things"
GROUP BY date_trunc('month', "things"."__t")
ORDER BY "bucket" ASC NULLS LAST
LIMIT 5000;

-- {"kind":"series","measure":"things","grain":"quarter"}
-- params: ["ke_1","ke\\_1.%","test"]
SELECT date_trunc('quarter', "things"."__t") AS "bucket", count(*) AS "value", count(*) AS "n"
FROM (SELECT *, "made_at" AS "__t" FROM "app"."things" WHERE ((("tenant_id" = $1) OR ("tenant_id" LIKE $2 ESCAPE '\'))) AND (deleted = false) AND ("kind" IS DISTINCT FROM $3)) AS "things"
GROUP BY date_trunc('quarter', "things"."__t")
ORDER BY "bucket" ASC NULLS LAST
LIMIT 5000;

-- {"kind":"series","measure":"things","grain":"year"}
-- params: ["ke_1","ke\\_1.%","test"]
SELECT date_trunc('year', "things"."__t") AS "bucket", count(*) AS "value", count(*) AS "n"
FROM (SELECT *, "made_at" AS "__t" FROM "app"."things" WHERE ((("tenant_id" = $1) OR ("tenant_id" LIKE $2 ESCAPE '\'))) AND (deleted = false) AND ("kind" IS DISTINCT FROM $3)) AS "things"
GROUP BY date_trunc('year', "things"."__t")
ORDER BY "bucket" ASC NULLS LAST
LIMIT 5000;

-- {"kind":"series","measure":"weight","grain":"week","by":"tier","time":{"last":"12w"}}
-- params: ["ke_1","ke\\_1.%","test","2025-11-23 12:34:56.000","2026-02-15 12:34:56.000"]
SELECT date_trunc('week', "things"."__t") AS "bucket", "owners"."__d_tier" AS "series", sum("things"."__m_weight") AS "value", count(*) AS "n"
FROM (SELECT *, "made_at" AS "__t", (weight_g / 1000.0) AS "__m_weight" FROM "app"."things" WHERE ((("tenant_id" = $1) OR ("tenant_id" LIKE $2 ESCAPE '\'))) AND (deleted = false) AND ("kind" IS DISTINCT FROM $3)) AS "things"
LEFT JOIN (SELECT *, (upper(tier)) AS "__d_tier" FROM "Owners") AS "owners" ON "things"."owner_id" = "owners"."id"
WHERE (("things"."__t" >= CAST($4 AS TIMESTAMP)) AND ("things"."__t" < CAST($5 AS TIMESTAMP)))
GROUP BY date_trunc('week', "things"."__t"), "owners"."__d_tier"
ORDER BY "bucket" ASC NULLS LAST, "series" ASC NULLS LAST
LIMIT 5000;

-- {"kind":"series","measure":"parts","grain":"day","time":{"last":"60d"}}
-- params: ["ke_1","1765974896000n","1771158896000n"]
SELECT date_trunc('day', "parts"."__t") AS "bucket", count(*) AS "value", count(*) AS "n"
FROM (SELECT *, epoch_ms(CAST("added_ms" AS BIGINT)) AS "__t", "added_ms" AS "__t_raw" FROM "parts" WHERE ("tenant_id" = $1)) AS "parts"
WHERE (("parts"."__t_raw" >= CAST($2 AS BIGINT)) AND ("parts"."__t_raw" < CAST($3 AS BIGINT)))
GROUP BY date_trunc('day', "parts"."__t")
ORDER BY "bucket" ASC NULLS LAST
LIMIT 5000;

-- {"kind":"series","measure":"logs","grain":"month"}
-- params: []
SELECT date_trunc('month', "logs"."__t") AS "bucket", count(*) AS "value", count(*) AS "n"
FROM (SELECT *, epoch_ms(CAST("at_s" AS BIGINT) * 1000) AS "__t", "at_s" AS "__t_raw" FROM "logs") AS "logs"
GROUP BY date_trunc('month', "logs"."__t")
ORDER BY "bucket" ASC NULLS LAST
LIMIT 5000;

-- {"kind":"series","measure":"events","grain":"hour","time":{"last":"2d"}}
-- params: ["2026-02-13 12:34:56.000","2026-02-15 12:34:56.000"]
SELECT date_trunc('hour', "events"."__t") AS "bucket", count(*) AS "value", count(*) AS "n"
FROM (SELECT *, (to_timestamp(t)) AS "__t" FROM "events") AS "events"
WHERE (("events"."__t" >= CAST($1 AS TIMESTAMP)) AND ("events"."__t" < CAST($2 AS TIMESTAMP)))
GROUP BY date_trunc('hour', "events"."__t")
ORDER BY "bucket" ASC NULLS LAST
LIMIT 5000;

-- {"kind":"value","measure":"things","filters":[{"dimension":"colour","op":"eq","value":"red"},{"dimension":"colour","op":"neq","value":"blue"},{"dimension":"size","op":"gte","value":10},{"dimension":"size","op":"lte","value":90},{"dimension":"colour","op":"in","value":["red","green"]},{"dimension":"size","op":"between","value":[20,40]},{"dimension":"path","op":"segment","value":["B%1","C"]},{"dimension":"path","op":"subtree","value":"a_b"},{"dimension":"colour","op":"contains","value":"E%D"},{"dimension":"tier","op":"eq","value":"GOLD"}]}
-- params: ["ke_1","ke\\_1.%","test","red","blue",10,90,"red","green",20,40,"B%1","C","a_b","a\\_b.%","%E\\%D%","GOLD"]
SELECT count(*) AS "value", count(*) AS "n"
FROM (SELECT *, "made_at" AS "__t", (colour) AS "__d_colour", "size" AS "__d_size", "path" AS "__d_path" FROM "app"."things" WHERE ((("tenant_id" = $1) OR ("tenant_id" LIKE $2 ESCAPE '\'))) AND (deleted = false) AND ("kind" IS DISTINCT FROM $3)) AS "things"
LEFT JOIN (SELECT *, (upper(tier)) AS "__d_tier" FROM "Owners") AS "owners" ON "things"."owner_id" = "owners"."id"
WHERE ("things"."__d_colour" = $4) AND ("things"."__d_colour" <> $5) AND ("things"."__d_size" >= $6) AND ("things"."__d_size" <= $7) AND ("things"."__d_colour" IN ($8, $9)) AND (("things"."__d_size" >= $10) AND ("things"."__d_size" <= $11)) AND list_has_any(string_split(CAST("things"."__d_path" AS VARCHAR), '|'), [$12, $13]) AND ((("things"."__d_path" = $14) OR ("things"."__d_path" LIKE $15 ESCAPE '\'))) AND (CAST("things"."__d_colour" AS VARCHAR) ILIKE $16 ESCAPE '\') AND ("owners"."__d_tier" = $17)
LIMIT 1;

-- {"kind":"rows","entity":"things","columns":["colour","size","origin"],"limit":4,"orderBy":{"key":"size","dir":"desc"}}
-- params: ["ke_1","ke\\_1.%","test"]
SELECT "things"."__d_colour" AS "colour", "things"."__d_size" AS "size", "things"."__d_origin" AS "origin"
FROM (SELECT *, "made_at" AS "__t", (colour) AS "__d_colour", "size" AS "__d_size", json_extract_string("attrs", '$."origin"') AS "__d_origin" FROM "app"."things" WHERE ((("tenant_id" = $1) OR ("tenant_id" LIKE $2 ESCAPE '\'))) AND (deleted = false) AND ("kind" IS DISTINCT FROM $3)) AS "things"
ORDER BY "things"."__d_size" DESC NULLS LAST, "things"."__d_colour" ASC NULLS LAST, "things"."__d_origin" ASC NULLS LAST
LIMIT 4;

-- {"kind":"rows","entity":"things","columns":["colour","nested"],"limit":20}
-- params: ["ke_1","ke\\_1.%","test"]
SELECT "things"."__d_colour" AS "colour", "things"."__d_nested" AS "nested"
FROM (SELECT *, "made_at" AS "__t", (colour) AS "__d_colour", json_extract_string("attrs", '$."meta"."grade"') AS "__d_nested" FROM "app"."things" WHERE ((("tenant_id" = $1) OR ("tenant_id" LIKE $2 ESCAPE '\'))) AND (deleted = false) AND ("kind" IS DISTINCT FROM $3)) AS "things"
LIMIT 20;
