-- params: ["2026-03-03T00:00:00.000Z","2026-09-01T00:00:00.000Z"]
SELECT date_trunc('week', "orders"."__t") AS "bucket", sum("orders"."__m_revenue") AS "value", count(*) AS "n"
FROM (SELECT *, "placed_at" AS "__t", (total_cents / 100.0) AS "__m_revenue" FROM "orders") AS "orders"
WHERE (("orders"."__t" >= CAST($1 AS TIMESTAMP)) AND ("orders"."__t" < CAST($2 AS TIMESTAMP)))
GROUP BY date_trunc('week', "orders"."__t")
ORDER BY "bucket" ASC NULLS LAST
LIMIT 5000;

-- params: ["2026-08-02T00:00:00.000Z","2026-09-01T00:00:00.000Z","2026-08-02T00:00:00.000Z","2026-09-01T00:00:00.000Z","2026-07-03T00:00:00.000Z","2026-08-02T00:00:00.000Z","2026-07-03T00:00:00.000Z","2026-09-01T00:00:00.000Z"]
SELECT count(CASE WHEN (("orders"."__t" >= CAST($1 AS TIMESTAMP)) AND ("orders"."__t" < CAST($2 AS TIMESTAMP))) THEN 1 END) AS "value", count(CASE WHEN (("orders"."__t" >= CAST($3 AS TIMESTAMP)) AND ("orders"."__t" < CAST($4 AS TIMESTAMP))) THEN 1 END) AS "n", count(CASE WHEN (("orders"."__t" >= CAST($5 AS TIMESTAMP)) AND ("orders"."__t" < CAST($6 AS TIMESTAMP))) THEN 1 END) AS "previous"
FROM (SELECT *, "placed_at" AS "__t" FROM "orders") AS "orders"
WHERE ("orders"."__t" >= CAST($7 AS TIMESTAMP)) AND ("orders"."__t" < CAST($8 AS TIMESTAMP))
LIMIT 1;

-- params: ["2026-08-02T00:00:00.000Z","2026-09-01T00:00:00.000Z","2026-08-02T00:00:00.000Z","2026-09-01T00:00:00.000Z","2026-07-03T00:00:00.000Z","2026-08-02T00:00:00.000Z","2026-07-03T00:00:00.000Z","2026-09-01T00:00:00.000Z"]
SELECT sum(CASE WHEN (("orders"."__t" >= CAST($1 AS TIMESTAMP)) AND ("orders"."__t" < CAST($2 AS TIMESTAMP))) THEN "orders"."__m_revenue" END) AS "value", count(CASE WHEN (("orders"."__t" >= CAST($3 AS TIMESTAMP)) AND ("orders"."__t" < CAST($4 AS TIMESTAMP))) THEN 1 END) AS "n", sum(CASE WHEN (("orders"."__t" >= CAST($5 AS TIMESTAMP)) AND ("orders"."__t" < CAST($6 AS TIMESTAMP))) THEN "orders"."__m_revenue" END) AS "previous"
FROM (SELECT *, "placed_at" AS "__t", (total_cents / 100.0) AS "__m_revenue" FROM "orders") AS "orders"
WHERE ("orders"."__t" >= CAST($7 AS TIMESTAMP)) AND ("orders"."__t" < CAST($8 AS TIMESTAMP))
LIMIT 1;

-- params: []
SELECT "customers"."__d_country" AS "group", avg("orders"."__m_refund_rate") AS "value", count(*) AS "n"
FROM (SELECT *, "placed_at" AS "__t", ((status = 'refunded')::int) AS "__m_refund_rate" FROM "orders") AS "orders"
LEFT JOIN (SELECT *, "signed_up_at" AS "__t", (country) AS "__d_country" FROM "customers") AS "customers" ON "orders"."customer_id" = "customers"."id"
GROUP BY "customers"."__d_country"
ORDER BY "value" DESC NULLS LAST, "group" ASC NULLS LAST
LIMIT 10;

-- params: []
SELECT "customers"."__d_country" AS "group", sum("orders"."__m_revenue") AS "value", count(*) AS "n"
FROM (SELECT *, "placed_at" AS "__t", (total_cents / 100.0) AS "__m_revenue" FROM "orders") AS "orders"
LEFT JOIN (SELECT *, "signed_up_at" AS "__t", (country) AS "__d_country" FROM "customers") AS "customers" ON "orders"."customer_id" = "customers"."id"
GROUP BY "customers"."__d_country"
ORDER BY "value" DESC NULLS LAST, "group" ASC NULLS LAST
LIMIT 10;

-- params: []
SELECT "orders"."__d_channel" AS "group", (CAST(sum("orders"."__m_revenue") AS DOUBLE PRECISION) / NULLIF(CAST(count(*) AS DOUBLE PRECISION), 0)) AS "value", count(*) AS "n"
FROM (SELECT *, "placed_at" AS "__t", (channel) AS "__d_channel", (total_cents / 100.0) AS "__m_revenue" FROM "orders") AS "orders"
GROUP BY "orders"."__d_channel"
ORDER BY "value" DESC NULLS LAST, "group" ASC NULLS LAST
LIMIT 5;

-- params: []
SELECT "products"."__d_category" AS "group", sum("order_items"."__m_item_revenue") AS "value", count(*) AS "n"
FROM (SELECT *, (qty * unit_cents / 100.0) AS "__m_item_revenue" FROM "order_items") AS "order_items"
LEFT JOIN (SELECT *, (category) AS "__d_category" FROM "products") AS "products" ON "order_items"."product_id" = "products"."id"
GROUP BY "products"."__d_category"
ORDER BY "value" DESC NULLS LAST, "group" ASC NULLS LAST
LIMIT 8;

-- params: []
SELECT avg("orders"."__m_refund_rate") AS "value", count(*) AS "n"
FROM (SELECT *, "placed_at" AS "__t", ((status = 'refunded')::int) AS "__m_refund_rate" FROM "orders") AS "orders"
LIMIT 1;

-- params: []
SELECT date_trunc('month', "orders"."__t") AS "bucket", "customers"."__d_segment" AS "series", count(*) AS "value", count(*) AS "n"
FROM (SELECT *, "placed_at" AS "__t" FROM "orders") AS "orders"
LEFT JOIN (SELECT *, "signed_up_at" AS "__t", (segment) AS "__d_segment" FROM "customers") AS "customers" ON "orders"."customer_id" = "customers"."id"
GROUP BY date_trunc('month', "orders"."__t"), "customers"."__d_segment"
ORDER BY "bucket" ASC NULLS LAST, "series" ASC NULLS LAST
LIMIT 5000;

-- params: []
SELECT percentile_cont(0.9) WITHIN GROUP (ORDER BY "orders"."__m_p90_order") AS "value", count(*) AS "n"
FROM (SELECT *, "placed_at" AS "__t", (total_cents / 100.0) AS "__m_p90_order" FROM "orders") AS "orders"
LIMIT 1;
