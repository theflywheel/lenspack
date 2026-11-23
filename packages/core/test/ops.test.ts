import { describe, expect, it } from "vitest";

import { applyOps, compact, migrateKeys, nearest, opSchema, pack, type BoardOp } from "../src/ops";
import { emptyBoard, widgetSchema, type BoardConfig } from "../src/schema";
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

function kpi(over: Partial<Record<string, unknown>> = {}) {
  return { kind: "kpi" as const, title: "KPI", query: { kind: "value" as const, measure: "count" }, ...over };
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

  it("lets a table, not a chart, carry several measures beside a split", () => {
    const query = { kind: "breakdown" as const, dimension: "region", by: "channel", measure: "count", measures: ["amount"], limit: 12 };
    const table = apply(empty(), [{ op: "add_widget", id: "a", widget: { kind: "table", title: "T", query, pageSize: 10 } }]);
    expect(table.ok).toBe(true);
    const bar = apply(empty(), [{ op: "add_widget", id: "a", widget: chart({ query }) }]);
    expect(bar.ok).toBe(false);
    if (bar.ok) return;
    expect(bar.error).toMatch(/one measure/);
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

describe("further measures on one widget", () => {
  it("checks every measure key and refuses what a widget cannot draw", async () => {
    const { checkQuery } = await import("../src/ops");
    const cat = {
      pack: "p", version: 1,
      entities: [{ key: "e", hasTime: true, hasTenant: false }],
      dimensions: [{ key: "d", label: "D", entity: "e", type: "string" as const, synonyms: [], verified: true }],
      measures: ["a", "b"].map((key) => ({ key, label: key, entity: "e", format: "number" as const, synonyms: [], verified: true })),
    };
    expect(checkQuery({ kind: "breakdown", dimension: "d", measure: "a", measures: ["b"], limit: 5, sort: "desc" }, cat)).toBeNull();
    expect(checkQuery({ kind: "breakdown", dimension: "d", measure: "a", measures: ["bb"], limit: 5, sort: "desc" }, cat)).toMatchObject({ hint: "b" });
    expect(checkQuery({ kind: "series", measure: "a", measures: ["b"], grain: "day", by: "d" }, cat)?.error).toMatch(/one measure/);
  });
});

describe("adding one call at a time, on a packed board", () => {
  // Chat tools send one op per call. Each call compacts and packs, so the board
  // after three separate adds must be the board one batch of the same ops makes.
  const text = (title: string) => ({ kind: "text" as const, title, body: "x" });
  const packed = (): BoardConfig => {
    const board = empty();
    board.grid.fill = true;
    for (const id of ["a", "b", "c", "d", "e"]) board.widgets[id] = text(id);
    board.layout = [
      { i: "a", x: 0, y: 0, w: 6, h: 7 },
      { i: "b", x: 6, y: 0, w: 6, h: 7 },
      { i: "c", x: 0, y: 7, w: 3, h: 4 },
      { i: "d", x: 3, y: 7, w: 3, h: 4 },
      { i: "e", x: 0, y: 11, w: 12, h: 7 },
    ];
    return board;
  };
  const add = (id: string, place: string, width = "third") => ({ op: "add_widget", id, widget: text(id), placement: { place, width, height: 3 } });
  const oneByOne = (board: BoardConfig, ops: unknown[]) => {
    let config = board;
    for (const op of ops) {
      const r = apply(config, [op]);
      if (!r.ok) throw new Error(r.error);
      config = r.config;
    }
    return config;
  };
  const boxes = (config: BoardConfig) =>
    [...config.layout].sort((p, q) => p.i.localeCompare(q.i)).map(({ i, x, y, w, h }) => ({ i, x, y, w, h }));
  const overlaps = (config: BoardConfig) =>
    config.layout.some((p, n) => config.layout.some((q, m) => n < m && p.x < q.x + q.w && p.x + p.w > q.x && p.y < q.y + q.h && p.y + p.h > q.y));

  it("three 'top, third' KPIs make a row, the same as one batch", () => {
    const ops = [add("k1", "top"), add("k2", "after:k1"), add("k3", "after:k2")];
    const sequential = oneByOne(packed(), ops);
    const batch = apply(packed(), ops);
    if (!batch.ok) throw new Error(batch.error);
    expect(boxes(sequential)).toEqual(boxes(batch.config));
    const row = sequential.layout.filter((l) => l.i.startsWith("k")).sort((p, q) => p.x - q.x);
    expect(row.map(({ x, y, w }) => [x, y, w])).toEqual([[0, 0, 4], [4, 0, 4], [8, 0, 4]]);
    // The charts that were on top sit side by side below the new row, untouched.
    expect(sequential.layout.find((l) => l.i === "a")).toMatchObject({ x: 0, y: 3, w: 6 });
    expect(sequential.layout.find((l) => l.i === "b")).toMatchObject({ x: 6, y: 3, w: 6 });
    expect(overlaps(sequential)).toBe(false);
  });

  it("each 'top' KPI joins the top row too", () => {
    const ops = [add("k1", "top"), add("k2", "top"), add("k3", "top")];
    const sequential = oneByOne(packed(), ops);
    const batch = apply(packed(), ops);
    if (!batch.ok) throw new Error(batch.error);
    expect(boxes(sequential)).toEqual(boxes(batch.config));
    expect(sequential.layout.filter((l) => l.y === 0).map((l) => l.i).sort()).toEqual(["k1", "k2", "k3"]);
  });

  it("a lone widget is widened to the edge, and gives the room back to the next one", () => {
    const first = oneByOne(packed(), [add("k1", "top")]);
    expect(first.layout.find((l) => l.i === "k1")).toMatchObject({ x: 0, y: 0, w: 12, fw: 4 });
    const second = oneByOne(first, [add("k2", "after:k1")]);
    expect(second.layout.find((l) => l.i === "k1")).toMatchObject({ x: 0, w: 4 });
    expect(second.layout.find((l) => l.i === "k1")?.fw).toBeUndefined();
    expect(second.layout.find((l) => l.i === "k2")).toMatchObject({ x: 4, y: 0, w: 8, fw: 4 });
  });

  it("mixed widths: a third and a half share a row, then a full-width widget wraps", () => {
    const ops = [add("k1", "top"), add("k2", "after:k1", "half"), add("k3", "after:k2", "full")];
    const sequential = oneByOne(packed(), ops);
    const batch = apply(packed(), ops);
    if (!batch.ok) throw new Error(batch.error);
    expect(boxes(sequential)).toEqual(boxes(batch.config));
    const k1 = sequential.layout.find((l) => l.i === "k1")!;
    const k2 = sequential.layout.find((l) => l.i === "k2")!;
    const k3 = sequential.layout.find((l) => l.i === "k3")!;
    expect([k1.y, k2.y]).toEqual([0, 0]);
    expect(k2.x).toBe(4);
    expect(k3.y).toBeGreaterThanOrEqual(3);
    expect(k3.w).toBe(12);
    expect(overlaps(sequential)).toBe(false);
  });

  it("a full row wraps: the fourth third leaves the top row of three alone", () => {
    // Where it lands below depends on what packing widened there (only widgets of the
    // same height give room back), so this checks the row and the absence of overlaps.
    const ops = [add("k1", "top"), add("k2", "after:k1"), add("k3", "after:k2"), add("k4", "after:k3")];
    const sequential = oneByOne(packed(), ops);
    const row = sequential.layout.filter((l) => l.y === 0).sort((p, q) => p.x - q.x);
    expect(row.map(({ i, x, w }) => [i, x, w])).toEqual([["k1", 0, 4], ["k2", 4, 4], ["k3", 8, 4]]);
    expect(sequential.layout.find((l) => l.i === "k4")!.y).toBeGreaterThan(0);
    expect(overlaps(sequential)).toBe(false);
  });

  it("an unpacked board keeps its exact widths", () => {
    const board = packed();
    board.grid.fill = false;
    const sequential = oneByOne(board, [add("k1", "top")]);
    const k1 = sequential.layout.find((l) => l.i === "k1")!;
    expect(k1).toMatchObject({ x: 0, y: 0, w: 4 });
    expect(k1.fw).toBeUndefined();
  });

  it("a mouse-sized width is the widget's own: a layout without fw is never shrunk", () => {
    const board = packed();
    board.layout = [{ i: "a", x: 0, y: 0, w: 12, h: 3 }];
    board.widgets = { a: text("a") };
    const r = oneByOne(board, [add("k1", "after:a")]);
    expect(r.layout.find((l) => l.i === "a")).toMatchObject({ x: 0, y: 0, w: 12 });
    expect(r.layout.find((l) => l.i === "k1")!.y).toBe(3);
  });
});

describe("resize_widget", () => {
  it("growing a widget pushes what it now covers down instead of overlapping it", () => {
    const board = empty();
    const text = (title: string) => ({ kind: "text" as const, title, body: "x" });
    board.widgets = { a: text("A"), b: text("B"), c: text("C") };
    board.layout = [
      { i: "a", x: 0, y: 0, w: 6, h: 7 },
      { i: "b", x: 6, y: 0, w: 6, h: 7 },
      { i: "c", x: 0, y: 7, w: 6, h: 7 },
    ];
    const r = apply(board, [{ op: "resize_widget", id: "a", width: "full", height: 9 }]);
    if (!r.ok) throw new Error(r.error);
    const box = (id: string) => r.config.layout.find((l) => l.i === id)!;
    expect(box("a")).toMatchObject({ x: 0, y: 0, w: 12, h: 9 });
    expect(box("b").y).toBeGreaterThanOrEqual(9);
    expect(box("c").y).toBeGreaterThanOrEqual(9);
    const ls = r.config.layout;
    const overlap = ls.some((p, n) => ls.some((q, m) => n < m && p.x < q.x + q.w && p.x + p.w > q.x && p.y < q.y + q.h && p.y + p.h > q.y));
    expect(overlap).toBe(false);
  });
});

describe("fill room goes only to a widget of the same height", () => {
  it("a chart added after a lone KPI starts its own row", () => {
    const board = empty();
    board.grid.fill = true;
    const kpi = apply(board, [{ op: "add_widget", id: "k", widget: { kind: "kpi", title: "K", query: { kind: "value", measure: "count" } }, placement: { place: "top", width: "quarter" } }]);
    if (!kpi.ok) throw new Error(kpi.error);
    const more = apply(kpi.config, [{ op: "add_widget", id: "c", widget: chart(), placement: { place: "bottom", width: "third" } }]);
    if (!more.ok) throw new Error(more.error);
    expect(more.config.layout.find((l) => l.i === "k")).toMatchObject({ y: 0, w: 12 });
    expect(more.config.layout.find((l) => l.i === "c")).toMatchObject({ y: 3, w: 12 });
  });
});

describe("moving widgets", () => {
  // A packed board whose rows are all full, like a Superset dashboard read back: a lone
  // full-width chart at the bottom, bar charts in the rows near the top.
  const full = () => {
    const board = empty();
    board.grid.fill = true;
    const items: [string, number, number, number, number][] = [
      ["k1", 0, 0, 6, 3], ["k2", 6, 0, 6, 3],
      ["lga", 0, 3, 4, 7], ["perday", 4, 3, 8, 7],
      ["outcomes", 0, 10, 6, 7], ["refused", 6, 10, 6, 7],
      ["fresh", 0, 17, 12, 3], ["ward", 0, 20, 12, 7],
    ];
    for (const [i, x, y, w, h] of items) {
      board.widgets[i] = widgetSchema.parse(chart({ title: i }));
      board.layout.push({ i, x, y, w, h });
    }
    return board;
  };
  const at = (config: BoardConfig, id: string) => config.layout.find((item) => item.i === id);

  it("makes room beside the anchor in a full row, shrinking its neighbours in proportion", () => {
    const result = apply(full(), [
      { op: "resize_widget", id: "ward", width: "half" },
      { op: "move_widget", id: "ward", placement: { place: "after:lga", width: "half" } },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // lga 4 + perday 8 make room for a half: both down to the narrowest a chart goes (3).
    expect(at(result.config, "lga")).toMatchObject({ x: 0, y: 3, w: 3 });
    expect(at(result.config, "ward")).toMatchObject({ x: 3, y: 3, w: 6 });
    expect(at(result.config, "perday")).toMatchObject({ x: 9, y: 3, w: 3 });
    // No other row changed width.
    for (const id of ["k1", "k2", "outcomes", "refused", "fresh"]) expect(at(result.config, id)!.w).toBe(at(full(), id)!.w);
  });

  it("puts the widget on a new row under the anchor's row with below:", () => {
    const result = apply(full(), [{ op: "move_widget", id: "ward", placement: { place: "below:lga", width: "full" } }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(at(result.config, "ward")).toMatchObject({ x: 0, y: 10, w: 12 });
    // Everything that was below the anchor's row moved down by the moved widget's height, in order.
    expect(at(result.config, "outcomes")).toMatchObject({ y: 17 });
    expect(at(result.config, "fresh")).toMatchObject({ y: 24 });
  });

  it("puts the moved widget beside the anchor in the eval's shape: bar and pie half wide, a full-width bar moved after the bar", () => {
    const board = empty();
    board.grid.fill = true;
    for (const [i, x, y, w, h, kind] of [
      ["kpi1", 0, 0, 12, 3, "kpi"],
      ["c49", 0, 3, 6, 7, "chart"], ["pie", 6, 3, 6, 7, "chart"],
      ["zd", 0, 10, 6, 7, "chart"], ["line", 6, 10, 6, 7, "chart"],
      ["notes", 0, 17, 12, 3, "text"],
      ["c50", 0, 20, 12, 7, "chart"],
    ] as const) {
      board.widgets[i] = widgetSchema.parse(kind === "kpi" ? kpi({ title: i }) : kind === "text" ? { kind: "text", title: i, body: i } : chart({ title: i }));
      board.layout.push({ i, x, y, w, h });
    }
    // What the move tool sends: resize, then move, in one call.
    const result = apply(board, [
      { op: "resize_widget", id: "c50", width: "half" },
      { op: "move_widget", id: "c50", placement: { place: "after:c49", width: "half" } },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.config.layout.filter((item) => item.y === 3).sort((a, b) => a.x - b.x);
    expect(row.map((item) => [item.i, item.w])).toEqual([["c49", 3], ["c50", 6], ["pie", 3]]);
    // Nothing outside that row changed width.
    for (const id of ["kpi1", "zd", "line", "notes"]) expect(at(result.config, id)!.w).toBe(board.layout.find((item) => item.i === id)!.w);
  });

  it("says the row is full, with the choices, when making room would squeeze a widget too far", () => {
    const board = empty();
    for (const [i, x] of [["a", 0], ["b", 3], ["c", 6], ["d", 9]] as const) {
      board.widgets[i] = widgetSchema.parse(chart({ title: i }));
      board.layout.push({ i, x, y: 0, w: 3, h: 7 });
    }
    board.widgets.e = widgetSchema.parse(chart({ title: "e" }));
    board.layout.push({ i: "e", x: 0, y: 7, w: 12, h: 7 });
    const result = apply(board, [{ op: "resize_widget", id: "e", width: "half" }, { op: "move_widget", id: "e", placement: { place: "after:b", width: "half" } }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/row of "b" is full/);
    expect(result.hint).toMatch(/below:b/);
  });

  it("does not widen the neighbours a moved widget leaves behind, only a widget left alone", () => {
    const board = empty();
    board.grid.fill = true;
    for (const [i, x, y, w] of [["a", 0, 0, 4], ["b", 4, 0, 4], ["c", 8, 0, 4], ["d", 0, 7, 6], ["e", 6, 7, 6]] as const) {
      board.widgets[i] = widgetSchema.parse(chart({ title: i }));
      board.layout.push({ i, x, y, w, h: 7 });
    }
    const result = apply(board, [{ op: "move_widget", id: "b", placement: { place: "bottom", width: "third" } }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // a and c keep their widths; b, alone on a row the move made, fills it.
    expect(at(result.config, "a")!.w).toBe(4);
    expect(at(result.config, "c")!.w).toBe(4);
    expect(at(result.config, "d")!.w).toBe(6);
    expect(at(result.config, "e")!.w).toBe(6);
  });

  it("keeps the width a widget was resized to on a packed board", () => {
    const result = apply(full(), [{ op: "resize_widget", id: "ward", width: "half" }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(at(result.config, "ward")!.w).toBe(6);
  });

  it("puts a widget beside the anchor when the anchor's row has room", () => {
    const board = full();
    board.layout = board.layout.map((item) => (item.i === "perday" ? { ...item, w: 4 } : item));
    board.grid.fill = false;
    // The move tool resizes first, so the move looks for room at the width asked for.
    const result = apply(board, [{ op: "resize_widget", id: "ward", width: "third" }, { op: "move_widget", id: "ward", placement: { place: "after:lga", width: "third" } }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(at(result.config, "ward")).toMatchObject({ x: 8, y: 3, w: 4 });
  });

  it("joins the gaps in the anchor's row to make room (the commerce eval's C16)", () => {
    // Not packed: weekly revenue and the category chart half wide on one row, the country
    // bar alone and full width below. Three separate calls, as a model makes them.
    const board = empty();
    for (const [i, x, y, w, h] of [["revenue_trend", 0, 3, 6, 7], ["by_category", 6, 3, 6, 7], ["by_country", 0, 10, 12, 7]] as const) {
      board.widgets[i] = widgetSchema.parse(chart({ title: i }));
      board.layout.push({ i, x, y, w, h });
    }
    let config = board;
    for (const ops of [
      [{ op: "resize_widget", id: "revenue_trend", width: "third" }],
      [{ op: "resize_widget", id: "by_category", width: "third" }],
      [{ op: "resize_widget", id: "by_country", width: "third" }, { op: "move_widget", id: "by_country", placement: { place: "after:revenue_trend", width: "third" } }],
    ]) {
      const result = apply(config, ops);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      config = result.config;
    }
    const y = at(config, "revenue_trend")!.y;
    expect(at(config, "by_country")).toMatchObject({ y, w: 4 });
    expect(config.layout.filter((item) => item.y === y).map((item) => item.x).sort((a, b) => a - b)).toEqual([0, 4, 8]);
  });

  it("rejects a move that leaves the widget where it was", () => {
    const result = apply(full(), [{ op: "move_widget", id: "ward", placement: { place: "after:fresh", width: "full" } }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/changes nothing/);
  });
});
