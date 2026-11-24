import { render, waitFor } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it } from "vitest";

import "./setup";
import { rechartsAdapter } from "../src/adapters/recharts";
import { svgAdapter } from "../src/adapters/svg";
import { type ChartAdapter, type ChartSpec, buildChartSpec, lazyAdapter, pivot } from "../src/charts";

// Adapter conformance: one fixed ChartSpec through every adapter, every chart
// kind. jsdom has no layout, so the assertion is "mounts, no throw, leaves a
// chart element behind".

const spec = (chart: ChartSpec["chart"], split = false): ChartSpec => ({
  chart,
  title: "Fixture",
  rows: split
    ? [{ group: "north", a: 3, b: 1 }, { group: "south", a: 2, b: 4 }, { group: "east", a: 1, b: 2 }]
    : [{ group: "north", value: 3 }, { group: "south", value: 2 }, { group: "east", value: 1 }],
  groupKey: "group",
  keys: split ? ["a", "b"] : ["value"],
  label: (k) => (k === "value" ? "Count" : k.toUpperCase()),
  format: (v) => `${v}`,
  palette: ["var(--lp-series-1)", "var(--lp-series-2)"],
  legend: true,
});

// lazyAdapter: the same adapter, loaded on first use.
const adapters: ChartAdapter[] = [svgAdapter, rechartsAdapter, lazyAdapter("svg, lazily", async () => svgAdapter)];

for (const adapter of adapters) {
  describe(`adapter ${adapter.name}`, () => {
    for (const kind of ["bar", "line", "area", "pie"] as const) {
      it(`renders a ${kind}`, async () => {
        const { container } = render(
          <div style={{ width: 600, height: 300 }}>
            <adapter.Chart spec={spec(kind, kind !== "pie")} />
          </div>,
        );
        await waitFor(() => expect(container.querySelector("svg, .recharts-responsive-container")).toBeTruthy());
      });
    }
  });
}

describe("svg adapter (deterministic)", () => {
  it("draws one bar per group per series and labels the axis", () => {
    const { container } = render(<svgAdapter.Chart spec={spec("bar", true)} />);
    expect(container.querySelectorAll("rect").length).toBe(6);
    expect(container.textContent).toContain("north");
    expect(container.querySelectorAll(".lp-svg-legend span").length).toBe(2);
  });
  it("draws one slice per row for a pie", () => {
    const { container } = render(<svgAdapter.Chart spec={spec("pie")} />);
    expect(container.querySelectorAll("path").length).toBe(3);
  });
});

describe("buildChartSpec", () => {
  it("pivots split series and applies the measure format", () => {
    const p = pivot([
      { group: "2026-01-01", series: "web", value: 1, count: 1 },
      { group: "2026-01-01", series: "app", value: 2, count: 1 },
      { group: "2026-01-02", series: "web", value: 3, count: 1 },
    ]);
    expect(p.keys).toEqual(["web", "app"]);
    expect(p.rows).toEqual([{ group: "2026-01-01", web: 1, app: 2 }, { group: "2026-01-02", web: 3 }]);
    const s = buildChartSpec(
      { kind: "chart", chart: "line", title: "T", query: { kind: "series", measure: "rate", grain: "day", by: "channel" }, options: { legend: false, colorScheme: "sequential" } },
      { rows: [{ group: "d", series: "web", value: 0.25, count: 4 }], total: 4, format: "percent" },
      { measureLabel: "Rate" },
    )!;
    expect(s.format(0.25)).toBe("25%");
    expect(s.palette[0]).toBe("var(--lp-sequential-1)");
    expect(s.label("web")).toBe("web");
  });
});
