import { describe, expect, it } from "vitest";

import { formatBucket, formatTick, timeOf, timeTicks } from "../src/charts";

const d = (s: string) => Date.parse(`${s}T00:00:00Z`);
const iso = (ts: number[]) => ts.map((t) => new Date(t).toISOString().slice(0, 10));

describe("time axis", () => {
  it("reads the engine's bucket labels as UTC", () => {
    expect(timeOf("2025-06-16")).toBe(d("2025-06-16"));
    expect(timeOf("2025-06-16T14:00")).toBe(Date.parse("2025-06-16T14:00:00Z"));
  });

  it("ticks month starts over a few months, not arbitrary data points", () => {
    expect(iso(timeTicks(d("2025-05-04"), d("2025-09-20"), "day"))).toEqual(["2025-06-01", "2025-07-01", "2025-08-01", "2025-09-01"]);
  });

  it("ticks Mondays over a few weeks and days over a week", () => {
    const weeks = timeTicks(d("2025-06-02"), d("2025-07-10"), "day");
    expect(weeks.every((t) => new Date(t).getUTCDay() === 1)).toBe(true);
    expect(iso(weeks)[0]).toBe("2025-06-02");
    expect(timeTicks(d("2025-06-02"), d("2025-06-06"), "day")).toHaveLength(5);
  });

  it("widens the step to stay under the tick budget on a long span", () => {
    const t = timeTicks(d("2025-05-04"), d("2026-04-15"), "day");
    expect(t.length).toBeLessThanOrEqual(8);
    expect(t.every((x) => new Date(x).getUTCDate() === 1)).toBe(true);
    expect(iso(t)[0]).toBe("2025-06-01");
  });

  it("labels ticks and tooltip headings by grain", () => {
    expect(formatTick(d("2025-06-16"), "day", false)).toBe("16 Jun");
    expect(formatTick(d("2025-06-16"), "day", true)).toBe("16 Jun 25");
    expect(formatTick(d("2025-06-01"), "month", true)).toBe("Jun 2025");
    expect(formatBucket(d("2025-06-16"), "day")).toBe("Mon 16 Jun 2025");
    expect(formatBucket(d("2025-06-16"), "week")).toBe("Week of 16 Jun 2025");
    expect(formatBucket(d("2025-04-01"), "quarter")).toBe("Q2 2025");
  });
});
