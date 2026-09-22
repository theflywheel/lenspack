import type { Writer } from "@lenspack/sql";

import { type Dialect, daysAgo, execAll, insertRows, rng, ts } from "../_shared/seed-util";

export async function seed(writer: Writer, dialect: Dialect, opts: { tickets?: number; now?: Date } = {}) {
  const r = rng(31);
  const now = opts.now ?? new Date("2026-09-01T00:00:00Z");
  const n = opts.tickets ?? 4000;
  void dialect;

  await execAll(writer, [
    "DROP TABLE IF EXISTS status_history",
    "DROP TABLE IF EXISTS tickets",
    "CREATE TABLE tickets (id INTEGER PRIMARY KEY, created_at TIMESTAMP, team VARCHAR, priority VARCHAR, status VARCHAR, channel VARCHAR, resolved_at TIMESTAMP, sla_hours INTEGER, first_response_minutes INTEGER)",
    "CREATE TABLE status_history (id INTEGER PRIMARY KEY, ticket_id INTEGER, status VARCHAR, changed_at TIMESTAMP)",
  ]);

  const tickets: unknown[][] = [];
  const history: unknown[][] = [];
  let hid = 1;
  for (let i = 1; i <= n; i++) {
    const created = daysAgo(now, r.int(0, 120) + r.next());
    const priority = r.weighted([["p1", 1], ["p2", 3], ["p3", 6]]);
    const sla = priority === "p1" ? 4 : priority === "p2" ? 24 : 72;
    const team = r.pick(["billing", "access", "platform", "mobile"]);
    // Older tickets are more likely to have been resolved.
    const age = (now.getTime() - created.getTime()) / 3600e3;
    const resolved = age > 2 && r.chance(Math.min(0.92, age / 200));
    const hours = resolved ? Math.max(0.5, sla * (0.2 + r.next() * 1.6)) : null;
    const resolvedAt = hours ? new Date(created.getTime() + hours * 3600e3) : null;
    const status = resolvedAt ? (r.chance(0.9) ? "resolved" : "closed") : r.weighted([["open", 5], ["pending", 3], ["escalated", 1]]);
    tickets.push([i, ts(created), team, priority, status, r.weighted([["email", 5], ["chat", 3], ["phone", 1], ["whatsapp", 1]]), resolvedAt ? ts(resolvedAt) : null, sla, r.int(2, 240)]);

    history.push([hid++, i, "open", ts(created)]);
    if (r.chance(0.5)) history.push([hid++, i, "pending", ts(new Date(created.getTime() + r.int(1, 12) * 3600e3))]);
    if (status === "escalated" || r.chance(0.1)) history.push([hid++, i, "escalated", ts(new Date(created.getTime() + r.int(2, 24) * 3600e3))]);
    if (resolvedAt) history.push([hid++, i, "resolved", ts(resolvedAt)]);
    if (status === "closed") history.push([hid++, i, "closed", ts(new Date(resolvedAt!.getTime() + 24 * 3600e3))]);
  }
  await insertRows(writer, "tickets", ["id", "created_at", "team", "priority", "status", "channel", "resolved_at", "sla_hours", "first_response_minutes"], tickets);
  await insertRows(writer, "status_history", ["id", "ticket_id", "status", "changed_at"], history);
}
