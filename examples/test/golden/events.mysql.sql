-- params: ["(internal)"]
SELECT `pageviews`.`__d_referrer` AS `group`, avg(CAST(`pageviews`.`__m_bounce_rate` AS DOUBLE)) AS `value`, count(*) AS `n`
FROM (SELECT *, `ts` AS `__t`, (referrer) AS `__d_referrer`, (CASE WHEN bounced THEN 1 ELSE 0 END) AS `__m_bounce_rate` FROM `pageviews`) AS `pageviews`
WHERE (`pageviews`.`__d_referrer` <> ?)
GROUP BY `pageviews`.`__d_referrer`
ORDER BY `value` DESC, `group` IS NULL, `group` ASC
LIMIT 8;

-- params: ["(internal)"]
SELECT `pageviews`.`__d_referrer` AS `group`, count(DISTINCT `pageviews`.`__m_sessions`) AS `value`, count(*) AS `n`
FROM (SELECT *, `ts` AS `__t`, (referrer) AS `__d_referrer`, (session_id) AS `__m_sessions` FROM `pageviews`) AS `pageviews`
WHERE (`pageviews`.`__d_referrer` <> ?)
GROUP BY `pageviews`.`__d_referrer`
ORDER BY `value` DESC, `group` IS NULL, `group` ASC
LIMIT 8;

-- params: ["2026-08-02 00:00:00.000","2026-09-01 00:00:00.000"]
SELECT CAST(DATE(`pageviews`.`__t`) AS DATETIME) AS `bucket`, `pageviews`.`__d_device` AS `series`, count(DISTINCT `pageviews`.`__m_sessions`) AS `value`, count(*) AS `n`
FROM (SELECT *, `ts` AS `__t`, (device) AS `__d_device`, (session_id) AS `__m_sessions` FROM `pageviews`) AS `pageviews`
WHERE ((`pageviews`.`__t` >= CAST(? AS DATETIME(3))) AND (`pageviews`.`__t` < CAST(? AS DATETIME(3))))
GROUP BY CAST(DATE(`pageviews`.`__t`) AS DATETIME), `pageviews`.`__d_device`
ORDER BY `bucket` IS NULL, `bucket` ASC, `series` IS NULL, `series` ASC
LIMIT 5000;

-- params: ["2026-08-25 00:00:00.000","2026-09-01 00:00:00.000","2026-08-25 00:00:00.000","2026-09-01 00:00:00.000","2026-08-18 00:00:00.000","2026-08-25 00:00:00.000","2026-08-18 00:00:00.000","2026-09-01 00:00:00.000"]
SELECT count(CASE WHEN ((`pageviews`.`__t` >= CAST(? AS DATETIME(3))) AND (`pageviews`.`__t` < CAST(? AS DATETIME(3)))) THEN 1 END) AS `value`, count(CASE WHEN ((`pageviews`.`__t` >= CAST(? AS DATETIME(3))) AND (`pageviews`.`__t` < CAST(? AS DATETIME(3)))) THEN 1 END) AS `n`, count(CASE WHEN ((`pageviews`.`__t` >= CAST(? AS DATETIME(3))) AND (`pageviews`.`__t` < CAST(? AS DATETIME(3)))) THEN 1 END) AS `previous`
FROM (SELECT *, `ts` AS `__t` FROM `pageviews`) AS `pageviews`
WHERE (`pageviews`.`__t` >= CAST(? AS DATETIME(3))) AND (`pageviews`.`__t` < CAST(? AS DATETIME(3)))
LIMIT 1;

-- params: ["2026-08-25 00:00:00.000","2026-09-01 00:00:00.000","2026-08-25 00:00:00.000","2026-09-01 00:00:00.000","2026-08-18 00:00:00.000","2026-08-25 00:00:00.000","2026-08-18 00:00:00.000","2026-09-01 00:00:00.000"]
SELECT count(DISTINCT CASE WHEN ((`pageviews`.`__t` >= CAST(? AS DATETIME(3))) AND (`pageviews`.`__t` < CAST(? AS DATETIME(3)))) THEN `pageviews`.`__m_sessions` END) AS `value`, count(CASE WHEN ((`pageviews`.`__t` >= CAST(? AS DATETIME(3))) AND (`pageviews`.`__t` < CAST(? AS DATETIME(3)))) THEN 1 END) AS `n`, count(DISTINCT CASE WHEN ((`pageviews`.`__t` >= CAST(? AS DATETIME(3))) AND (`pageviews`.`__t` < CAST(? AS DATETIME(3)))) THEN `pageviews`.`__m_sessions` END) AS `previous`
FROM (SELECT *, `ts` AS `__t`, (session_id) AS `__m_sessions` FROM `pageviews`) AS `pageviews`
WHERE (`pageviews`.`__t` >= CAST(? AS DATETIME(3))) AND (`pageviews`.`__t` < CAST(? AS DATETIME(3)))
LIMIT 1;

-- params: ["2026-08-25 00:00:00.000","2026-09-01 00:00:00.000"]
SELECT (CAST(count(*) AS DOUBLE) / NULLIF(CAST(count(DISTINCT `pageviews`.`__m_sessions`) AS DOUBLE), 0)) AS `value`, count(*) AS `n`
FROM (SELECT *, `ts` AS `__t`, (session_id) AS `__m_sessions` FROM `pageviews`) AS `pageviews`
WHERE ((`pageviews`.`__t` >= CAST(? AS DATETIME(3))) AND (`pageviews`.`__t` < CAST(? AS DATETIME(3))))
LIMIT 1;

-- params: ["2026-08-25 00:00:00.000","2026-09-01 00:00:00.000"]
SELECT avg(CAST(`pageviews`.`__m_bounce_rate` AS DOUBLE)) AS `value`, count(*) AS `n`
FROM (SELECT *, `ts` AS `__t`, (CASE WHEN bounced THEN 1 ELSE 0 END) AS `__m_bounce_rate` FROM `pageviews`) AS `pageviews`
WHERE ((`pageviews`.`__t` >= CAST(? AS DATETIME(3))) AND (`pageviews`.`__t` < CAST(? AS DATETIME(3))))
LIMIT 1;

-- params: []
SELECT CAST(DATE_SUB(DATE(`pageviews`.`__t`), INTERVAL WEEKDAY(`pageviews`.`__t`) DAY) AS DATETIME) AS `bucket`, count(DISTINCT `pageviews`.`__m_users`) AS `value`, count(*) AS `n`
FROM (SELECT *, `ts` AS `__t`, (user_id) AS `__m_users` FROM `pageviews`) AS `pageviews`
GROUP BY CAST(DATE_SUB(DATE(`pageviews`.`__t`), INTERVAL WEEKDAY(`pageviews`.`__t`) DAY) AS DATETIME)
ORDER BY `bucket` IS NULL, `bucket` ASC
LIMIT 5000;

-- params: []
SELECT `pageviews`.`__d_hour_of_day` AS `group`, count(*) AS `value`, count(*) AS `n`
FROM (SELECT *, `ts` AS `__t`, (HOUR(ts)) AS `__d_hour_of_day` FROM `pageviews`) AS `pageviews`
GROUP BY `pageviews`.`__d_hour_of_day`
ORDER BY count(*) IS NULL, `value` ASC, `group` IS NULL, `group` ASC
LIMIT 24;

-- params: []
SELECT `pageviews`.`__d_path` AS `group`, count(*) AS `value`, count(*) AS `n`
FROM (SELECT *, `ts` AS `__t`, (path) AS `__d_path` FROM `pageviews`) AS `pageviews`
GROUP BY `pageviews`.`__d_path`
ORDER BY `value` DESC, `group` IS NULL, `group` ASC
LIMIT 10;
