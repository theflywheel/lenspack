// Calendar windows in a time zone. A board's date range is local dates —
// "29/08/2026 → 29/09/2026" in Nairobi — and a query needs the instants they
// start and end at. Intl carries the zone rules, so there is no tz database
// to ship and daylight saving comes out right.

import type { TimeRange } from "@lenspack/core";

const parts = (ms: number, timeZone: string) => {
  const f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year!, m: +p.month!, d: +p.day!, h: +p.hour!, mi: +p.minute!, s: +p.second! };
};

/** An instant's local time in `timeZone`, written as UTC: how a naive local timestamp reads. */
export function localWallClock(ms: number, timeZone: string): number {
  const p = parts(ms, timeZone);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
}

/** The zone series buckets are cut in: none for UTC, however it is spelled ("Etc/UTC", "GMT"). */
export const bucketZone = (timeZone?: string) =>
  timeZone && new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone !== "UTC" ? timeZone : undefined;

/** The instant a local date begins in `timeZone`. */
export function startOfLocalDay(date: string, timeZone = "UTC"): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  let guess = Date.UTC(y, m - 1, d);
  // Two passes settle the zone offset, including across a DST change.
  for (let i = 0; i < 2; i++) guess -= localWallClock(guess, timeZone) - Date.UTC(y, m - 1, d);
  return new Date(guess);
}

/** The local date of an instant in `timeZone`, as YYYY-MM-DD. */
export function localDate(at: Date, timeZone = "UTC"): string {
  const p = parts(at.getTime(), timeZone);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Calendar months back, clamped to the target month's last day (31 Mar − 1 month = 28/29 Feb). */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const last = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + months, Math.min(d, last))).toISOString().slice(0, 10);
}

type CalendarRange = Extract<TimeRange, { period: unknown }>;
type Period = CalendarRange["period"];

// The local date the period holding `date` starts on; weeks start on Monday.
function periodStart(date: string, period: Period): string {
  const month = Number(date.slice(5, 7));
  switch (period) {
    case "day":
      return date;
    case "week":
      return addDays(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7));
    case "month":
      return `${date.slice(0, 7)}-01`;
    case "quarter":
      return `${date.slice(0, 4)}-${String(month - ((month - 1) % 3)).padStart(2, "0")}-01`;
    case "year":
      return `${date.slice(0, 4)}-01-01`;
  }
}

function addPeriods(date: string, period: Period, n: number): string {
  if (period === "day" || period === "week") return addDays(date, period === "week" ? 7 * n : n);
  return addMonths(date, { month: 1, quarter: 3, year: 12 }[period] * n);
}

/**
 * A calendar range as instants, with the span a previous-period comparison
 * reads: the `count` periods before it, cut as far into itself as a range
 * running to now is (in local days and time of day, never past its end).
 */
export function calendarRange(range: CalendarRange, now: Date, timeZone = "UTC"): { from: Date; to: Date; previous: { from: Date; to: Date } } {
  const { period, offset = 0, count = 1 } = range;
  const today = localDate(now, timeZone);
  const current = periodStart(today, period);
  const first = addPeriods(current, period, offset - count + 1);
  const before = addPeriods(first, period, -count);
  const from = startOfLocalDay(first, timeZone);
  const previousFrom = startOfLocalDay(before, timeZone);
  if (offset < 0) return { from, to: startOfLocalDay(addPeriods(current, period, offset + 1), timeZone), previous: { from: previousFrom, to: from } };
  const days = (Date.parse(today) - Date.parse(first)) / 86400e3;
  const sinceMidnight = now.getTime() - startOfLocalDay(today, timeZone).getTime();
  const previousTo = Math.min(startOfLocalDay(addDays(before, days), timeZone).getTime() + sinceMidnight, from.getTime());
  return { from, to: now, previous: { from: previousFrom, to: new Date(previousTo) } };
}

/** "from..to" (inclusive local dates) → the half-open window [from 00:00, to+1 00:00). */
export function dateRangeWindow(value: string, timeZone = "UTC"): { from: string; to: string } | null {
  const m = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(value);
  if (!m) return null;
  return { from: startOfLocalDay(m[1]!, timeZone).toISOString(), to: startOfLocalDay(addDays(m[2]!, 1), timeZone).toISOString() };
}

/** A daterange filter's default ("the last month") as "from..to" local dates ending today. */
export function defaultRange(def: { months?: number; days?: number } | undefined, now: Date, timeZone = "UTC"): string | null {
  if (!def || (!def.months && !def.days)) return null;
  const today = localDate(now, timeZone);
  const from = def.months ? addMonths(today, -def.months) : addDays(today, -(def.days! - 1));
  return `${from}..${today}`;
}
