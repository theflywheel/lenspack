import { describe, expect, it } from "vitest";

import { applyOps, compact, migrateKeys, nearest, opSchema, pack, type BoardOp } from "../src/ops";
import { emptyBoard, type BoardConfig } from "../src/schema";
import { catalogue, packRef } from "./fixtures";

// The validator is the trust boundary: if it passes, the board renders
// correctly. These are the failure modes a language model actually produces —
// invented fields, overlapping rectangles, references to things it removed
// earlier in the same batch.

function chart(over: Partial<Record<string, unknown>> = {}) {
  return {
    kind: "chart" as const,
    chart: "bar" as const,
    title: "Count by region",
    query: { kind: "breakdown" as const, dimension: "region", measure: "count", limit: 12 },
    options: { legend: true, colorScheme: "default" as const },
    ...over,
  };
}

function apply(config: BoardConfig, ops: unknown[]) {
  const parsed = ops.map((op) => opSchema.parse(op)) as BoardOp[];
  return applyOps(config, parsed, catalogue);
}

const empty = () => emptyBoard(packRef, "Board");

describe("adding widgets", () => {
  it("places the first widget at the origin", () => {
    const result = apply(empty(), [{ op: "add_widget", id: "a", widget: chart() }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.layout[0]).toMatchObject({ i: "a", x: 0, y: 0 });
    expect(result.config.widgets.a?.title).toBe("Count by region");
  });

  it("never overlaps, however many widgets are added", () => {
    let config = empty();
    for (let i = 0; i < 9; i++) {
      const result = apply(config, [
        { op: "add_widget", id: `w${i}`, widget: chart(), placement: { place: "bottom", width: "third" } },
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      config = result.config;
    }
    for (const a of config.layout) {
      for (const b of config.layout) {
        if (a.i === b.i) continue;
        const overlaps = a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
        expect(overlaps).toBe(false);
      }
    }
  });

  it("lays three thirds across the top rather than stacking them", () => {
    let config = empty();
    for (const id of ["a", "b", "c"]) {
      const result = apply(config, [
        {
          op: "add_widget",
          id,
          widget: { kind: "kpi", title: `KPI ${id}`, query: { kind: "value", measure: "count" } },
          placement: { place: "top", width: "third", height: 3 },
        },
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      config = result.config;
    }
    expect(config.layout.every((item) => item.y === 0)).toBe(true);
    expect(new Set(config.layout.map((item) => item.x)).size).toBe(3);
  });

  it("pairs two halves on one row, and gives a full width its own", () => {
    let config = empty();
    const add = (id: string, width: "half" | "full") => {
      const result = apply(config, [{ op: "add_widget", id, widget: chart(), placement: { place: "bottom", width, height: 6 } }]);
      expect(result.ok).toBe(true);
      if (result.ok) config = result.config;
    };
    add("a", "half");
    add("b", "half");
    add("c", "full");
    const at = (id: string) => config.layout.find((item) => item.i === id)!;
    expect(at("b").y).toBe(at("a").y);
    expect(at("b").x).toBe(6);
    expect(at("c").y).toBeGreaterThan(at("a").y);
  });

  it("puts a widget above the others when asked for the top", () => {
    const first = apply(empty(), [{ op: "add_widget", id: "a", widget: chart() }]);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = apply(first.config, [
      { op: "add_widget", id: "b", widget: { kind: "kpi", title: "K", query: { kind: "value", measure: "count" } }, placement: { place: "top", width: "full" } },
    ]);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const a = second.config.layout.find((i) => i.i === "a")!;
    const b = second.config.layout.find((i) => i.i === "b")!;
    expect(b.y).toBeLessThan(a.y);
  });

  it("refuses a duplicate id rather than overwriting a widget", () => {
    const first = apply(empty(), [{ op: "add_widget", id: "a", widget: chart() }]);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(apply(first.config, [{ op: "add_widget", id: "a", widget: chart() }]).ok).toBe(false);
  });
});

describe("hallucinated fields", () => {
  it("rejects a dimension that does not exist and suggests the real one", () => {
    const result = apply(empty(), [
      { op: "add_widget", id: "a", widget: chart({ query: { kind: "breakdown", dimension: "regoin", measure: "count", limit: 12 } }) },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("regoin");
    expect(result.hint).toBe("region");
  });

  it("rejects a measure that does not exist", () => {
    const result = apply(empty(), [
      { op: "add_widget", id: "a", widget: chart({ query: { kind: "breakdown", dimension: "region", measure: "amont", limit: 12 } }) },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.hint).toBe("amount");
  });

  it("rejects a series grouped by an unknown dimension", () => {
    const result = apply(empty(), [
      { op: "add_widget", id: "a", widget: chart({ chart: "line", query: { kind: "series", measure: "count", grain: "day", by: "chanel" } }) },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.hint).toBe("channel");
  });

  it("refuses a series on a measure whose entity has no time", () => {
    const result = apply(empty(), [
      { op: "add_widget", id: "a", widget: chart({ chart: "line", query: { kind: "series", measure: "owner_count", grain: "day" } }) },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("no time column");
  });

  it("refuses a breakdown by a time dimension and points at series", () => {
    const result = apply(empty(), [
      { op: "add_widget", id: "a", widget: chart({ query: { kind: "breakdown", dimension: "created", measure: "count", limit: 12 } }) },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.hint).toBe("series");
  });

  it("refuses a pie of a rate, because rates do not sum to a whole", () => {
    const result = apply(empty(), [
      { op: "add_widget", id: "a", widget: chart({ chart: "pie", query: { kind: "breakdown", dimension: "region", measure: "share_rate", limit: 12 } }) },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("rates do not");
  });

  it("requires a time range for a previous-period comparison", () => {
    const result = apply(empty(), [
      { op: "add_widget", id: "a", widget: { kind: "kpi", title: "K", query: { kind: "value", measure: "count", compare: "previous_period" } } },
    ]);
    expect(result.ok).toBe(false);
  });

  it("rejects rows columns that belong to another entity", () => {
    const result = apply(empty(), [
      { op: "add_widget", id: "a", widget: { kind: "table", title: "T", query: { kind: "rows", entity: "items", columns: ["region", "owner_tier"], limit: 10 }, pageSize: 10 } },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("owner_tier");
  });

  it("rejects a filter clause on an unknown dimension", () => {
    const result = apply(empty(), [
      { op: "add_widget", id: "a", widget: chart({ query: { kind: "breakdown", dimension: "region", measure: "count", limit: 12, filters: [{ dimension: "chanel", op: "eq", value: "x" }] } }) },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.hint).toBe("channel");
  });
});

describe("referential integrity", () => {
  it("removing a widget takes its layout entry and its filter targets with it", () => {
    const built = apply(empty(), [
      { op: "add_widget", id: "a", widget: chart() },
      { op: "add_widget", id: "b", widget: chart() },
      { op: "add_filter", filter: { id: "f", type: "select", label: "Region", field: "region", applies: ["a", "b"] } },
    ]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const removed = apply(built.config, [{ op: "remove_widget", id: "a" }]);
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.config.layout.some((i) => i.i === "a")).toBe(false);
    expect(removed.config.filters[0]?.applies).toEqual(["b"]);
  });

  it("drops a filter left pointing at nothing", () => {
    const built = apply(empty(), [
      { op: "add_widget", id: "a", widget: chart() },
      { op: "add_filter", filter: { id: "f", type: "select", label: "Region", field: "region", applies: ["a"] } },
    ]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const removed = apply(built.config, [{ op: "remove_widget", id: "a" }]);
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.config.filters).toHaveLength(0);
  });

  it("refuses a filter aimed at a widget that does not exist", () => {
    expect(apply(empty(), [{ op: "add_filter", filter: { id: "f", type: "select", label: "R", field: "region", applies: ["ghost"] } }]).ok).toBe(false);
  });

  it("refuses a filter on something that is not a dimension", () => {
    const built = apply(empty(), [{ op: "add_widget", id: "a", widget: chart() }]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const result = apply(built.config, [{ op: "add_filter", filter: { id: "f", type: "select", label: "Amount", field: "amount", applies: ["a"] } }]);
    expect(result.ok).toBe(false);
  });
});

describe("a batch is all or nothing", () => {
  it("leaves the board untouched when the second op fails", () => {
    const built = apply(empty(), [{ op: "add_widget", id: "a", widget: chart() }]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const before = JSON.stringify(built.config);
    const result = apply(built.config, [
      { op: "add_widget", id: "b", widget: chart() },
      { op: "remove_widget", id: "ghost" },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.opIndex).toBe(1);
    expect(JSON.stringify(built.config)).toBe(before);
  });
});

describe("layout normalisation", () => {
  it("floats widgets up rather than leaving a hole", () => {
    expect(compact([{ i: "a", x: 0, y: 7, w: 6, h: 4 }], 12)[0]!.y).toBe(0);
  });
  it("pulls a widget wider than the grid back inside it", () => {
    expect(compact([{ i: "a", x: 0, y: 0, w: 40, h: 4 }], 12)[0]!.w).toBe(12);
  });
  it("keeps two widgets on the same row when they fit", () => {
    const settled = compact([{ i: "a", x: 0, y: 0, w: 6, h: 4 }, { i: "b", x: 6, y: 3, w: 6, h: 4 }], 12);
    expect(settled.find((i) => i.i === "b")!.y).toBe(0);
  });
});

describe("suggestions", () => {
  it("names the nearest real key", () => {
    expect(nearest("regoin", ["region", "channel"])).toBe("region");
  });
  it("says nothing rather than guessing wildly", () => {
    expect(nearest("zzzzzzzzz", ["region", "channel"])).toBeNull();
  });
});

describe("migrations", () => {
  it("renames keys everywhere a board refers to them", () => {
    const built = apply(empty(), [
      { op: "add_widget", id: "a", widget: chart({ query: { kind: "breakdown", dimension: "region", measure: "count", limit: 12, filters: [{ dimension: "channel", op: "eq", value: "web" }] } }) },
      { op: "add_filter", filter: { id: "f", type: "select", label: "Region", field: "region", applies: ["a"] } },
    ]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const migrated = migrateKeys(built.config, { region: "area", channel: "medium" });
    const w = migrated.widgets.a!;
    expect(w.kind === "chart" && w.query.kind === "breakdown" && w.query.dimension).toBe("area");
    expect(w.kind === "chart" && w.query.filters?.[0]?.dimension).toBe("medium");
    expect(migrated.filters[0]?.field).toBe("area");
  });
});

describe("packing", () => {
  it("closes gaps and widens the last widget on each row", () => {
    const packed = pack(
      [
        { i: "a", x: 0, y: 0, w: 3, h: 3 },
        { i: "b", x: 6, y: 0, w: 3, h: 3 }, // gap between a and b, gap after b
        { i: "c", x: 0, y: 3, w: 6, h: 6 },
      ],
      12,
    );
    const at = (id: string) => packed.find((l) => l.i === id)!;
    expect([at("a").x, at("a").w]).toEqual([0, 3]);
    expect([at("b").x, at("b").w]).toEqual([3, 9]);
    expect([at("c").x, at("c").w]).toEqual([0, 12]);
  });

  it("does not grow into a taller widget from the row above", () => {
    const packed = pack(
      [
        { i: "tall", x: 8, y: 0, w: 4, h: 6 },
        { i: "a", x: 0, y: 0, w: 4, h: 3 },
        { i: "b", x: 0, y: 3, w: 4, h: 3 },
      ],
      12,
    );
    const at = (id: string) => packed.find((l) => l.i === id)!;
    // The tall widget slides left next to a and takes the rest of the row; b
    // below can only grow up to the tall widget's edge.
    expect([at("a").x, at("a").w]).toEqual([0, 4]);
    expect([at("tall").x, at("tall").w]).toEqual([4, 8]);
    expect([at("b").x, at("b").w]).toEqual([0, 4]);
    for (const p of packed) for (const q of packed) if (p.i !== q.i) expect(p.x < q.x + q.w && p.x + p.w > q.x && p.y < q.y + q.h && p.y + p.h > q.y).toBe(false);
  });

  it("set_layout_mode with fill packs every later edit too", () => {
    const built = apply(empty(), [
      { op: "add_widget", id: "k", widget: { kind: "kpi", title: "K", query: { kind: "value", measure: "count" } }, placement: { place: "top", width: "quarter" } },
      { op: "set_layout_mode", density: "compact", fill: true },
    ]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.config.grid.density).toBe("compact");
    expect(built.config.layout[0]!.w).toBe(12);
    const more = apply(built.config, [{ op: "add_widget", id: "c", widget: chart(), placement: { place: "bottom", width: "third" } }]);
    expect(more.ok && more.config.layout.find((l) => l.i === "c")!.w).toBe(12);
  });
});
