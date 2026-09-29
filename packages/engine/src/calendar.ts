// Calendar windows in a time zone. A board's date range is local dates —
// "29/08/2026 → 29/09/2026" in Nairobi — and a query needs the instants they
// start and end at. Intl carries the zone rules, so there is no tz database
// to ship and daylight saving comes out right.

const parts = (ms: number, timeZone: string) => {
  const f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year!, m: +p.month!, d: +p.day!, h: +p.hour!, mi: +p.minute!, s: +p.second! };
};

/** The instant a local date begins in `timeZone`. */
export function startOfLocalDay(date: string, timeZone = "UTC"): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  let guess = Date.UTC(y, m - 1, d);
  // Two passes settle the zone offset, including across a DST change.
  for (let i = 0; i < 2; i++) {
    const p = parts(guess, timeZone);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
    guess -= asUtc - Date.UTC(y, m - 1, d);
  }
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
