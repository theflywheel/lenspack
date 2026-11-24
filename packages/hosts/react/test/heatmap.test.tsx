import { render } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it } from "vitest";

import "./setup";
import { HEAT_STEPS, HeatmapChart, buildHeatmapSpec, heatStep } from "../src/heatmap";
import type { WidgetData } from "../src/types";

const widget = (query: Record<string, unknown>) => ({ kind: "chart", chart: "heatmap", title: "Visits, site by day", options: { legend: true, colorScheme: "sequential" }, query }) as never;
const data = (rows: { group: string; series: string; value: number | null }[]): WidgetData => ({ rows: rows.map((r) => ({ ...r, count: 1 })), total: 0, format: "number" });

describe("heatmap", () => {
  it("puts a value in one of eight steps from low to high, and one value across the grid mid-scale", () => {
    expect(heatStep(0, 0, 80)).toBe(1);
    expect(heatStep(80, 0, 80)).toBe(HEAT_STEPS);
    expect(heatStep(41, 0, 80)).toBe(5);
    expect(heatStep(-5, -10, 10)).toBe(3);
    expect(heatStep(7, 7, 7)).toBe(4);
  });

  it("lays out a breakdown: columns as they come, rows A to Z (numbers in number order), and keeps no-value apart from no-row", () => {
    const spec = buildHeatmapSpec(
      widget({ kind: "breakdown", dimension: "day_label", by: "site", measure: "visits", limit: 12, sort: "asc", sortBy: "group" }),
      data([
        { group: "Day 1", series: "Site 10", value: 4 },
        { group: "Day 1", series: "Site 2", value: 9 },
        { group: "Day 2", series: "Site 2", value: null },
        { group: "Day 3", series: "Site 1", value: 0 },
      ]),
      { measureLabel: "Visits", xName: "Day", yName: "Site" },
    )!;
    expect(spec.xs).toEqual(["Day 1", "Day 2", "Day 3"]);
    expect(spec.ys).toEqual(["Site 1", "Site 2", "Site 10"]);
    expect([spec.min, spec.max]).toEqual([0, 9]);
    const { container } = render(<div style={{ width: 600, height: 300 }}><HeatmapChart spec={spec} /></div>);
    const cells = Array.from(container.querySelectorAll(".lp-heat-cell"));
    expect(cells).toHaveLength(9);
    expect(container.querySelector('[aria-label="Site 2, Day 1: 9"]')!.className).toContain(`lp-heat-s${HEAT_STEPS}`);
    expect(container.querySelector('[aria-label="Site 1, Day 3: 0"]')!.className).toContain("lp-heat-s1");
    expect(container.querySelector('[aria-label="Site 2, Day 2: no value"]')!.className).toContain("lp-heat-null");
    expect(container.querySelector('[aria-label="Site 10, Day 3: no data"]')!.className).toContain("lp-heat-none");
    expect(container.querySelector(".lp-heat-legend")!.textContent).toContain("no data");
    expect(container.querySelector(".lp-heat")!.getAttribute("aria-label")).toBe("Visits, site by day: Visits by Site and Day");
  });

  it("orders a series' days in time and labels them as dates", () => {
    const spec = buildHeatmapSpec(
      widget({ kind: "series", measure: "visits", grain: "day", by: "site" }),
      data([
        { group: "2026-03-03", series: "B", value: 1 },
        { group: "2026-03-01", series: "A", value: 2 },
        { group: "2026-03-02", series: "A", value: 3 },
      ]),
    )!;
    expect(spec.xs).toEqual(["2026-03-01", "2026-03-02", "2026-03-03"]);
    expect(spec.xLabel("2026-03-01")).toBe("1 Mar");
    expect(spec.xTitle("2026-03-01")).toBe("Sun 1 Mar 2026");
  });

  it("has nothing to draw without a split", () => {
    expect(buildHeatmapSpec(widget({ kind: "breakdown", dimension: "site", measure: "visits", limit: 12 }), { rows: [{ group: "A", value: 1, count: 1 }], total: 1, format: "number" })).toBeNull();
  });
});
