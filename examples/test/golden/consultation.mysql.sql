-- params: ["dopt","2026-08-11 00:00:00.000","2026-09-01 00:00:00.000"]
SELECT CAST(DATE(`submissions`.`__t`) AS DATETIME) AS `bucket`, `submissions`.`__d_channel` AS `series`, count(*) AS `value`, count(*) AS `n`
FROM (SELECT *, `submitted_at` AS `__t`, (channel) AS `__d_channel` FROM `submissions` WHERE (`tenant_id` = ?)) AS `submissions`
WHERE ((`submissions`.`__t` >= CAST(? AS DATETIME(3))) AND (`submissions`.`__t` < CAST(? AS DATETIME(3))))
GROUP BY CAST(DATE(`submissions`.`__t`) AS DATETIME), `submissions`.`__d_channel`
ORDER BY `bucket` IS NULL, `bucket` ASC, `series` IS NULL, `series` ASC
LIMIT 5000;

-- params: ["dopt","dopt"]
SELECT `submissions`.`__d_channel` AS `group`, avg(CAST(`wait_signal`.`__m_wants_human_rate` AS DOUBLE)) AS `value`, count(*) AS `n`
FROM (SELECT *, (CASE WHEN wants_human THEN 1 ELSE 0 END) AS `__m_wants_human_rate` FROM `v_signal_wait` WHERE (`tenant_id` = ?)) AS `wait_signal`
LEFT JOIN (SELECT *, `submitted_at` AS `__t`, (channel) AS `__d_channel` FROM `submissions` WHERE (`tenant_id` = ?)) AS `submissions` ON `wait_signal`.`submission_id` = `submissions`.`id`
GROUP BY `submissions`.`__d_channel`
ORDER BY `value` DESC, `group` IS NULL, `group` ASC
LIMIT 6;

-- params: ["dopt","dopt"]
SELECT `submissions`.`__d_district` AS `group`, avg(CAST(`wait_signal`.`__m_mean_wait_months` AS DOUBLE)) AS `value`, count(*) AS `n`
FROM (SELECT *, (months_waiting) AS `__m_mean_wait_months` FROM `v_signal_wait` WHERE (`tenant_id` = ?)) AS `wait_signal`
LEFT JOIN (SELECT *, `submitted_at` AS `__t`, JSON_UNQUOTE(JSON_EXTRACT(`metadata`, '$."district"')) AS `__d_district` FROM `submissions` WHERE (`tenant_id` = ?)) AS `submissions` ON `wait_signal`.`submission_id` = `submissions`.`id`
GROUP BY `submissions`.`__d_district`
ORDER BY `value` DESC, `group` IS NULL, `group` ASC
LIMIT 12;

-- params: ["dopt"]
SELECT `submissions`.`__d_age_band` AS `group`, avg(CAST(`theme_of`.`__m_mean_severity` AS DOUBLE)) AS `value`, count(*) AS `n`
FROM (SELECT *, (severity) AS `__m_mean_severity` FROM `v_submission_theme`) AS `theme_of`
LEFT JOIN (SELECT *, `submitted_at` AS `__t`, JSON_UNQUOTE(JSON_EXTRACT(`metadata`, '$."respondent"."age_band"')) AS `__d_age_band` FROM `submissions` WHERE (`tenant_id` = ?)) AS `submissions` ON `theme_of`.`submission_id` = `submissions`.`id`
GROUP BY `submissions`.`__d_age_band`
ORDER BY `value` DESC, `group` IS NULL, `group` ASC
LIMIT 6;

-- params: ["dopt"]
SELECT `submissions`.`__d_district` AS `group`, count(*) AS `value`, count(*) AS `n`
FROM (SELECT *, `submitted_at` AS `__t`, JSON_UNQUOTE(JSON_EXTRACT(`metadata`, '$."district"')) AS `__d_district` FROM `submissions` WHERE (`tenant_id` = ?)) AS `submissions`
GROUP BY `submissions`.`__d_district`
ORDER BY `value` DESC, `group` IS NULL, `group` ASC
LIMIT 12;

-- params: ["dopt"]
SELECT `submissions`.`__d_language` AS `group`, avg(CAST(`submissions`.`__m_flagged_rate` AS DOUBLE)) AS `value`, count(*) AS `n`
FROM (SELECT *, `submitted_at` AS `__t`, (language) AS `__d_language`, (CASE WHEN moderation_status = 'flagged' THEN 1 ELSE 0 END) AS `__m_flagged_rate` FROM `submissions` WHERE (`tenant_id` = ?)) AS `submissions`
GROUP BY `submissions`.`__d_language`
ORDER BY `value` DESC, `group` IS NULL, `group` ASC
LIMIT 5;

-- params: ["dopt"]
SELECT avg(CAST(`submissions`.`__m_flagged_rate` AS DOUBLE)) AS `value`, count(*) AS `n`
FROM (SELECT *, `submitted_at` AS `__t`, (CASE WHEN moderation_status = 'flagged' THEN 1 ELSE 0 END) AS `__m_flagged_rate` FROM `submissions` WHERE (`tenant_id` = ?)) AS `submissions`
LIMIT 1;

-- params: ["dopt"]
SELECT avg(CAST(`submissions`.`__m_redaction_rate` AS DOUBLE)) AS `value`, count(*) AS `n`
FROM (SELECT *, `submitted_at` AS `__t`, (CASE WHEN redacted THEN 1 ELSE 0 END) AS `__m_redaction_rate` FROM `submissions` WHERE (`tenant_id` = ?)) AS `submissions`
LIMIT 1;

-- params: ["dopt"]
SELECT count(*) AS `value`, count(*) AS `n`
FROM (SELECT *, `submitted_at` AS `__t` FROM `submissions` WHERE (`tenant_id` = ?)) AS `submissions`
LIMIT 1;

-- params: []
SELECT `theme_of`.`__d_theme` AS `group`, avg(CAST(`theme_of`.`__m_priority` AS DOUBLE)) AS `value`, count(*) AS `n`
FROM (SELECT *, (theme) AS `__d_theme`, (severity * actionability) AS `__m_priority` FROM `v_submission_theme`) AS `theme_of`
GROUP BY `theme_of`.`__d_theme`
ORDER BY `value` DESC, `group` IS NULL, `group` ASC
LIMIT 10;

-- params: []
SELECT `theme_of`.`__d_theme` AS `group`, count(*) AS `value`, count(*) AS `n`
FROM (SELECT *, (theme) AS `__d_theme` FROM `v_submission_theme`) AS `theme_of`
GROUP BY `theme_of`.`__d_theme`
ORDER BY `value` DESC, `group` IS NULL, `group` ASC
LIMIT 10;
