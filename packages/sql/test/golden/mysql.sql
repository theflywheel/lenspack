-- {"kind":"breakdown","dimension":"colour","measure":"things","limit":10,"sort":"desc"}
-- params: ["ke_1","ke\\_1.%","test"]
SELECT `things`.`__d_colour` AS `group`, count(*) AS `value`, count(*) AS `n`
FROM (SELECT *, `made_at` AS `__t`, (colour) AS `__d_colour` FROM `app`.`things` WHERE (((`tenant_id` = ?) OR (`tenant_id` LIKE ?))) AND (deleted = false) AND (NOT (`kind` <=> ?))) AS `things`
GROUP BY `things`.`__d_colour`
ORDER BY `value` DESC, `group` IS NULL, `group` ASC
LIMIT 10;

-- {"kind":"breakdown","dimension":"colour","measure":"weight","limit":10,"sort":"asc","sortBy":"group"}
-- params: ["ke_1","ke\\_1.%","test"]
SELECT `things`.`__d_colour` AS `group`, sum(`things`.`__m_weight`) AS `value`, count(*) AS `n`
FROM (SELECT *, `made_at` AS `__t`, (colour) AS `__d_colour`, (weight_g / 1000.0) AS `__m_weight` FROM `app`.`things` WHERE (((`tenant_id` = ?) OR (`tenant_id` LIKE ?))) AND (deleted = false) AND (NOT (`kind` <=> ?))) AS `things`
GROUP BY `things`.`__d_colour`
ORDER BY `group` IS NULL, `group` ASC
LIMIT 10;

-- {"kind":"breakdown","dimension":"colour","measure":"broken","limit":10,"sort":"desc","sortBy":"measure"}
-- params: ["ke_1","ke\\_1.%","test"]
SELECT `things`.`__d_colour` AS `group`, count(`things`.`__m_broken`) AS `value`, count(*) AS `n`
FROM (SELECT *, `made_at` AS `__t`, (colour) AS `__d_colour`, CASE WHEN (status = 'broken') THEN 1 END AS `__m_broken` FROM `app`.`things` WHERE (((`tenant_id` = ?) OR (`tenant_id` LIKE ?))) AND (deleted = false) AND (NOT (`kind` <=> ?))) AS `things`
GROUP BY `things`.`__d_colour`
ORDER BY `value` DESC
LIMIT 10;

-- {"kind":"breakdown","dimension":"colour","measure":"big","limit":10,"sort":"desc","sortBy":"none"}
-- params: [30,"red","blue","ke_1","ke\\_1.%","test"]
SELECT `things`.`__d_colour` AS `group`, count(`things`.`__m_big`) AS `value`, count(*) AS `n`
FROM (SELECT *, `made_at` AS `__t`, (colour) AS `__d_colour`, CASE WHEN ((`size` >= ?) AND (`colour` IN (?, ?))) THEN 1 END AS `__m_big` FROM `app`.`things` WHERE (((`tenant_id` = ?) OR (`tenant_id` LIKE ?))) AND (deleted = false) AND (NOT (`kind` <=> ?))) AS `things`
GROUP BY `things`.`__d_colour`
LIMIT 10;

-- {"kind":"breakdown","dimension":"tier","measure":"sized","by":"colour","limit":10,"sort":"desc"}
-- params: ["ke_1","ke\\_1.%","test"]
SELECT `owners`.`__d_tier` AS `group`, `things`.`__d_colour` AS `series`, count(`things`.`__m_sized`) AS `value`, count(*) AS `n`
FROM (SELECT *, `made_at` AS `__t`, (colour) AS `__d_colour`, `size` AS `__m_sized` FROM `app`.`things` WHERE (((`tenant_id` = ?) OR (`tenant_id` LIKE ?))) AND (deleted = false) AND (NOT (`kind` <=> ?))) AS `things`
LEFT JOIN (SELECT *, (upper(tier)) AS `__d_tier` FROM `Owners`) AS `owners` ON `things`.`owner_id` = `owners`.`id`
GROUP BY `owners`.`__d_tier`, `things`.`__d_colour`
ORDER BY `value` DESC, `group` IS NULL, `group` ASC, `series` IS NULL, `series` ASC
LIMIT 10;

-- {"kind":"breakdown","dimension":"origin","measure":"labelled","limit":10,"sort":"desc"}
-- params: [99,"ke_1","ke\\_1.%","test"]
SELECT `things`.`__d_origin` AS `group`, count(`things`.`__m_labelled`) AS `value`, count(*) AS `n`
FROM (SELECT *, `made_at` AS `__t`, JSON_UNQUOTE(JSON_EXTRACT(`attrs`, '$."origin"')) AS `__d_origin`, CASE WHEN (((`label` IS NOT NULL) AND (`note` IS NULL)) AND (`size` < ?)) THEN 1 END AS `__m_labelled` FROM `app`.`things` WHERE (((`tenant_id` = ?) OR (`tenant_id` LIKE ?))) AND (deleted = false) AND (NOT (`kind` <=> ?))) AS `things`
GROUP BY `things`.`__d_origin`
ORDER BY `value` DESC, `group` IS NULL, `group` ASC
LIMIT 10;

-- {"kind":"breakdown","dimension":"nested","measure":"light","limit":10,"sort":"desc"}
-- params: [10,1,"red","ke_1","ke\\_1.%","test"]
SELECT `things`.`__d_nested` AS `group`, count(`things`.`__m_light`) AS `value`, count(*) AS `n`
FROM (SELECT *, `made_at` AS `__t`, JSON_UNQUOTE(JSON_EXTRACT(`attrs`, '$."meta"."grade"')) AS `__d_nested`, CASE WHEN (((`size` <= ?) AND (`size` > ?)) AND (`colour` = ?)) THEN 1 END AS `__m_light` FROM `app`.`things` WHERE (((`tenant_id` = ?) OR (`tenant_id` LIKE ?))) AND (deleted = false) AND (NOT (`kind` <=> ?))) AS `things`
GROUP BY `things`.`__d_nested`
ORDER BY `value` DESC, `group` IS NULL, `group` ASC
LIMIT 10;

-- {"kind":"breakdown","dimension":"colour","measure":"parts","limit":10,"sort":"desc","time":{"last":"30d"}}
-- params: ["ke_1","ke_1","ke\\_1.%","test",1768566896000,1771158896000]
SELECT `things`.`__d_colour` AS `group`, count(*) AS `value`, count(*) AS `n`
FROM (SELECT *, TIMESTAMPADD(MICROSECOND, CAST(`added_ms` AS SIGNED) * 1000, TIMESTAMP '1970-01-01 00:00:00') AS `__t`, `added_ms` AS `__t_raw` FROM `parts` WHERE (`tenant_id` = ?)) AS `parts`
LEFT JOIN (SELECT *, `made_at` AS `__t`, (colour) AS `__d_colour` FROM `app`.`things` WHERE (((`tenant_id` = ?) OR (`tenant_id` LIKE ?))) AND (deleted = false) AND (NOT (`kind` <=> ?))) AS `things` ON `parts`.`thing_id` = `things`.`id`
WHERE ((`parts`.`__t_raw` >= CAST(? AS SIGNED)) AND (`parts`.`__t_raw` < CAST(? AS SIGNED)))
GROUP BY `things`.`__d_colour`
ORDER BY `value` DESC, `group` IS NULL, `group` ASC
LIMIT 10;

-- {"kind":"breakdown","dimension":"level","measure":"logs","limit":10,"sort":"desc","time":{"from":"2026-01-01T00:00:00Z","to":"2026-02-01T00:00:00Z"}}
-- params: [1767225600,1769904000]
SELECT `logs`.`__d_level` AS `group`, count(*) AS `value`, count(*) AS `n`
FROM (SELECT *, TIMESTAMPADD(SECOND, CAST(`at_s` AS SIGNED), TIMESTAMP '1970-01-01 00:00:00') AS `__t`, `at_s` AS `__t_raw`, `level` AS `__d_level` FROM `logs`) AS `logs`
WHERE ((`logs`.`__t_raw` >= CAST(? AS SIGNED)) AND (`logs`.`__t_raw` < CAST(? AS SIGNED)))
GROUP BY `logs`.`__d_level`
ORDER BY `value` DESC, `group` IS NULL, `group` ASC
LIMIT 10;

-- {"kind":"value","measure":"avg_size"}
-- params: ["ke_1","ke\\_1.%","test"]
SELECT avg(CAST(`things`.`__m_avg_size` AS DOUBLE)) AS `value`, count(*) AS `n`
FROM (SELECT *, `made_at` AS `__t`, `size` AS `__m_avg_size` FROM `app`.`things` WHERE (((`tenant_id` = ?) OR (`tenant_id` LIKE ?))) AND (deleted = false) AND (NOT (`kind` <=> ?))) AS `things`
LIMIT 1;

-- {"kind":"value","measure":"min_size"}
-- params: ["ke_1","ke\\_1.%","test"]
SELECT min(`things`.`__m_min_size`) AS `value`, count(*) AS `n`
FROM (SELECT *, `made_at` AS `__t`, `size` AS `__m_min_size` FROM `app`.`things` WHERE (((`tenant_id` = ?) OR (`tenant_id` LIKE ?))) AND (deleted = false) AND (NOT (`kind` <=> ?))) AS `things`
LIMIT 1;

-- {"kind":"value","measure":"max_size"}
-- params: ["ke_1","ke\\_1.%","test"]
SELECT max(`things`.`__m_max_size`) AS `value`, count(*) AS `n`
FROM (SELECT *, `made_at` AS `__t`, `size` AS `__m_max_size` FROM `app`.`things` WHERE (((`tenant_id` = ?) OR (`tenant_id` LIKE ?))) AND (deleted = false) AND (NOT (`kind` <=> ?))) AS `things`
LIMIT 1;

-- {"kind":"value","measure":"median_size"}
-- refused (NOT_SUPPORTED): "median_size" is a median, and this source has no percentile function, so it is not computed here

-- {"kind":"value","measure":"p90_size"}
-- refused (NOT_SUPPORTED): "p90_size" is a 90th percentile, and this source has no percentile function, so it is not computed here

-- {"kind":"value","measure":"distinct_owners"}
-- params: ["ke_1","ke\\_1.%","test"]
SELECT count(DISTINCT `things`.`__m_distinct_owners`) AS `value`, count(*) AS `n`
FROM (SELECT *, `made_at` AS `__t`, (owner_id) AS `__m_distinct_owners` FROM `app`.`things` WHERE (((`tenant_id` = ?) OR (`tenant_id` LIKE ?))) AND (deleted = false) AND (NOT (`kind` <=> ?))) AS `things`
LIMIT 1;

-- {"kind":"value","measure":"scaled"}
-- params: ["ke_1","ke\\_1.%","test"]
SELECT (CAST(sum(`things`.`__m_scaled`) AS DOUBLE) * 1.8) AS `value`, count(*) AS `n`
FROM (SELECT *, `made_at` AS `__t`, `size` AS `__m_scaled` FROM `app`.`things` WHERE (((`tenant_id` = ?) OR (`tenant_id` LIKE ?))) AND (deleted = false) AND (NOT (`kind` <=> ?))) AS `things`
LIMIT 1;

-- {"kind":"value","measure":"per_thing"}
-- params: ["ke_1","ke\\_1.%","test"]
SELECT (((CAST(sum(`things`.`__m_weight`) AS DOUBLE) - CAST(count(`things`.`__m_broken`) AS DOUBLE)) / NULLIF(CAST(count(*) AS DOUBLE), 0)) * 100) AS `value`, count(*) AS `n`
FROM (SELECT *, `made_at` AS `__t`, (weight_g / 1000.0) AS `__m_weight`, CASE WHEN (status = 'broken') THEN 1 END AS `__m_broken` FROM `app`.`things` WHERE (((`tenant_id` = ?) OR (`tenant_id` LIKE ?))) AND (deleted = false) AND (NOT (`kind` <=> ?))) AS `things`
LIMIT 1;

-- {"kind":"value","measure":"negated"}
-- params: ["ke_1","ke\\_1.%","test"]
SELECT ((-1 * CAST(sum(`things`.`__m_weight`) AS DOUBLE)) + 1) AS `value`, count(*) AS `n`
FROM (SELECT *, `made_at` AS `__t`, (weight_g / 1000.0) AS `__m_weight` FROM `app`.`things` WHERE (((`tenant_id` = ?) OR (`tenant_id` LIKE ?))) AND (deleted = false) AND (NOT (`kind` <=> ?))) AS `things`
LIMIT 1;

-- {"kind":"value","measure":"owners"}
-- params: []
SELECT count(*) AS `value`, count(*) AS `n`
FROM (SELECT * FROM `Owners`) AS `owners`
LIMIT 1;

-- {"kind":"value","measure":"events","time":{"last":"7d"}}
-- params: ["2026-02-08 12:34:56.000","2026-02-15 12:34:56.000"]
SELECT count(*) AS `value`, count(*) AS `n`
FROM (SELECT *, (TIMESTAMPADD(SECOND, t, TIMESTAMP '1970-01-01 00:00:00')) AS `__t` FROM `events`) AS `events`
WHERE ((`events`.`__t` >= CAST(? AS DATETIME(3))) AND (`events`.`__t` < CAST(? AS DATETIME(3))))
LIMIT 1;

-- {"kind":"value","measure":"weight","compare":"previous_period","time":{"last":"30d"}}
-- params: ["2026-01-16 12:34:56.000","2026-02-15 12:34:56.000","2026-01-16 12:34:56.000","2026-02-15 12:34:56.000","2025-12-17 12:34:56.000","2026-01-16 12:34:56.000","ke_1","ke\\_1.%","test","2025-12-17 12:34:56.000","2026-02-15 12:34:56.000"]
SELECT sum(CASE WHEN ((`things`.`__t` >= CAST(? AS DATETIME(3))) AND (`things`.`__t` < CAST(? AS DATETIME(3)))) THEN `things`.`__m_weight` END) AS `value`, count(CASE WHEN ((`things`.`__t` >= CAST(? AS DATETIME(3))) AND (`things`.`__t` < CAST(? AS DATETIME(3)))) THEN 1 END) AS `n`, sum(CASE WHEN ((`things`.`__t` >= CAST(? AS DATETIME(3))) AND (`things`.`__t` < CAST(? AS DATETIME(3)))) THEN `things`.`__m_weight` END) AS `previous`
FROM (SELECT *, `made_at` AS `__t`, (weight_g / 1000.0) AS `__m_weight` FROM `app`.`things` WHERE (((`tenant_id` = ?) OR (`tenant_id` LIKE ?))) AND (deleted = false) AND (NOT (`kind` <=> ?))) AS `things`
WHERE (`things`.`__t` >= CAST(? AS DATETIME(3))) AND (`things`.`__t` < CAST(? AS DATETIME(3)))
LIMIT 1;

-- {"kind":"value","measure":"parts","compare":"previous_period","time":{"from":"2026-01-01T00:00:00Z","to":"2026-02-01T00:00:00Z"}}
-- params: [1767225600000,1769904000000,1767225600000,1769904000000,1764547200000,1767225600000,"ke_1",1764547200000,1769904000000]
SELECT count(CASE WHEN ((`parts`.`__t_raw` >= CAST(? AS SIGNED)) AND (`parts`.`__t_raw` < CAST(? AS SIGNED))) THEN 1 END) AS `value`, count(CASE WHEN ((`parts`.`__t_raw` >= CAST(? AS SIGNED)) AND (`parts`.`__t_raw` < CAST(? AS SIGNED))) THEN 1 END) AS `n`, count(CASE WHEN ((`parts`.`__t_raw` >= CAST(? AS SIGNED)) AND (`parts`.`__t_raw` < CAST(? AS SIGNED))) THEN 1 END) AS `previous`
FROM (SELECT *, TIMESTAMPADD(MICROSECOND, CAST(`added_ms` AS SIGNED) * 1000, TIMESTAMP '1970-01-01 00:00:00') AS `__t`, `added_ms` AS `__t_raw` FROM `parts` WHERE (`tenant_id` = ?)) AS `parts`
WHERE (`parts`.`__t_raw` >= CAST(? AS SIGNED)) AND (`parts`.`__t_raw` < CAST(? AS SIGNED))
LIMIT 1;

-- {"kind":"value","measure":"logs","compare":"previous_period","time":{"from":"2026-01-01T00:00:00Z","to":"2026-02-01T00:00:00Z"}}
-- params: [1767225600,1769904000,1767225600,1769904000,1764547200,1767225600,1764547200,1769904000]
SELECT count(CASE WHEN ((`logs`.`__t_raw` >= CAST(? AS SIGNED)) AND (`logs`.`__t_raw` < CAST(? AS SIGNED))) THEN 1 END) AS `value`, count(CASE WHEN ((`logs`.`__t_raw` >= CAST(? AS SIGNED)) AND (`logs`.`__t_raw` < CAST(? AS SIGNED))) THEN 1 END) AS `n`, count(CASE WHEN ((`logs`.`__t_raw` >= CAST(? AS SIGNED)) AND (`logs`.`__t_raw` < CAST(? AS SIGNED))) THEN 1 END) AS `previous`
FROM (SELECT *, TIMESTAMPADD(SECOND, CAST(`at_s` AS SIGNED), TIMESTAMP '1970-01-01 00:00:00') AS `__t`, `at_s` AS `__t_raw` FROM `logs`) AS `logs`
WHERE (`logs`.`__t_raw` >= CAST(? AS SIGNED)) AND (`logs`.`__t_raw` < CAST(? AS SIGNED))
LIMIT 1;

-- {"kind":"value","measure":"broken","compare":"previous_period","time":{"from":"2026-01-01T00:00:00Z","to":"2026-02-01T00:00:00Z"}}
-- params: ["2026-01-01 00:00:00.000","2026-02-01 00:00:00.000","2026-01-01 00:00:00.000","2026-02-01 00:00:00.000","2025-12-01 00:00:00.000","2026-01-01 00:00:00.000","ke_1","ke\\_1.%","test","2025-12-01 00:00:00.000","2026-02-01 00:00:00.000"]
SELECT count(CASE WHEN ((`things`.`__t` >= CAST(? AS DATETIME(3))) AND (`things`.`__t` < CAST(? AS DATETIME(3)))) THEN `things`.`__m_broken` END) AS `value`, count(CASE WHEN ((`things`.`__t` >= CAST(? AS DATETIME(3))) AND (`things`.`__t` < CAST(? AS DATETIME(3)))) THEN 1 END) AS `n`, count(CASE WHEN ((`things`.`__t` >= CAST(? AS DATETIME(3))) AND (`things`.`__t` < CAST(? AS DATETIME(3)))) THEN `things`.`__m_broken` END) AS `previous`
FROM (SELECT *, `made_at` AS `__t`, CASE WHEN (status = 'broken') THEN 1 END AS `__m_broken` FROM `app`.`things` WHERE (((`tenant_id` = ?) OR (`tenant_id` LIKE ?))) AND (deleted = false) AND (NOT (`kind` <=> ?))) AS `things`
WHERE (`things`.`__t` >= CAST(? AS DATETIME(3))) AND (`things`.`__t` < CAST(? AS DATETIME(3)))
LIMIT 1;

-- {"kind":"series","measure":"things","grain":"hour"}
-- params: ["ke_1","ke\\_1.%","test"]
SELECT CAST(DATE_FORMAT(`things`.`__t`, '%Y-%m-%d %H:00:00') AS DATETIME) AS `bucket`, count(*) AS `value`, count(*) AS `n`
FROM (SELECT *, `made_at` AS `__t` FROM `app`.`things` WHERE (((`tenant_id` = ?) OR (`tenant_id` LIKE ?))) AND (deleted = false) AND (NOT (`kind` <=> ?))) AS `things`
GROUP BY CAST(DATE_FORMAT(`things`.`__t`, '%Y-%m-%d %H:00:00') AS DATETIME)
ORDER BY `bucket` IS NULL, `bucket` ASC
LIMIT 5000;

-- {"kind":"series","measure":"things","grain":"day"}
-- params: ["ke_1","ke\\_1.%","test"]
SELECT CAST(DATE(`things`.`__t`) AS DATETIME) AS `bucket`, count(*) AS `value`, count(*) AS `n`
FROM (SELECT *, `made_at` AS `__t` FROM `app`.`things` WHERE (((`tenant_id` = ?) OR (`tenant_id` LIKE ?))) AND (deleted = false) AND (NOT (`kind` <=> ?))) AS `things`
GROUP BY CAST(DATE(`things`.`__t`) AS DATETIME)
ORDER BY `bucket` IS NULL, `bucket` ASC
LIMIT 5000;

-- {"kind":"series","measure":"things","grain":"week"}
-- params: ["ke_1","ke\\_1.%","test"]
SELECT CAST(DATE_SUB(DATE(`things`.`__t`), INTERVAL WEEKDAY(`things`.`__t`) DAY) AS DATETIME) AS `bucket`, count(*) AS `value`, count(*) AS `n`
FROM (SELECT *, `made_at` AS `__t` FROM `app`.`things` WHERE (((`tenant_id` = ?) OR (`tenant_id` LIKE ?))) AND (deleted = false) AND (NOT (`kind` <=> ?))) AS `things`
GROUP BY CAST(DATE_SUB(DATE(`things`.`__t`), INTERVAL WEEKDAY(`things`.`__t`) DAY) AS DATETIME)
ORDER BY `bucket` IS NULL, `bucket` ASC
LIMIT 5000;

-- {"kind":"series","measure":"things","grain":"month"}
-- params: ["ke_1","ke\\_1.%","test"]
SELECT CAST(DATE_FORMAT(`things`.`__t`, '%Y-%m-01') AS DATETIME) AS `bucket`, count(*) AS `value`, count(*) AS `n`
FROM (SELECT *, `made_at` AS `__t` FROM `app`.`things` WHERE (((`tenant_id` = ?) OR (`tenant_id` LIKE ?))) AND (deleted = false) AND (NOT (`kind` <=> ?))) AS `things`
GROUP BY CAST(DATE_FORMAT(`things`.`__t`, '%Y-%m-01') AS DATETIME)
ORDER BY `bucket` IS NULL, `bucket` ASC
LIMIT 5000;

-- {"kind":"series","measure":"things","grain":"quarter"}
-- params: ["ke_1","ke\\_1.%","test"]
SELECT CAST(MAKEDATE(YEAR(`things`.`__t`), 1) + INTERVAL (QUARTER(`things`.`__t`) - 1) QUARTER AS DATETIME) AS `bucket`, count(*) AS `value`, count(*) AS `n`
FROM (SELECT *, `made_at` AS `__t` FROM `app`.`things` WHERE (((`tenant_id` = ?) OR (`tenant_id` LIKE ?))) AND (deleted = false) AND (NOT (`kind` <=> ?))) AS `things`
GROUP BY CAST(MAKEDATE(YEAR(`things`.`__t`), 1) + INTERVAL (QUARTER(`things`.`__t`) - 1) QUARTER AS DATETIME)
ORDER BY `bucket` IS NULL, `bucket` ASC
LIMIT 5000;

-- {"kind":"series","measure":"things","grain":"year"}
-- params: ["ke_1","ke\\_1.%","test"]
SELECT CAST(MAKEDATE(YEAR(`things`.`__t`), 1) AS DATETIME) AS `bucket`, count(*) AS `value`, count(*) AS `n`
FROM (SELECT *, `made_at` AS `__t` FROM `app`.`things` WHERE (((`tenant_id` = ?) OR (`tenant_id` LIKE ?))) AND (deleted = false) AND (NOT (`kind` <=> ?))) AS `things`
GROUP BY CAST(MAKEDATE(YEAR(`things`.`__t`), 1) AS DATETIME)
ORDER BY `bucket` IS NULL, `bucket` ASC
LIMIT 5000;

-- {"kind":"series","measure":"weight","grain":"week","by":"tier","time":{"last":"12w"}}
-- params: ["ke_1","ke\\_1.%","test","2025-11-23 12:34:56.000","2026-02-15 12:34:56.000"]
SELECT CAST(DATE_SUB(DATE(`things`.`__t`), INTERVAL WEEKDAY(`things`.`__t`) DAY) AS DATETIME) AS `bucket`, `owners`.`__d_tier` AS `series`, sum(`things`.`__m_weight`) AS `value`, count(*) AS `n`
FROM (SELECT *, `made_at` AS `__t`, (weight_g / 1000.0) AS `__m_weight` FROM `app`.`things` WHERE (((`tenant_id` = ?) OR (`tenant_id` LIKE ?))) AND (deleted = false) AND (NOT (`kind` <=> ?))) AS `things`
LEFT JOIN (SELECT *, (upper(tier)) AS `__d_tier` FROM `Owners`) AS `owners` ON `things`.`owner_id` = `owners`.`id`
WHERE ((`things`.`__t` >= CAST(? AS DATETIME(3))) AND (`things`.`__t` < CAST(? AS DATETIME(3))))
GROUP BY CAST(DATE_SUB(DATE(`things`.`__t`), INTERVAL WEEKDAY(`things`.`__t`) DAY) AS DATETIME), `owners`.`__d_tier`
ORDER BY `bucket` IS NULL, `bucket` ASC, `series` IS NULL, `series` ASC
LIMIT 5000;

-- {"kind":"series","measure":"parts","grain":"day","time":{"last":"60d"}}
-- params: ["ke_1",1765974896000,1771158896000]
SELECT CAST(DATE(`parts`.`__t`) AS DATETIME) AS `bucket`, count(*) AS `value`, count(*) AS `n`
FROM (SELECT *, TIMESTAMPADD(MICROSECOND, CAST(`added_ms` AS SIGNED) * 1000, TIMESTAMP '1970-01-01 00:00:00') AS `__t`, `added_ms` AS `__t_raw` FROM `parts` WHERE (`tenant_id` = ?)) AS `parts`
WHERE ((`parts`.`__t_raw` >= CAST(? AS SIGNED)) AND (`parts`.`__t_raw` < CAST(? AS SIGNED)))
GROUP BY CAST(DATE(`parts`.`__t`) AS DATETIME)
ORDER BY `bucket` IS NULL, `bucket` ASC
LIMIT 5000;

-- {"kind":"series","measure":"logs","grain":"month"}
-- params: []
SELECT CAST(DATE_FORMAT(`logs`.`__t`, '%Y-%m-01') AS DATETIME) AS `bucket`, count(*) AS `value`, count(*) AS `n`
FROM (SELECT *, TIMESTAMPADD(SECOND, CAST(`at_s` AS SIGNED), TIMESTAMP '1970-01-01 00:00:00') AS `__t`, `at_s` AS `__t_raw` FROM `logs`) AS `logs`
GROUP BY CAST(DATE_FORMAT(`logs`.`__t`, '%Y-%m-01') AS DATETIME)
ORDER BY `bucket` IS NULL, `bucket` ASC
LIMIT 5000;

-- {"kind":"series","measure":"events","grain":"hour","time":{"last":"2d"}}
-- params: ["2026-02-13 12:34:56.000","2026-02-15 12:34:56.000"]
SELECT CAST(DATE_FORMAT(`events`.`__t`, '%Y-%m-%d %H:00:00') AS DATETIME) AS `bucket`, count(*) AS `value`, count(*) AS `n`
FROM (SELECT *, (TIMESTAMPADD(SECOND, t, TIMESTAMP '1970-01-01 00:00:00')) AS `__t` FROM `events`) AS `events`
WHERE ((`events`.`__t` >= CAST(? AS DATETIME(3))) AND (`events`.`__t` < CAST(? AS DATETIME(3))))
GROUP BY CAST(DATE_FORMAT(`events`.`__t`, '%Y-%m-%d %H:00:00') AS DATETIME)
ORDER BY `bucket` IS NULL, `bucket` ASC
LIMIT 5000;

-- {"kind":"value","measure":"things","filters":[{"dimension":"colour","op":"eq","value":"red"},{"dimension":"colour","op":"neq","value":"blue"},{"dimension":"size","op":"gte","value":10},{"dimension":"size","op":"lte","value":90},{"dimension":"colour","op":"in","value":["red","green"]},{"dimension":"size","op":"between","value":[20,40]},{"dimension":"path","op":"segment","value":["B%1","C"]},{"dimension":"path","op":"subtree","value":"a_b"},{"dimension":"colour","op":"contains","value":"E%D"},{"dimension":"tier","op":"eq","value":"GOLD"}]}
-- params: ["ke_1","ke\\_1.%","test","red","blue",10,90,"red","green",20,40,"B%1","C","a_b","a\\_b.%","%E\\%D%","GOLD"]
SELECT count(*) AS `value`, count(*) AS `n`
FROM (SELECT *, `made_at` AS `__t`, (colour) AS `__d_colour`, `size` AS `__d_size`, `path` AS `__d_path` FROM `app`.`things` WHERE (((`tenant_id` = ?) OR (`tenant_id` LIKE ?))) AND (deleted = false) AND (NOT (`kind` <=> ?))) AS `things`
LEFT JOIN (SELECT *, (upper(tier)) AS `__d_tier` FROM `Owners`) AS `owners` ON `things`.`owner_id` = `owners`.`id`
WHERE (`things`.`__d_colour` = ?) AND (`things`.`__d_colour` <> ?) AND (`things`.`__d_size` >= ?) AND (`things`.`__d_size` <= ?) AND (`things`.`__d_colour` IN (?, ?)) AND ((`things`.`__d_size` >= ?) AND (`things`.`__d_size` <= ?)) AND (LOCATE(CONCAT('|', ?, '|'), CONCAT('|', CAST(`things`.`__d_path` AS CHAR), '|')) > 0 OR LOCATE(CONCAT('|', ?, '|'), CONCAT('|', CAST(`things`.`__d_path` AS CHAR), '|')) > 0) AND (((`things`.`__d_path` = ?) OR (`things`.`__d_path` LIKE ?))) AND (LOWER(CAST(`things`.`__d_colour` AS CHAR)) LIKE LOWER(?)) AND (`owners`.`__d_tier` = ?)
LIMIT 1;

-- {"kind":"rows","entity":"things","columns":["colour","size","origin"],"limit":4,"orderBy":{"key":"size","dir":"desc"}}
-- params: ["ke_1","ke\\_1.%","test"]
SELECT `things`.`__d_colour` AS `colour`, `things`.`__d_size` AS `size`, `things`.`__d_origin` AS `origin`
FROM (SELECT *, `made_at` AS `__t`, (colour) AS `__d_colour`, `size` AS `__d_size`, JSON_UNQUOTE(JSON_EXTRACT(`attrs`, '$."origin"')) AS `__d_origin` FROM `app`.`things` WHERE (((`tenant_id` = ?) OR (`tenant_id` LIKE ?))) AND (deleted = false) AND (NOT (`kind` <=> ?))) AS `things`
ORDER BY `things`.`__d_size` DESC, `things`.`__d_colour` IS NULL, `things`.`__d_colour` ASC, `things`.`__d_origin` IS NULL, `things`.`__d_origin` ASC
LIMIT 4;

-- {"kind":"rows","entity":"things","columns":["colour","nested"],"limit":20}
-- params: ["ke_1","ke\\_1.%","test"]
SELECT `things`.`__d_colour` AS `colour`, `things`.`__d_nested` AS `nested`
FROM (SELECT *, `made_at` AS `__t`, (colour) AS `__d_colour`, JSON_UNQUOTE(JSON_EXTRACT(`attrs`, '$."meta"."grade"')) AS `__d_nested` FROM `app`.`things` WHERE (((`tenant_id` = ?) OR (`tenant_id` LIKE ?))) AND (deleted = false) AND (NOT (`kind` <=> ?))) AS `things`
LIMIT 20;
