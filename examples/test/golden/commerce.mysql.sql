-- params: ["2026-03-03 00:00:00.000","2026-09-01 00:00:00.000"]
SELECT CAST(DATE_SUB(DATE(`orders`.`__t`), INTERVAL WEEKDAY(`orders`.`__t`) DAY) AS DATETIME) AS `bucket`, sum(`orders`.`__m_revenue`) AS `value`, count(*) AS `n`
FROM (SELECT *, `placed_at` AS `__t`, (total_cents / 100.0) AS `__m_revenue` FROM `orders`) AS `orders`
WHERE ((`orders`.`__t` >= CAST(? AS DATETIME(3))) AND (`orders`.`__t` < CAST(? AS DATETIME(3))))
GROUP BY CAST(DATE_SUB(DATE(`orders`.`__t`), INTERVAL WEEKDAY(`orders`.`__t`) DAY) AS DATETIME)
ORDER BY `bucket` IS NULL, `bucket` ASC
LIMIT 5000;

-- params: ["2026-08-02 00:00:00.000","2026-09-01 00:00:00.000","2026-08-02 00:00:00.000","2026-09-01 00:00:00.000","2026-07-03 00:00:00.000","2026-08-02 00:00:00.000","2026-07-03 00:00:00.000","2026-09-01 00:00:00.000"]
SELECT count(CASE WHEN ((`orders`.`__t` >= CAST(? AS DATETIME(3))) AND (`orders`.`__t` < CAST(? AS DATETIME(3)))) THEN 1 END) AS `value`, count(CASE WHEN ((`orders`.`__t` >= CAST(? AS DATETIME(3))) AND (`orders`.`__t` < CAST(? AS DATETIME(3)))) THEN 1 END) AS `n`, count(CASE WHEN ((`orders`.`__t` >= CAST(? AS DATETIME(3))) AND (`orders`.`__t` < CAST(? AS DATETIME(3)))) THEN 1 END) AS `previous`
FROM (SELECT *, `placed_at` AS `__t` FROM `orders`) AS `orders`
WHERE (`orders`.`__t` >= CAST(? AS DATETIME(3))) AND (`orders`.`__t` < CAST(? AS DATETIME(3)))
LIMIT 1;

-- params: ["2026-08-02 00:00:00.000","2026-09-01 00:00:00.000","2026-08-02 00:00:00.000","2026-09-01 00:00:00.000","2026-07-03 00:00:00.000","2026-08-02 00:00:00.000","2026-07-03 00:00:00.000","2026-09-01 00:00:00.000"]
SELECT sum(CASE WHEN ((`orders`.`__t` >= CAST(? AS DATETIME(3))) AND (`orders`.`__t` < CAST(? AS DATETIME(3)))) THEN `orders`.`__m_revenue` END) AS `value`, count(CASE WHEN ((`orders`.`__t` >= CAST(? AS DATETIME(3))) AND (`orders`.`__t` < CAST(? AS DATETIME(3)))) THEN 1 END) AS `n`, sum(CASE WHEN ((`orders`.`__t` >= CAST(? AS DATETIME(3))) AND (`orders`.`__t` < CAST(? AS DATETIME(3)))) THEN `orders`.`__m_revenue` END) AS `previous`
FROM (SELECT *, `placed_at` AS `__t`, (total_cents / 100.0) AS `__m_revenue` FROM `orders`) AS `orders`
WHERE (`orders`.`__t` >= CAST(? AS DATETIME(3))) AND (`orders`.`__t` < CAST(? AS DATETIME(3)))
LIMIT 1;

-- params: []
SELECT CAST(DATE_FORMAT(`orders`.`__t`, '%Y-%m-01') AS DATETIME) AS `bucket`, `customers`.`__d_segment` AS `series`, count(*) AS `value`, count(*) AS `n`
FROM (SELECT *, `placed_at` AS `__t` FROM `orders`) AS `orders`
LEFT JOIN (SELECT *, `signed_up_at` AS `__t`, (segment) AS `__d_segment` FROM `customers`) AS `customers` ON `orders`.`customer_id` = `customers`.`id`
GROUP BY CAST(DATE_FORMAT(`orders`.`__t`, '%Y-%m-01') AS DATETIME), `customers`.`__d_segment`
ORDER BY `bucket` IS NULL, `bucket` ASC, `series` IS NULL, `series` ASC
LIMIT 5000;

-- params: []
SELECT `customers`.`__d_country` AS `group`, avg(CAST(`orders`.`__m_refund_rate` AS DOUBLE)) AS `value`, count(*) AS `n`
FROM (SELECT *, `placed_at` AS `__t`, (CASE WHEN status = 'refunded' THEN 1 ELSE 0 END) AS `__m_refund_rate` FROM `orders`) AS `orders`
LEFT JOIN (SELECT *, `signed_up_at` AS `__t`, (country) AS `__d_country` FROM `customers`) AS `customers` ON `orders`.`customer_id` = `customers`.`id`
GROUP BY `customers`.`__d_country`
ORDER BY `value` DESC, `group` IS NULL, `group` ASC
LIMIT 10;

-- params: []
SELECT `customers`.`__d_country` AS `group`, sum(`orders`.`__m_revenue`) AS `value`, count(*) AS `n`
FROM (SELECT *, `placed_at` AS `__t`, (total_cents / 100.0) AS `__m_revenue` FROM `orders`) AS `orders`
LEFT JOIN (SELECT *, `signed_up_at` AS `__t`, (country) AS `__d_country` FROM `customers`) AS `customers` ON `orders`.`customer_id` = `customers`.`id`
GROUP BY `customers`.`__d_country`
ORDER BY `value` DESC, `group` IS NULL, `group` ASC
LIMIT 10;

-- params: []
SELECT `orders`.`__d_channel` AS `group`, (CAST(sum(`orders`.`__m_revenue`) AS DOUBLE) / NULLIF(CAST(count(*) AS DOUBLE), 0)) AS `value`, count(*) AS `n`
FROM (SELECT *, `placed_at` AS `__t`, (channel) AS `__d_channel`, (total_cents / 100.0) AS `__m_revenue` FROM `orders`) AS `orders`
GROUP BY `orders`.`__d_channel`
ORDER BY `value` DESC, `group` IS NULL, `group` ASC
LIMIT 5;

-- params: []
SELECT `products`.`__d_category` AS `group`, sum(`order_items`.`__m_item_revenue`) AS `value`, count(*) AS `n`
FROM (SELECT *, (qty * unit_cents / 100.0) AS `__m_item_revenue` FROM `order_items`) AS `order_items`
LEFT JOIN (SELECT *, (category) AS `__d_category` FROM `products`) AS `products` ON `order_items`.`product_id` = `products`.`id`
GROUP BY `products`.`__d_category`
ORDER BY `value` DESC, `group` IS NULL, `group` ASC
LIMIT 8;

-- params: []
SELECT avg(CAST(`orders`.`__m_refund_rate` AS DOUBLE)) AS `value`, count(*) AS `n`
FROM (SELECT *, `placed_at` AS `__t`, (CASE WHEN status = 'refunded' THEN 1 ELSE 0 END) AS `__m_refund_rate` FROM `orders`) AS `orders`
LIMIT 1;
