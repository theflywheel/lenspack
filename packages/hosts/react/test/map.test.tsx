import { render } from "@testing-library/react";
import * as React from "react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import "./setup";
import { MAP_COLOURS, MapChart, buildMapSpec, fit, gridStep, project, radiusOf, unproject } from "../src/map";
import type { WidgetData } from "../src/types";

// Made-up points on a made-up patch of the world.
const widget = (query: Record<string, unknown>, legend = true) => ({ kind: "chart", chart: "map", title: "Sites", options: { legend, colorScheme: "default" }, query: { kind: "points", entity: "site", limit: 1000, ...query } }) as never;
const data = (records: Record<string, unknown>[]): WidgetData => ({ rows: [], records, columns: Object.keys(records[0] ?? {}), total: records.length, format: "number" });
const POINTS = [
  { lat: 10.2, lon: 4.1, site: "Site A", band: "Band 2", people: 400 },
  { lat: 11.5, lon: 4.6, site: "Site B", band: "Band 10", people: 100 },
  { lat: 10.8, lon: 5.9, site: "Site C", band: "Band 2", people: 25 },
];

// jsdom has no layout: report a 600×400 box once observed.
const Original = globalThis.ResizeObserver;
beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    constructor(private cb: (e: { contentRect: { width: number; height: number } }[]) => void) {}
    observe() {
      this.cb([{ contentRect: { width: 600, height: 400 } }]);
    }
    unobserve() {}
    disconnect() {}
  };
});
afterAll(() => {
  globalThis.ResizeObserver = Original;
});

describe("map", () => {
  it("projects to Web Mercator and back", () => {
    expect(project(0, 0)).toEqual({ x: 0.5, y: 0.5 });
    const back = unproject(project(10.5, 4.25).x, project(10.5, 4.25).y);
    expect(back.lat).toBeCloseTo(10.5, 9);
    expect(back.lon).toBeCloseTo(4.25, 9);
    expect(project(30, 0).y).toBeLessThan(0.5);
  });

  it("fits every point inside the box with a margin, and gives a lone point a sensible zoom", () => {
    const pts = POINTS.map((p) => project(p.lat, p.lon));
    const v = fit(pts, 600, 400);
    for (const p of pts) {
      const [x, y] = [(p.x - v.x0) * v.scale, (p.y - v.y0) * v.scale];
      expect(x).toBeGreaterThanOrEqual(27.9);
      expect(x).toBeLessThanOrEqual(572.1);
      expect(y).toBeGreaterThanOrEqual(27.9);
      expect(y).toBeLessThanOrEqual(372.1);
    }
    expect(Number.isFinite(fit([pts[0]!], 600, 400).scale)).toBe(true);
  });

  it("sizes by area between the smallest and largest, and picks round grid steps", () => {
    expect(radiusOf(null, null)).toBe(5);
    expect(radiusOf(25, [25, 400])).toBe(3);
    expect(radiusOf(400, [25, 400])).toBe(18);
    expect(radiusOf(100, [0, 400])).toBeCloseTo(3 + 0.5 * 15);
    expect(radiusOf(7, [7, 7])).toBe(10.5);
    expect(gridStep(1.8)).toBe(0.5);
    expect(gridStep(40)).toBe(10);
  });

  it("draws many points smaller", async () => {
    const { densityOf } = await import("../src/map");
    expect([densityOf(100), densityOf(1000), densityOf(5000)]).toEqual([1, 0.7, 0.45]);
  });

  it("builds categories in reading order (numbers in number order), and groups past eight colours", () => {
    const spec = buildMapSpec(widget({ color: "band", label: "site", size: "people" }), data(POINTS), { colorName: "Band", sizeName: "People" })!;
    expect(spec.categories).toEqual([{ name: "Band 2", step: 1 }, { name: "Band 10", step: 2 }]);
    expect(spec.sizeRange).toEqual([25, 400]);
    const many = Array.from({ length: 12 }, (_, i) => ({ lat: i, lon: i, band: `B${i}` }));
    const grouped = buildMapSpec(widget({ color: "band" }), data(many))!;
    expect(grouped.categories).toHaveLength(MAP_COLOURS);
    expect(grouped.categories.at(-1)).toEqual({ name: "other (5)", step: 0 });
    expect(buildMapSpec(widget({}), data([]))).toBeNull();
  });

  it("draws a point per record with its colour and a name a screen reader can read, a grid, and a legend", () => {
    const spec = buildMapSpec(widget({ color: "band", label: "site", size: "people" }), data(POINTS), { colorName: "Band", sizeName: "People" })!;
    const { container } = render(<MapChart spec={spec} />);
    const pts = Array.from(container.querySelectorAll("circle.lp-map-pt"));
    expect(pts).toHaveLength(3);
    // Biggest first, so a small point is drawn on top.
    expect(pts[0]!.getAttribute("aria-label")).toBe("Site A, Band: Band 2, People: 400");
    expect(pts[2]!.getAttribute("class")).toContain("lp-map-c1");
    expect(container.querySelectorAll(".lp-map-grid line").length).toBeGreaterThan(2);
    expect(container.querySelector(".lp-map-legend")!.textContent).toContain("People: 25 to 400");
    expect(container.querySelector(".lp-map-tiles")).toBeNull();
  });

  it("puts a host's tiles under the points, with their attribution, and none by default", () => {
    const spec = buildMapSpec(widget({}), data(POINTS))!;
    const { container } = render(<MapChart spec={spec} tiles={{ url: "https://tiles.example.org/{z}/{x}/{y}.png", attribution: "© Example tiles" }} />);
    const imgs = Array.from(container.querySelectorAll(".lp-map-tiles img"));
    expect(imgs.length).toBeGreaterThan(0);
    expect(imgs[0]!.getAttribute("src")).toMatch(/^https:\/\/tiles\.example\.org\/\d+\/\d+\/\d+\.png$/);
    expect(container.querySelector(".lp-map-attr")!.textContent).toBe("© Example tiles");
    expect(container.querySelector(".lp-map-grid")).toBeNull();
  });
});
