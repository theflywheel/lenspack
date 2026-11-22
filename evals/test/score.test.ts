import { describe, expect, it } from "vitest";

import { grounding, heuristicDecline, numberMatches, numbersIn, parseJudge, queryMisses, scoreAnswer } from "../score";
import type { Truth } from "../suite";

const n = (s: string) => numbersIn(s)[0]!;

describe("numbers in a reply", () => {
  it("reads thousands separators, percentages and rounded forms, and skips dates", () => {
    expect(numbersIn("31,642 children (91.26%) between 12 Oct 2026 and 2026-10-18").map((x) => [x.value, x.pct])).toEqual([
      [31642, false],
      [91.26, true],
    ]);
    expect(n("about 31.6k").value).toBe(31600);
    expect(numbersIn("Day 3 had the most")).toEqual([]);
  });

  it("holds ratios to ±0.1 pp, or half the precision shown, never looser than ±0.5 pp", () => {
    const truth = 0.91264; // a sum over sum (made-up figures throughout)
    expect(numberMatches(truth, "ratio", n("91.26%")).ok).toBe(true);
    expect(numberMatches(truth, "ratio", n("0.913")).ok).toBe(true);
    // Averaging settlement percentages gives 91.81%: wrong.
    expect(numberMatches(truth, "ratio", n("91.81%")).ok).toBe(false);
    // "91%" is a rounding of the truth, accepted as coarse.
    expect(numberMatches(truth, "ratio", n("91%"))).toEqual({ ok: true, coarse: true });
    expect(numberMatches(truth, "ratio", n("93%")).ok).toBe(false);
  });

  it("holds counts exact, allowing a stated rounding within 0.5%", () => {
    expect(numberMatches(31642, "count", n("31,642")).ok).toBe(true);
    expect(numberMatches(31642, "count", n("31,420")).ok).toBe(false);
    expect(numberMatches(31642, "count", n("31.6k")).ok).toBe(true);
    expect(numberMatches(31642, "count", n("31,600")).ok).toBe(true);
    expect(numberMatches(31642, "count", n("31,601")).ok).toBe(false);
  });
});

describe("answers against truth", () => {
  it("takes an alternative definition and says which", () => {
    const t: Truth = { shape: "scalar", unit: "count", value: 31642, alternatives: [{ label: "no revisits", value: 31420 }] };
    expect(scoreAnswer(t, "31,420 children were vaccinated").matched).toBe("no revisits");
    expect(scoreAnswer(t, "31,642 children").matched).toBe("primary");
    expect(scoreAnswer(t, "40,000 children").correct).toBe(false);
  });

  it("finds each key of a map with its value on the same line", () => {
    const t: Truth = { shape: "map", unit: "ratio", value: { "Northgate": 0.91264, Riverside: 0.90418, Hilltop: 0.92733 } };
    expect(scoreAnswer(t, "| LGA | Coverage |\n|---|---|\n| Northgate | 91.3% |\n| Riverside | 90.4% |\n| Hilltop | 92.7% |").correct).toBe(true);
    const averaged = scoreAnswer(t, "Northgate 91.81%, Riverside 93.91%, Hilltop 93.11%");
    expect(averaged.correct).toBe(false);
  });

  it("counts naming a key outside a set against precision", () => {
    const t: Truth = { shape: "set", unit: "count", value: ["Lakeview", "Westfield", "Old Market"], universe: ["Lakeview", "Westfield", "Old Market", "Southbank", "Elmwood"] };
    expect(scoreAnswer(t, "Below 90%: Old Market, Lakeview and Westfield.").correct).toBe(true);
    const dropped = scoreAnswer(t, "Below 90%: Old Market and Lakeview.");
    expect([dropped.correct, dropped.recall.toFixed(2)]).toEqual([false, "0.67"]);
        expect(scoreAnswer(t, "Old Market, Lakeview, Westfield and Southbank").precision).toBe(0.75);
    // Named as context, not as part of the answer.
    expect(scoreAnswer(t, "Three wards are below 90%: Old Market, Lakeview and Westfield. The next lowest, Southbank, is at 91.4%.").correct).toBe(true);
  });

  it("reads series dates written as days of the month", () => {
    const t: Truth = { shape: "series", unit: "count", value: { "2026-10-12": 5120, "2026-10-13": 5988 } };
    expect(scoreAnswer(t, "- 12 Oct: 5,120\n- 13 Oct: 5,988").correct).toBe(true);
    expect(scoreAnswer(t, "Day 1: 5,120\nDay 2: 5,988").correct).toBe(true);
  });

  it("wants a list's keys in order", () => {
    const t: Truth = { shape: "list", unit: "count", k: 2, value: [["Elmwood", 2411], ["Brookside", 1987]] };
    expect(scoreAnswer(t, "1. Elmwood 2,411\n2. Brookside 1,987").correct).toBe(true);
    expect(scoreAnswer(t, "Brookside 1,987, then Elmwood 2,411").correct).toBe(false);
  });
});

describe("grounding, queries, declines", () => {
  it("flags reply numbers no tool returned", () => {
    const g = grounding("Coverage is 91.26% across 31,642 children; 12,345 more are pending.", [{ rows: [{ value: 0.91264 }, { value: 31642 }] }]);
    expect(g.ungrounded).toEqual(["12,345"]);
  });

  it("says what is off about a query", () => {
    expect(queryMisses({ kind: "breakdown", measure: "children_coverage_pct", dimension: "ward", filters: [{ dimension: "lga", op: "eq", value: "Riverside" }] }, { measure: ["children_coverage_pct"], dimension: ["ward"], filters: { lga: "Riverside" } })).toEqual([]);
    expect(queryMisses({ kind: "breakdown", measure: "children_vaccinated", dimension: "lga" }, { measure: ["children_coverage_pct"], dimension: ["ward"] })).toEqual(["measure children_vaccinated", "dimension lga"]);
  });

  it("labels declines", () => {
    expect(heuristicDecline("This data has no sales rep, so I can't break revenue down that way.", false)).toBe("declined");
    expect(heuristicDecline("There is no age split in the targets; here are vaccinations by age band: 0-11 months 8,240.", false)).toBe("degraded");
    expect(heuristicDecline("Revenue next quarter will be $1,234,567.", false)).toBe("answered");
    expect(parseJudge("Degraded.")).toBe("degraded");
  });
});
