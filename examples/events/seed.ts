import type { Writer } from "@lenspack/sql";

import { type Dialect, execAll, insertRows, rng, ts } from "../_shared/seed-util";

const PATHS = ["/", "/pricing", "/docs", "/docs/getting-started", "/docs/packs", "/blog", "/blog/why-dashboards-are-data", "/signup", "/login", "/about"];
const REFERRERS = [["(direct)", 5], ["google", 4], ["twitter", 1], ["hn", 1], ["newsletter", 1]] as const;
const COUNTRIES = [["IN", 4], ["US", 3], ["GB", 1], ["DE", 1], ["BR", 1]] as const;

export async function seed(writer: Writer, dialect: Dialect, opts: { rows?: number; now?: Date } = {}) {
  const r = rng(11);
  const now = opts.now ?? new Date("2026-09-01T00:00:00Z");
  const rows = opts.rows ?? Number(process.env.LENSPACK_EVENTS_ROWS ?? 200_000);
  void dialect;

  await execAll(writer, [
    "DROP TABLE IF EXISTS pageviews",
    "CREATE TABLE pageviews (id INTEGER PRIMARY KEY, ts TIMESTAMP, session_id VARCHAR, user_id VARCHAR, path VARCHAR, referrer VARCHAR, country VARCHAR, device VARCHAR, duration_ms INTEGER, bounced BOOLEAN)",
  ]);

  // Sessions of 1–6 views each, spread over 90 days with a daily cycle.
  const batch: unknown[][] = [];
  let id = 1;
  let session = 1;
  while (id <= rows) {
    const user = `u${r.int(1, Math.max(100, Math.floor(rows / 20)))}`;
    const sid = `s${session++}`;
    const views = r.weighted([[1, 40], [2, 25], [3, 15], [4, 10], [5, 6], [6, 4]]);
    const day = r.int(0, 89);
    const hour = r.weighted([[9, 2], [11, 3], [14, 3], [17, 2], [21, 2], [2, 1], [r.int(0, 23), 3]]);
    const start = new Date(now.getTime() - day * 86400e3 + hour * 3600e3 + r.int(0, 3599) * 1000);
    const country = r.weighted(COUNTRIES);
    const device = r.weighted([["desktop", 5], ["mobile", 4], ["tablet", 1]]);
    const referrer = r.weighted(REFERRERS);
    for (let v = 0; v < views && id <= rows; v++) {
      batch.push([
        id++,
        ts(new Date(start.getTime() + v * r.int(5_000, 120_000))),
        sid,
        user,
        v === 0 ? r.weighted([["/", 5], ["/pricing", 2], ["/docs", 2], ["/blog", 1]]) : r.pick(PATHS),
        v === 0 ? referrer : "(internal)",
        country,
        device,
        r.int(500, 180_000),
        views === 1,
      ]);
      if (batch.length >= 20_000) {
        await insertRows(writer, "pageviews", ["id", "ts", "session_id", "user_id", "path", "referrer", "country", "device", "duration_ms", "bounced"], batch.splice(0));
      }
    }
  }
  await insertRows(writer, "pageviews", ["id", "ts", "session_id", "user_id", "path", "referrer", "country", "device", "duration_ms", "bounced"], batch);
}
