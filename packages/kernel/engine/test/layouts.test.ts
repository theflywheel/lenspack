import { type BoardConfig, type Widget, emptyBoard } from "@lenspack/core";
import { describe, expect, it } from "vitest";

import { pack } from "../../../sources/sql/test/fixture-pack";
import { fitSavedLayout } from "../src";

// A saved layout put on another board: what the board and the person can take, the rest named.

describe("a saved layout on another board", () => {
  const kpi: Widget = { kind: "kpi", title: "Things", query: { kind: "value", measure: "things" } } as Widget;
  const unknown: Widget = { kind: "kpi", title: "Gone", query: { kind: "value", measure: "no_such_measure" } } as Widget;
  const host: Widget = { kind: "text", title: "A host chart", body: "kept" } as Widget;
  const saved: BoardConfig = {
    ...emptyBoard(pack, "Saved"),
    widgets: { k: kpi, gone: unknown, c12: host },
    filters: [
      { id: "c", type: "select", label: "Colour", field: "colour", applies: ["k", "gone"] },
      { id: "h", type: "host", label: "Theirs", field: "colour", applies: ["*"], note: "kept" },
    ],
  };
  const target: BoardConfig = { ...emptyBoard(pack, "Mine"), widgets: { c12: { ...host, title: "Mine, not theirs" } } };

  it("keeps the board's title, leaves out and names what can't be drawn, and never takes over a host chart", () => {
    const r = fitSavedLayout(saved, target, pack, { ctx: { tenant: "t1" }, savedLocked: ["c12"], targetLocked: ["c12"] });
    expect(r.config.title).toBe("Mine");
    expect(Object.keys(r.config.widgets).sort()).toEqual(["c12", "k"]);
    expect(r.config.widgets.c12!.title).toBe("Mine, not theirs");
    expect(r.skipped.map((s) => s.title)).toEqual(["Gone"]);
    expect(r.config.filters.map((f) => [f.id, f.applies])).toEqual([["c", ["k"]]]);
    expect(r.skippedFilters.map((f) => f.label)).toEqual(["Theirs"]);
  });

  it("leaves out a host chart from another dashboard", () => {
    const r = fitSavedLayout(saved, emptyBoard(pack, "Blank"), pack, { ctx: { tenant: "t1" }, savedLocked: ["c12"] });
    expect(r.skipped.map((s) => s.title).sort()).toEqual(["A host chart", "Gone"]);
    expect(Object.keys(r.config.widgets)).toEqual(["k"]);
    // How much it carried: one of three, one left with its own dashboard (the other could not be drawn at all).
    expect(r.carried).toEqual({ widgets: 1, of: 3, stayed: 1 });
    expect(fitSavedLayout(saved, target, pack, { ctx: { tenant: "t1" }, savedLocked: ["c12"], targetLocked: ["c12"] }).carried).toEqual({ widgets: 2, of: 3, stayed: 0 });
  });
});
