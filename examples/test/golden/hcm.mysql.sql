-- params: ["2026-08-02 00:00:00.000","2026-09-01 00:00:00.000","2026-08-02 00:00:00.000","2026-09-01 00:00:00.000","2026-07-03 00:00:00.000","2026-08-02 00:00:00.000","ng.state","2026-07-03 00:00:00.000","2026-09-01 00:00:00.000"]
SELECT count(CASE WHEN ((`tasks`.`__t` >= CAST(? AS DATETIME(3))) AND (`tasks`.`__t` < CAST(? AS DATETIME(3)))) THEN 1 END) AS `value`, count(CASE WHEN ((`tasks`.`__t` >= CAST(? AS DATETIME(3))) AND (`tasks`.`__t` < CAST(? AS DATETIME(3)))) THEN 1 END) AS `n`, count(CASE WHEN ((`tasks`.`__t` >= CAST(? AS DATETIME(3))) AND (`tasks`.`__t` < CAST(? AS DATETIME(3)))) THEN 1 END) AS `previous`
FROM (SELECT *, (TIMESTAMPADD(MICROSECOND, createdtime * 1000, TIMESTAMP '1970-01-01 00:00:00')) AS `__t` FROM `project_task` WHERE (`tenantid` = ?) AND (isdeleted = false)) AS `tasks`
WHERE (`tasks`.`__t` >= CAST(? AS DATETIME(3))) AND (`tasks`.`__t` < CAST(? AS DATETIME(3)))
LIMIT 1;

-- params: ["ng.state","ng.state"]
SELECT CAST(DATE_SUB(DATE(`tasks`.`__t`), INTERVAL WEEKDAY(`tasks`.`__t`) DAY) AS DATETIME) AS `bucket`, `projects`.`__d_campaign` AS `series`, count(*) AS `value`, count(*) AS `n`
FROM (SELECT *, (TIMESTAMPADD(MICROSECOND, createdtime * 1000, TIMESTAMP '1970-01-01 00:00:00')) AS `__t` FROM `project_task` WHERE (`tenantid` = ?) AND (isdeleted = false)) AS `tasks`
LEFT JOIN (SELECT *, (root) AS `__d_campaign` FROM `v_project` WHERE (`tenantid` = ?)) AS `projects` ON `tasks`.`projectid` = `projects`.`id`
GROUP BY CAST(DATE_SUB(DATE(`tasks`.`__t`), INTERVAL WEEKDAY(`tasks`.`__t`) DAY) AS DATETIME), `projects`.`__d_campaign`
ORDER BY `bucket` IS NULL, `bucket` ASC, `series` IS NULL, `series` ASC
LIMIT 5000;

-- params: ["ng.state","ng.state"]
SELECT `addresses`.`__d_locality` AS `group`, avg(CAST(`tasks`.`__m_success_rate` AS DOUBLE)) AS `value`, count(*) AS `n`
FROM (SELECT *, (TIMESTAMPADD(MICROSECOND, createdtime * 1000, TIMESTAMP '1970-01-01 00:00:00')) AS `__t`, (CASE WHEN status = 'ADMINISTRATION_SUCCESS' THEN 1 ELSE 0 END) AS `__m_success_rate` FROM `project_task` WHERE (`tenantid` = ?) AND (isdeleted = false)) AS `tasks`
LEFT JOIN (SELECT *, (localitycode) AS `__d_locality` FROM `address` WHERE (`tenantid` = ?)) AS `addresses` ON `tasks`.`addressid` = `addresses`.`id`
GROUP BY `addresses`.`__d_locality`
ORDER BY avg(CAST(`tasks`.`__m_success_rate` AS DOUBLE)) IS NULL, `value` ASC, `group` IS NULL, `group` ASC
LIMIT 12;

-- params: ["ng.state","ng.state"]
SELECT `addresses`.`__d_locality` AS `group`, count(*) AS `value`, count(*) AS `n`
FROM (SELECT *, (TIMESTAMPADD(MICROSECOND, createdtime * 1000, TIMESTAMP '1970-01-01 00:00:00')) AS `__t` FROM `household` WHERE (`tenantid` = ?) AND (isdeleted = false)) AS `households`
LEFT JOIN (SELECT *, (localitycode) AS `__d_locality` FROM `address` WHERE (`tenantid` = ?)) AS `addresses` ON `households`.`addressid` = `addresses`.`id`
GROUP BY `addresses`.`__d_locality`
ORDER BY `value` DESC, `group` IS NULL, `group` ASC
LIMIT 15;

-- params: ["ng.state"]
SELECT CAST(DATE_SUB(DATE(`households`.`__t`), INTERVAL WEEKDAY(`households`.`__t`) DAY) AS DATETIME) AS `bucket`, count(*) AS `value`, count(*) AS `n`
FROM (SELECT *, (TIMESTAMPADD(MICROSECOND, createdtime * 1000, TIMESTAMP '1970-01-01 00:00:00')) AS `__t` FROM `household` WHERE (`tenantid` = ?) AND (isdeleted = false)) AS `households`
GROUP BY CAST(DATE_SUB(DATE(`households`.`__t`), INTERVAL WEEKDAY(`households`.`__t`) DAY) AS DATETIME)
ORDER BY `bucket` IS NULL, `bucket` ASC
LIMIT 5000;

-- params: ["ng.state"]
SELECT `households`.`__d_household_type` AS `group`, avg(CAST(`households`.`__m_household_size` AS DOUBLE)) AS `value`, count(*) AS `n`
FROM (SELECT *, (TIMESTAMPADD(MICROSECOND, createdtime * 1000, TIMESTAMP '1970-01-01 00:00:00')) AS `__t`, (householdtype) AS `__d_household_type`, (numberofmembers) AS `__m_household_size` FROM `household` WHERE (`tenantid` = ?) AND (isdeleted = false)) AS `households`
GROUP BY `households`.`__d_household_type`
ORDER BY `value` DESC, `group` IS NULL, `group` ASC
LIMIT 5;

-- params: ["ng.state"]
SELECT `individuals`.`__d_age_band` AS `group`, count(*) AS `value`, count(*) AS `n`
FROM (SELECT *, (TIMESTAMPADD(MICROSECOND, createdtime * 1000, TIMESTAMP '1970-01-01 00:00:00')) AS `__t`, (CASE WHEN dateofbirth IS NULL THEN 'unknown' WHEN DATEDIFF(CURDATE(), dateofbirth) / 365.25 < 5 THEN '0-4' WHEN DATEDIFF(CURDATE(), dateofbirth) / 365.25 < 15 THEN '5-14' WHEN DATEDIFF(CURDATE(), dateofbirth) / 365.25 < 50 THEN '15-49' ELSE '50+' END) AS `__d_age_band` FROM `individual` WHERE (`tenantid` = ?) AND (isdeleted = false)) AS `individuals`
GROUP BY `individuals`.`__d_age_band`
ORDER BY `value` DESC, `group` IS NULL, `group` ASC
LIMIT 6;

-- params: ["ng.state"]
SELECT `individuals`.`__d_gender` AS `group`, count(*) AS `value`, count(*) AS `n`
FROM (SELECT *, (TIMESTAMPADD(MICROSECOND, createdtime * 1000, TIMESTAMP '1970-01-01 00:00:00')) AS `__t`, (gender) AS `__d_gender` FROM `individual` WHERE (`tenantid` = ?) AND (isdeleted = false)) AS `individuals`
GROUP BY `individuals`.`__d_gender`
ORDER BY `value` DESC, `group` IS NULL, `group` ASC
LIMIT 5;

-- params: ["ng.state"]
SELECT `referrals`.`__d_recipient_type` AS `group`, count(*) AS `value`, count(*) AS `n`
FROM (SELECT *, (TIMESTAMPADD(MICROSECOND, createdtime * 1000, TIMESTAMP '1970-01-01 00:00:00')) AS `__t`, (recipienttype) AS `__d_recipient_type` FROM `referral` WHERE (`tenantid` = ?) AND (isdeleted = false)) AS `referrals`
GROUP BY `referrals`.`__d_recipient_type`
ORDER BY `value` DESC, `group` IS NULL, `group` ASC
LIMIT 5;

-- params: ["ng.state"]
SELECT `resources`.`__d_non_delivery_reason` AS `group`, count(`resources`.`__m_undelivered`) AS `value`, count(*) AS `n`
FROM (SELECT *, (TIMESTAMPADD(MICROSECOND, createdtime * 1000, TIMESTAMP '1970-01-01 00:00:00')) AS `__t`, (reasonifnotdelivered) AS `__d_non_delivery_reason`, CASE WHEN (isdelivered = false) THEN 1 END AS `__m_undelivered` FROM `task_resource` WHERE (`tenantid` = ?) AND (isdeleted = false)) AS `resources`
GROUP BY `resources`.`__d_non_delivery_reason`
ORDER BY `value` DESC, `group` IS NULL, `group` ASC
LIMIT 6;

-- params: ["ng.state"]
SELECT `side_effects`.`__d_symptom` AS `group`, count(*) AS `value`, count(*) AS `n`
FROM (SELECT *, (TIMESTAMPADD(MICROSECOND, createdtime * 1000, TIMESTAMP '1970-01-01 00:00:00')) AS `__t`, (JSON_UNQUOTE(JSON_EXTRACT(symptoms, '$[0]'))) AS `__d_symptom` FROM `side_effect` WHERE (`tenantid` = ?) AND (isdeleted = false)) AS `side_effects`
GROUP BY `side_effects`.`__d_symptom`
ORDER BY `value` DESC, `group` IS NULL, `group` ASC
LIMIT 8;

-- params: ["ng.state"]
SELECT avg(CAST(`resources`.`__m_delivered_rate` AS DOUBLE)) AS `value`, count(*) AS `n`
FROM (SELECT *, (TIMESTAMPADD(MICROSECOND, createdtime * 1000, TIMESTAMP '1970-01-01 00:00:00')) AS `__t`, (CASE WHEN isdelivered THEN 1 ELSE 0 END) AS `__m_delivered_rate` FROM `task_resource` WHERE (`tenantid` = ?) AND (isdeleted = false)) AS `resources`
LIMIT 1;

-- params: ["ng.state"]
SELECT avg(CAST(`tasks`.`__m_success_rate` AS DOUBLE)) AS `value`, count(*) AS `n`
FROM (SELECT *, (TIMESTAMPADD(MICROSECOND, createdtime * 1000, TIMESTAMP '1970-01-01 00:00:00')) AS `__t`, (CASE WHEN status = 'ADMINISTRATION_SUCCESS' THEN 1 ELSE 0 END) AS `__m_success_rate` FROM `project_task` WHERE (`tenantid` = ?) AND (isdeleted = false)) AS `tasks`
LIMIT 1;

-- params: ["ng.state"]
SELECT count(*) AS `value`, count(*) AS `n`
FROM (SELECT *, (TIMESTAMPADD(MICROSECOND, createdtime * 1000, TIMESTAMP '1970-01-01 00:00:00')) AS `__t` FROM `household` WHERE (`tenantid` = ?) AND (isdeleted = false)) AS `households`
LIMIT 1;
