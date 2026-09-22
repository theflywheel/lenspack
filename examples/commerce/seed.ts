import type { Writer } from "@lenspack/sql";

import { type Dialect, daysAgo, execAll, insertRows, rng, ts } from "../_shared/seed-util";

export async function seed(writer: Writer, dialect: Dialect, opts: { orders?: number; now?: Date } = {}) {
  const r = rng(7);
  const now = opts.now ?? new Date("2026-09-01T00:00:00Z");
  const nOrders = opts.orders ?? 5000;
  void dialect;

  await execAll(writer, [
    "DROP TABLE IF EXISTS order_items",
    "DROP TABLE IF EXISTS orders",
    "DROP TABLE IF EXISTS products",
    "DROP TABLE IF EXISTS customers",
    "CREATE TABLE customers (id INTEGER PRIMARY KEY, country VARCHAR, segment VARCHAR, signed_up_at TIMESTAMP)",
    "CREATE TABLE products (id INTEGER PRIMARY KEY, category VARCHAR, price_cents INTEGER)",
    "CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, placed_at TIMESTAMP, status VARCHAR, channel VARCHAR, total_cents INTEGER)",
    "CREATE TABLE order_items (id INTEGER PRIMARY KEY, order_id INTEGER, product_id INTEGER, qty INTEGER, unit_cents INTEGER)",
  ]);

  const countries = [["IN", 5], ["US", 3], ["GB", 2], ["DE", 1], ["KE", 1]] as const;
  const customers = Array.from({ length: Math.max(50, Math.floor(nOrders / 8)) }, (_, i) => [
    i + 1,
    r.weighted(countries),
    r.weighted([["consumer", 7], ["business", 2], ["education", 1]]),
    ts(daysAgo(now, r.int(30, 720))),
  ]);
  await insertRows(writer, "customers", ["id", "country", "segment", "signed_up_at"], customers);

  const categories = ["books", "electronics", "home", "toys", "grocery"];
  const products = Array.from({ length: 60 }, (_, i) => [i + 1, categories[i % categories.length], r.int(199, 19999)]);
  await insertRows(writer, "products", ["id", "category", "price_cents"], products);

  const orders: unknown[][] = [];
  const items: unknown[][] = [];
  let itemId = 1;
  for (let i = 1; i <= nOrders; i++) {
    const lines = r.int(1, 4);
    let total = 0;
    for (let l = 0; l < lines; l++) {
      const product = r.pick(products);
      const qty = r.int(1, 3);
      const unit = product[2] as number;
      items.push([itemId++, i, product[0], qty, unit]);
      total += qty * unit;
    }
    orders.push([
      i,
      r.int(1, customers.length),
      ts(daysAgo(now, r.int(0, 365))),
      r.weighted([["delivered", 80], ["shipped", 8], ["refunded", 7], ["cancelled", 5]]),
      r.weighted([["web", 6], ["app", 3], ["marketplace", 1]]),
      total,
    ]);
  }
  await insertRows(writer, "orders", ["id", "customer_id", "placed_at", "status", "channel", "total_cents"], orders);
  await insertRows(writer, "order_items", ["id", "order_id", "product_id", "qty", "unit_cents"], items);
}
