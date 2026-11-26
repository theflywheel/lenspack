// When to pre-warm. Questions come in predictable bursts (a morning briefing, an evening review),
// and they are mostly the same questions. So shortly before each burst the most-asked saved answers
// are refreshed (reuseLayer's prewarm): their queries run again and their replies are rebuilt, and
// the first questions of the burst are answered at once from data read minutes before.

/** The local date and minute of the day in a time zone. */
export function localClock(at: Date, timeZone: string): { date: string; minutes: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

/** How long after a scheduled time a refresh may still start (a server restarted just after it). */
export const CATCH_UP_MINUTES = 30;

/** The times due now that have not run today: at or after the time, and within the catch-up window. */
export function dueTimes(times: string[], at: Date, timeZone: string, ranOn: Map<string, string>): string[] {
  const local = localClock(at, timeZone);
  return times.filter((t) => {
    const [h, m] = t.split(":").map(Number);
    const since = local.minutes - (h! * 60 + m!);
    return since >= 0 && since < CATCH_UP_MINUTES && ranOn.get(t) !== local.date;
  });
}
