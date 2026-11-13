-- params: ["2026-06-09 00:00:00.000","2026-09-01 00:00:00.000"]
SELECT CAST(DATE_SUB(DATE(`tickets`.`__t`), INTERVAL WEEKDAY(`tickets`.`__t`) DAY) AS DATETIME) AS `bucket`, avg(CAST(`tickets`.`__m_sla_breach_rate` AS DOUBLE)) AS `value`, count(*) AS `n`
FROM (SELECT *, `created_at` AS `__t`, CASE WHEN (resolved_at IS NOT NULL) THEN (CASE WHEN TIMESTAMPDIFF(MICROSECOND, created_at, resolved_at) / 3.6e9 > sla_hours THEN 1 ELSE 0 END) END AS `__m_sla_breach_rate` FROM `tickets`) AS `tickets`
WHERE ((`tickets`.`__t` >= CAST(? AS DATETIME(3))) AND (`tickets`.`__t` < CAST(? AS DATETIME(3))))
GROUP BY CAST(DATE_SUB(DATE(`tickets`.`__t`), INTERVAL WEEKDAY(`tickets`.`__t`) DAY) AS DATETIME)
ORDER BY `bucket` IS NULL, `bucket` ASC
LIMIT 5000;

-- params: ["2026-08-02 00:00:00.000","2026-09-01 00:00:00.000","2026-08-02 00:00:00.000","2026-09-01 00:00:00.000","2026-07-03 00:00:00.000","2026-08-02 00:00:00.000","2026-07-03 00:00:00.000","2026-09-01 00:00:00.000"]
SELECT avg(CAST(CASE WHEN ((`tickets`.`__t` >= CAST(? AS DATETIME(3))) AND (`tickets`.`__t` < CAST(? AS DATETIME(3)))) THEN `tickets`.`__m_sla_breach_rate` END AS DOUBLE)) AS `value`, count(CASE WHEN ((`tickets`.`__t` >= CAST(? AS DATETIME(3))) AND (`tickets`.`__t` < CAST(? AS DATETIME(3)))) THEN 1 END) AS `n`, avg(CAST(CASE WHEN ((`tickets`.`__t` >= CAST(? AS DATETIME(3))) AND (`tickets`.`__t` < CAST(? AS DATETIME(3)))) THEN `tickets`.`__m_sla_breach_rate` END AS DOUBLE)) AS `previous`
FROM (SELECT *, `created_at` AS `__t`, CASE WHEN (resolved_at IS NOT NULL) THEN (CASE WHEN TIMESTAMPDIFF(MICROSECOND, created_at, resolved_at) / 3.6e9 > sla_hours THEN 1 ELSE 0 END) END AS `__m_sla_breach_rate` FROM `tickets`) AS `tickets`
WHERE (`tickets`.`__t` >= CAST(? AS DATETIME(3))) AND (`tickets`.`__t` < CAST(? AS DATETIME(3)))
LIMIT 1;

-- params: ["p1"]
SELECT `tickets`.`__d_team` AS `team`, `tickets`.`__d_status` AS `status`, `tickets`.`__d_channel` AS `channel`
FROM (SELECT *, `created_at` AS `__t`, (priority) AS `__d_priority`, (team) AS `__d_team`, (status) AS `__d_status`, (channel) AS `__d_channel` FROM `tickets`) AS `tickets`
WHERE (`tickets`.`__d_priority` = ?)
LIMIT 10;

-- params: []
SELECT (CAST(count(`tickets`.`__m_resolved`) AS DOUBLE) / NULLIF(CAST(count(*) AS DOUBLE), 0)) AS `value`, count(*) AS `n`
FROM (SELECT *, `created_at` AS `__t`, CASE WHEN (status = 'resolved') THEN 1 END AS `__m_resolved` FROM `tickets`) AS `tickets`
LIMIT 1;

-- params: []
SELECT CAST(DATE_SUB(DATE(`tickets`.`__t`), INTERVAL WEEKDAY(`tickets`.`__t`) DAY) AS DATETIME) AS `bucket`, `tickets`.`__d_priority` AS `series`, count(*) AS `value`, count(*) AS `n`
FROM (SELECT *, `created_at` AS `__t`, (priority) AS `__d_priority` FROM `tickets`) AS `tickets`
GROUP BY CAST(DATE_SUB(DATE(`tickets`.`__t`), INTERVAL WEEKDAY(`tickets`.`__t`) DAY) AS DATETIME), `tickets`.`__d_priority`
ORDER BY `bucket` IS NULL, `bucket` ASC, `series` IS NULL, `series` ASC
LIMIT 5000;

-- params: []
SELECT `status_history`.`__d_transition` AS `group`, count(*) AS `value`, count(*) AS `n`
FROM (SELECT *, `changed_at` AS `__t`, (status) AS `__d_transition` FROM `status_history`) AS `status_history`
GROUP BY `status_history`.`__d_transition`
ORDER BY `value` DESC, `group` IS NULL, `group` ASC
LIMIT 6;

-- params: []
SELECT `tickets`.`__d_channel` AS `group`, avg(CAST(`tickets`.`__m_mean_first_response_min` AS DOUBLE)) AS `value`, count(*) AS `n`
FROM (SELECT *, `created_at` AS `__t`, (channel) AS `__d_channel`, (first_response_minutes) AS `__m_mean_first_response_min` FROM `tickets`) AS `tickets`
GROUP BY `tickets`.`__d_channel`
ORDER BY `value` DESC, `group` IS NULL, `group` ASC
LIMIT 6;

-- params: []
SELECT `tickets`.`__d_priority` AS `group`, avg(CAST(`tickets`.`__m_sla_breach_rate` AS DOUBLE)) AS `value`, count(*) AS `n`
FROM (SELECT *, `created_at` AS `__t`, (priority) AS `__d_priority`, CASE WHEN (resolved_at IS NOT NULL) THEN (CASE WHEN TIMESTAMPDIFF(MICROSECOND, created_at, resolved_at) / 3.6e9 > sla_hours THEN 1 ELSE 0 END) END AS `__m_sla_breach_rate` FROM `tickets`) AS `tickets`
GROUP BY `tickets`.`__d_priority`
ORDER BY avg(CAST(`tickets`.`__m_sla_breach_rate` AS DOUBLE)) IS NULL, `value` ASC, `group` IS NULL, `group` ASC
LIMIT 3;

-- params: []
SELECT count(`tickets`.`__m_open`) AS `value`, count(*) AS `n`
FROM (SELECT *, `created_at` AS `__t`, CASE WHEN (status IN ('open', 'pending')) THEN 1 END AS `__m_open` FROM `tickets`) AS `tickets`
LIMIT 1;
