import { describe, expect, it } from "vitest";

import { narrowLayout } from "../src/grid";

// A board authored on a wide screen has to survive a phone. The rule: keep the
// author's order, give every widget the full width, and never overlap.

const authored = [
  { i: "kpi_a", x: 0, y: 0, w: 3, h: 3 },
  { i: "kpi_b", x: 3, y: 0, w: 3, h: 3 },
  { i: "kpi_c", x: 6, y: 0, w: 3, h: 3 },
  { i: "trend", x: 0, y: 3, w: 12, h: 7 },
  { i: "left", x: 0, y: 10, w: 6, h: 8 },
  { i: "right", x: 6, y: 10, w: 6, h: 8 },
];

describe("narrowLayout", () => {
  it("stacks every widget full width, in reading order", () => {
    const out = narrowLayout(authored, 1);
    expect(out.map((l) => l.i)).toEqual(["kpi_a", "kpi_b", "kpi_c", "trend", "left", "right"]);
    expect(out.every((l) => l.x === 0 && l.w === 1)).toBe(true);
  });

  it("leaves no overlap and no gap between rows", () => {
    const out = narrowLayout(authored, 6);
    const sorted = [...out].sort((a, b) => a.y - b.y);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      expect(sorted[i]!.y).toBe(prev.y + prev.h);
    }
  });

  it("keeps each widget's authored height, so a chart stays legible", () => {
    const out = narrowLayout(authored, 1);
    for (const item of authored) expect(out.find((l) => l.i === item.i)!.h).toBe(item.h);
  });
});
