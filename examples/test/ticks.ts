import type { Query } from "@lenspack/core";
import { SERIES_ROWS, type WidgetData } from "@lenspack/engine";
import { parsePack } from "@lenspack/pack";
import type { Writer } from "@lenspack/sql";
import { expect } from "vitest";

import { type Dialect, execAll, insertRows, ts } from "../_shared/seed-util";

// Two small made-up tables (or indexes) that every source must answer alike
// for the cases where numbers are easiest to get wrong:
//
// - ticks: one row an hour from 1 January 2020, a few more hours than a series
//   may return, so an hourly series is cut and keeps its latest hours;
// - flags: rows on two days in three of the first nine days, none on the third,
//   so a daily ratio of flags to ticks has days where only the divisor has rows.

const START = Date.UTC(2020, 0, 1);
const HOURS = SERIES_ROWS + 5;
const DAYS = 9;
const flagged = (day: number) => day % 3 !== 2;
const TICKS = "lenspack_ticks";
const FLAGS = "lenspack_flags";

export const ticksPack = parsePack({
  pack: "ticks",
  version: 1,
  entities: { ticks: { source: TICKS, time: "stamp" }, flags: { source: FLAGS, time: "stamp" } },
  measures: [
    { key: "ticks", entity: "ticks", agg: "count" },
    { key: "flags", entity: "flags", agg: "count" },
  ],
});

const tickTimes = () => Array.from({ length: HOURS }, (_, i) => new Date(START + i * 3600e3));
// Twelve flags on a flagged day (every other hour): half its ticks.
const flagTimes = () => Array.from({ length: DAYS * 24 }, (_, i) => i).filter((h) => flagged(Math.floor(h / 24)) && h % 2 === 0).map((h) => new Date(START + h * 3600e3));

export async function seedTicks(writer: Writer, dialect: Dialect) {
  for (const [table, times] of [[TICKS, tickTimes()], [FLAGS, flagTimes()]] as const) {
    await writer.exec(`DROP TABLE IF EXISTS ${table}`);
    await execAll(writer, [`CREATE TABLE ${table} (stamp TIMESTAMP)`], dialect);
    await insertRows(writer, table, ["stamp"], times.map((t) => [ts(t)]));
  }
}

type Request = (method: string, path: string, body?: unknown) => Promise<any>;

export async function seedTicksSearch(request: Request) {
  for (const [index, times] of [[TICKS, tickTimes()], [FLAGS, flagTimes()]] as const) {
    await request("DELETE", `/${index}`).catch(() => undefined);
    await request("PUT", `/${index}`, { settings: { number_of_shards: 1, number_of_replicas: 0 }, mappings: { properties: { stamp: { type: "date" } } } });
    for (let i = 0; i < times.length; i += 5000) {
      const lines = times.slice(i, i + 5000).flatMap((t) => [JSON.stringify({ index: {} }), JSON.stringify({ stamp: t.toISOString() })]);
      const res = await request("POST", `/${index}/_bulk`, lines.join("\n") + "\n");
      if (res?.errors) throw new Error(`bulk into ${index} reported errors`);
    }
    await request("POST", `/${index}/_refresh`);
  }
}

const window = { from: new Date(START).toISOString(), to: new Date(START + DAYS * 86400e3).toISOString() };

/** Each query with the answer every source must give. */
export const ticksCases: { label: string; query: Query; check(data: WidgetData): void }[] = [
  {
    label: "a daily ratio whose numerator has empty days, averaged",
    query: { kind: "value", measure: "flags", time: window, compute: { grain: "day", steps: [{ op: "ratio", to: "ticks" }, { op: "over_time", fn: "mean" }] } },
    // Six days at a half, three at 0: a third. Leaving out the empty days would give a half.
    check: (data) => expect(data.rows[0]!.value).toBeCloseTo(1 / 3, 9),
  },
  {
    label: "a daily ratio whose numerator has empty days, day by day",
    query: { kind: "series", measure: "flags", grain: "day", time: window, compute: { steps: [{ op: "ratio", to: "ticks" }] } },
    check: (data) => expect(data.rows.map((r) => r.value)).toEqual(Array.from({ length: DAYS }, (_, d) => (flagged(d) ? 0.5 : 0))),
  },
  {
    label: "an hourly series past the row limit",
    query: { kind: "series", measure: "ticks", grain: "hour" },
    check: (data) => {
      expect(data.truncated).toBe(true);
      expect(data.rows.length).toBe(SERIES_ROWS);
      const hour = (i: number) => `${new Date(START + i * 3600e3).toISOString().slice(0, 13)}:00`;
      expect([data.rows[0]!.group, data.rows.at(-1)!.group]).toEqual([hour(HOURS - SERIES_ROWS), hour(HOURS - 1)]);
      expect(data.notes).toEqual([`only the latest ${SERIES_ROWS.toLocaleString("en")} hours are shown; the source has more than ${SERIES_ROWS.toLocaleString("en")} rows for this series`]);
    },
  },
];
