-- params: ["2026-03-03 00:00:00.000","2026-09-01 00:00:00.000"]
SELECT toDateTime(toMonday("orders"."__t"), 'UTC') AS "bucket", sum("orders"."__m_revenue") AS "value", count(*) AS "n"
FROM (SELECT *, "placed_at" AS "__t", (total_cents / 100.0) AS "__m_revenue" FROM "orders") AS "orders"
WHERE (("orders"."__t" >= CAST({p1:DateTime64(3, 'UTC')} AS DateTime64(3, 'UTC'))) AND ("orders"."__t" < CAST({p2:DateTime64(3, 'UTC')} AS DateTime64(3, 'UTC'))))
GROUP BY toDateTime(toMonday("orders"."__t"), 'UTC')
ORDER BY "bucket" ASC NULLS LAST
LIMIT 5000;

-- params: ["2026-08-02 00:00:00.000","2026-09-01 00:00:00.000","2026-08-02 00:00:00.000","2026-09-01 00:00:00.000","2026-07-03 00:00:00.000","2026-08-02 00:00:00.000","2026-07-03 00:00:00.000","2026-09-01 00:00:00.000"]
SELECT count(CASE WHEN (("orders"."__t" >= CAST({p1:DateTime64(3, 'UTC')} AS DateTime64(3, 'UTC'))) AND ("orders"."__t" < CAST({p2:DateTime64(3, 'UTC')} AS DateTime64(3, 'UTC')))) THEN 1 END) AS "value", count(CASE WHEN (("orders"."__t" >= CAST({p3:DateTime64(3, 'UTC')} AS DateTime64(3, 'UTC'))) AND ("orders"."__t" < CAST({p4:DateTime64(3, 'UTC')} AS DateTime64(3, 'UTC')))) THEN 1 END) AS "n", count(CASE WHEN (("orders"."__t" >= CAST({p5:DateTime64(3, 'UTC')} AS DateTime64(3, 'UTC'))) AND ("orders"."__t" < CAST({p6:DateTime64(3, 'UTC')} AS DateTime64(3, 'UTC')))) THEN 1 END) AS "previous"
FROM (SELECT *, "placed_at" AS "__t" FROM "orders") AS "orders"
WHERE ("orders"."__t" >= CAST({p7:DateTime64(3, 'UTC')} AS DateTime64(3, 'UTC'))) AND ("orders"."__t" < CAST({p8:DateTime64(3, 'UTC')} AS DateTime64(3, 'UTC')))
LIMIT 1;

-- params: ["2026-08-02 00:00:00.000","2026-09-01 00:00:00.000","2026-08-02 00:00:00.000","2026-09-01 00:00:00.000","2026-07-03 00:00:00.000","2026-08-02 00:00:00.000","2026-07-03 00:00:00.000","2026-09-01 00:00:00.000"]
SELECT sum(CASE WHEN (("orders"."__t" >= CAST({p1:DateTime64(3, 'UTC')} AS DateTime64(3, 'UTC'))) AND ("orders"."__t" < CAST({p2:DateTime64(3, 'UTC')} AS DateTime64(3, 'UTC')))) THEN "orders"."__m_revenue" END) AS "value", count(CASE WHEN (("orders"."__t" >= CAST({p3:DateTime64(3, 'UTC')} AS DateTime64(3, 'UTC'))) AND ("orders"."__t" < CAST({p4:DateTime64(3, 'UTC')} AS DateTime64(3, 'UTC')))) THEN 1 END) AS "n", sum(CASE WHEN (("orders"."__t" >= CAST({p5:DateTime64(3, 'UTC')} AS DateTime64(3, 'UTC'))) AND ("orders"."__t" < CAST({p6:DateTime64(3, 'UTC')} AS DateTime64(3, 'UTC')))) THEN "orders"."__m_revenue" END) AS "previous"
FROM (SELECT *, "placed_at" AS "__t", (total_cents / 100.0) AS "__m_revenue" FROM "orders") AS "orders"
WHERE ("orders"."__t" >= CAST({p7:DateTime64(3, 'UTC')} AS DateTime64(3, 'UTC'))) AND ("orders"."__t" < CAST({p8:DateTime64(3, 'UTC')} AS DateTime64(3, 'UTC')))
LIMIT 1;

-- params: []
SELECT "customers"."__d_country" AS "group", avg("orders"."__m_refund_rate") AS "value", count(*) AS "n"
FROM (SELECT *, "placed_at" AS "__t", (CASE WHEN status = 'refunded' THEN 1 ELSE 0 END) AS "__m_refund_rate" FROM "orders") AS "orders"
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
SELECT "orders"."__d_channel" AS "group", (CAST(sum("orders"."__m_revenue") AS Float64) / NULLIF(CAST(count(*) AS Float64), 0)) AS "value", count(*) AS "n"
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
FROM (SELECT *, "placed_at" AS "__t", (CASE WHEN status = 'refunded' THEN 1 ELSE 0 END) AS "__m_refund_rate" FROM "orders") AS "orders"
LIMIT 1;

-- params: []
SELECT quantileExactInclusive(0.9)("orders"."__m_p90_order") AS "value", count(*) AS "n"
FROM (SELECT *, "placed_at" AS "__t", (total_cents / 100.0) AS "__m_p90_order" FROM "orders") AS "orders"
LIMIT 1;

-- params: []
SELECT toDateTime(toStartOfMonth("orders"."__t"), 'UTC') AS "bucket", "customers"."__d_segment" AS "series", count(*) AS "value", count(*) AS "n"
FROM (SELECT *, "placed_at" AS "__t" FROM "orders") AS "orders"
LEFT JOIN (SELECT *, "signed_up_at" AS "__t", (segment) AS "__d_segment" FROM "customers") AS "customers" ON "orders"."customer_id" = "customers"."id"
GROUP BY toDateTime(toStartOfMonth("orders"."__t"), 'UTC'), "customers"."__d_segment"
ORDER BY "bucket" ASC NULLS LAST, "series" ASC NULLS LAST
LIMIT 5000;
