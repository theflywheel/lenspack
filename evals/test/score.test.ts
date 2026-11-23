import { describe, expect, it } from "vitest";

import { BESIDE_CLAIM, MOVE_CLAIM, NO_ROOM, SAYS_CANT, collateral, editMisses, grounding, heuristicDecline, numberMatches, numbersIn, overlaps, parseJudge, queryMisses, scoreAnswer } from "../score";
import type { BoardConfig } from "@lenspack/core";

import { type Question, type Truth, questionSchema } from "../suite";

const n = (s: string) => numbersIn(s)[0]!;

describe("numbers in a reply", () => {
  it("reads thousands separators, percentages and rounded forms, and skips dates", () => {
    expect(numbersIn("31,642 children (91.26%) between 12 Oct 2026 and 2026-10-18").map((x) => [x.value, x.pct])).toEqual([
      [31642, false],
      [91.26, true],
    ]);
    expect(n("about 31.6k").value).toBe(31600);
    expect(numbersIn("Day 3 had the most")).toEqual([]);
    expect(numbersIn("Eight branches are above target").map((x) => [x.value, x.word])).toEqual([[8, true]]);
    expect(numbersIn("the only one")).toEqual([]);
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
    expect(scoreAnswer(t, "Old Market, Lakeview and Westfield are below 90%. The other two range from Southbank at 92.2% up to Elmwood at 95.4%.").correct).toBe(true);
  });

  it("reads series dates written as days of the month", () => {
    const t: Truth = { shape: "series", unit: "count", value: { "2026-10-12": 5120, "2026-10-13": 5988 } };
    expect(scoreAnswer(t, "- 12 Oct: 5,120\n- 13 Oct: 5,988").correct).toBe(true);
    expect(scoreAnswer(t, "Day 1: 5,120\nDay 2: 5,988").correct).toBe(true);
  });

  it("reads a top day written as Day N when the suite names day one", () => {
    const t: Truth = { shape: "list", unit: "count", k: 1, value: [["2026-03-04", 5120]], dayOne: "2026-03-02" };
    expect(scoreAnswer(t, "Day 3 had the most orders, 5,120.").correct).toBe(true);
    expect(scoreAnswer(t, "Day 2 had the most orders, 5,120.").correct).toBe(false);
  });

  it("finds a key with a full stop inside it", () => {
    const t: Truth = { shape: "map", unit: "count", value: { "St. Ann. North Depot": 39 } };
    expect(scoreAnswer(t, "- **St. Ann. North Depot:** 39 parcels").correct).toBe(true);
  });

  it("keeps a list item whole across its sentences, and reads code keys as words", () => {
    const t: Truth = { shape: "table", unit: "ratio", value: { Northgate: { a: 0.912, b: 0.109 } } };
    expect(scoreAnswer(t, "- **Northgate:** a was 91.2%. Its b was 10.9%.").correct).toBe(true);
    const c: Truth = { shape: "map", unit: "count", value: { LATE_DELIVERY: 79, NO_STOCK: 12 } };
    expect(scoreAnswer(c, "- Late or missed delivery: 79\n- Out of stock (no stock left): 12").recall).toBe(1);
    expect(scoreAnswer(c, "- Late delivery: 79").recall).toBe(0.5);
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
    // A map's points query: its size is the measure, its colour the dimension.
    expect(queryMisses({ kind: "points", size: "zero_dose_children", color: "band" }, { kind: ["points"], measure: ["zero_dose_children"], dimension: ["band"] })).toEqual([]);
    expect(queryMisses({ kind: "points", color: "band" }, { kind: ["points"], measure: ["zero_dose_children"], dimension: ["ward"] })).toEqual(["measure none", "dimension band"]);
  });

  it("labels declines", () => {
    expect(heuristicDecline("This data has no sales rep, so I can't break revenue down that way.", false)).toBe("declined");
    expect(heuristicDecline("There is no age split in the targets; here are vaccinations by age band: 0-11 months 8,240.", false)).toBe("degraded");
    expect(heuristicDecline("Revenue next quarter will be $1,234,567.", false)).toBe("answered");
    expect(parseJudge("Degraded.")).toBe("degraded");
    expect(SAYS_CANT.test("No orders were placed in the last 30 days: the data has no records in that window.")).toBe(true);
    expect(SAYS_CANT.test("Orders rose 12% outside the holiday period.")).toBe(false);
  });
});

describe("moves", () => {
  const chart = (title: string) => ({ title, kind: "chart", chart: "bar", query: { kind: "breakdown", measure: "orders", dimension: "country" } });
  const board = (layout: BoardConfig["layout"]) =>
    ({ version: 2, pack: "p", packVersion: 1, title: "B", grid: { cols: 12, rowHeight: 40 }, layout, widgets: { a: chart("Alpha"), b: chart("Beta"), c: chart("Gamma") }, filters: [] }) as unknown as BoardConfig;
  const q = questionSchema.parse({ id: "m", tier: "T7", prompt: "Move gamma up beside alpha", expect: "edit", moved: { title: "Gamma", beside: "(?i)alpha" } }) as Question;
  const start = board([{ i: "a", x: 0, y: 0, w: 6, h: 7 }, { i: "b", x: 6, y: 0, w: 6, h: 7 }, { i: "c", x: 0, y: 7, w: 12, h: 7 }]);

  it("wants the widget on the other one's row, with nothing overlapping", () => {
    expect(editMisses(q, start, start).misses).toEqual(["c not beside a (rows y=7 and y=0)"]);
    const thirds = board([{ i: "a", x: 0, y: 0, w: 4, h: 7 }, { i: "c", x: 4, y: 0, w: 4, h: 7 }, { i: "b", x: 8, y: 0, w: 4, h: 7 }]);
    expect(editMisses(q, start, thirds).misses).toEqual([]);
    const piled = board([{ i: "a", x: 0, y: 0, w: 6, h: 7 }, { i: "c", x: 3, y: 0, w: 6, h: 7 }, { i: "b", x: 6, y: 7, w: 6, h: 7 }]);
    expect(editMisses(q, start, piled).misses).toEqual(["overlapping: a/c"]);
    expect(overlaps(start.layout)).toEqual([]);
  });

  it("flags changes nobody asked for, but not the target row's", () => {
    const full = board([{ i: "a", x: 0, y: 0, w: 6, h: 7 }, { i: "b", x: 6, y: 0, w: 6, h: 7 }, { i: "c", x: 0, y: 7, w: 12, h: 7 }]);
    const w = (b: BoardConfig, extra: Record<string, unknown>) => ({ ...b, widgets: { ...b.widgets, ...extra } }) as BoardConfig;
    const before = w(full, { d: chart("Delta"), e: chart("Epsilon") });
    before.layout = [...full.layout, { i: "d", x: 0, y: 14, w: 6, h: 7 }, { i: "e", x: 6, y: 14, w: 6, h: 7 }];
    // Gamma joins Alpha's row, Beta is swapped to the bottom: Beta is a row-mate of the target, so that's fine.
    const swapped = structuredClone(before);
    swapped.layout = [{ i: "a", x: 0, y: 0, w: 6, h: 7 }, { i: "c", x: 6, y: 0, w: 6, h: 7 }, { i: "d", x: 0, y: 7, w: 6, h: 7 }, { i: "e", x: 6, y: 7, w: 6, h: 7 }, { i: "b", x: 0, y: 14, w: 12, h: 7 }];
    expect(collateral(q, before, swapped)).toEqual([]);
    // The same, but Delta and Epsilon were widened and fill switched off: collateral.
    const widened = structuredClone(swapped);
    widened.layout = [{ i: "a", x: 0, y: 0, w: 6, h: 7 }, { i: "c", x: 6, y: 0, w: 6, h: 7 }, { i: "d", x: 0, y: 7, w: 12, h: 7 }, { i: "e", x: 0, y: 14, w: 12, h: 7 }, { i: "b", x: 0, y: 21, w: 12, h: 7 }];
    (widened.grid as { fill?: boolean }).fill = false;
    (before.grid as { fill?: boolean }).fill = true;
    expect(collateral(q, before, widened)).toEqual(["board fill off", "d width 6→12", "e width 6→12"]);
  });

  it("counts a row-mate the model moved or resized itself", () => {
    const before = board([{ i: "a", x: 0, y: 0, w: 6, h: 7 }, { i: "b", x: 6, y: 0, w: 6, h: 7 }, { i: "c", x: 0, y: 7, w: 12, h: 7 }]);
    // The packing made room: Alpha and Beta narrowed, Gamma between them. Fine, with or without a call naming Beta.
    const packed = board([{ i: "a", x: 0, y: 0, w: 3, h: 7 }, { i: "c", x: 3, y: 0, w: 6, h: 7 }, { i: "b", x: 9, y: 0, w: 3, h: 7 }]);
    const move = { tool: "move_widget", input: { id: "c", place: "after:a" } };
    expect(collateral(q, before, packed, [move])).toEqual([]);
    // Narrowing Beta itself to make room is what the packing would do anyway.
    expect(collateral(q, before, packed, [move, { tool: "resize_widget", input: { id: "b", width: "quarter" } }])).toEqual([]);
    // Widening it is not.
    const narrow = board([{ i: "a", x: 0, y: 0, w: 6, h: 7 }, { i: "b", x: 6, y: 0, w: 3, h: 7 }, { i: "c", x: 0, y: 7, w: 12, h: 7 }]);
    const wider = board([{ i: "a", x: 0, y: 0, w: 3, h: 7 }, { i: "c", x: 3, y: 0, w: 3, h: 7 }, { i: "b", x: 6, y: 0, w: 6, h: 7 }]);
    expect(collateral(q, narrow, wider, [move, { tool: "resize_widget", input: { id: "b", width: "half" } }])).toEqual(["b widened 3→6 (the model's own resize_widget)"]);
    // Beta sent to a row of its own: the packing alone may do that, the model may not.
    const sent = board([{ i: "a", x: 0, y: 0, w: 6, h: 7 }, { i: "c", x: 6, y: 0, w: 6, h: 7 }, { i: "b", x: 0, y: 7, w: 12, h: 7 }]);
    expect(collateral(q, before, sent, [move])).toEqual([]);
    expect(collateral(q, before, sent, [move, { tool: "move_widget", input: { id: "b", place: "below:a" } }])).toEqual(["b moved out of its row, widened 6→12 (the model's own move_widget)"]);
    // A move the model took back with restore_version doesn't count.
    expect(collateral(q, before, sent, [{ tool: "move_widget", input: { id: "b", place: "below:a" } }, { tool: "restore_version", input: { to: "3" } }, move])).toEqual([]);
    // A refused call changed nothing of its own.
    expect(collateral(q, before, sent, [move, { tool: "move_widget", input: { id: "b" }, ok: false }])).toEqual([]);
  });

  it("reads claims and no-room replies in English and Hindi", () => {
    expect(MOVE_CLAIM.test("I've moved the ward bar next to the LGA bar.")).toBe(true);
    expect(MOVE_CLAIM.test("बार ग्राफ को ऊपर रख दिया है।")).toBe(true);
    expect(MOVE_CLAIM.test("I couldn't move it: that row is full.")).toBe(false);
    expect(BESIDE_CLAIM.test("It now sits beside the LGA bar.")).toBe(true);
    expect(NO_ROOM.test("That row is full, so there's no room beside it.")).toBe(true);
    expect(NO_ROOM.test("ऊपर वाली पंक्ति में जगह नहीं है।")).toBe(true);
  });
});
