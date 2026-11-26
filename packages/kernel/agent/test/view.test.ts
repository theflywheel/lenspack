// The viewer's place on the host's page as turn context: only tab ids travel from the page, and the
// prompt names the tabs from the host's own layout.
import { memoryStore, stagedStore } from "@lenspack/core";
import { describe, expect, it } from "vitest";

import { tabsText, viewFrom } from "../src";

describe("the viewer's open tab as turn context", () => {
  it("keeps only tab ids from the request", () => {
    expect(viewFrom({ tabs: ["TAB-ov", "TAB-trend"] })).toEqual({ tabs: ["TAB-ov", "TAB-trend"] });
    expect(viewFrom({ tabs: ["TAB-ok", "<b>no</b>", 3, "x".repeat(200)], other: true })).toEqual({ tabs: ["TAB-ok"] });
    expect(viewFrom({ tabs: [] })).toBeUndefined();
    expect(viewFrom("TAB-ov")).toBeUndefined();
    expect(viewFrom(null)).toBeUndefined();
  });

  it("names each tab's widgets and the viewer's tab, innermost first; nothing for a board without tabs", () => {
    const tabs = [
      { id: "TAB-ov", title: "Overview", widgets: ["c1", "c2"] },
      { id: "TAB-trend", title: "Overview › Trend", widgets: [] },
      { id: "TAB-stock", title: "Stock", widgets: ["c3"] },
    ];
    const text = tabsText(tabs, { tabs: ["TAB-ov", "TAB-trend"] });
    expect(text).toContain("- “Overview”: c1, c2\n- “Overview › Trend”: (no widgets)\n- “Stock”: c3");
    expect(text).toContain("The viewer is on the tab “Overview › Trend”.");
    expect(text).toContain("place it after: or below: a widget on that tab");
    expect(tabsText(tabs, { tabs: ["TAB-gone"] })).toContain("Which tab the viewer is on is not known.");
    expect(tabsText([], { tabs: ["TAB-ov"] })).toBe("");
    expect(tabsText(undefined)).toBe("");
  });

  it("a staged store asks the store underneath first, so a refusal comes while the turn can still say so", async () => {
    const inner = memoryStore();
    const seen: unknown[] = [];
    Object.assign(inner, { admit: async (_id: string, ops: { op: string }[], view?: unknown) => (seen.push(view), ops.some((o) => o.op === "set_title") ? "no titles here" : null) });
    await inner.create({ id: "b", pack: { pack: "p", version: 1 }, title: "B" });
    const staged = stagedStore(inner, "b");
    const r = await staged.patch({ id: "b", ops: [{ op: "set_title", title: "New" }], catalogue: { dimensions: [], measures: [], entities: [] } as never, view: { tabs: ["TAB-a"] } });
    expect(r).toEqual({ ok: false, error: "no titles here" });
    expect(seen).toEqual([{ tabs: ["TAB-a"] }]);
    expect(typeof staged.admit).toBe("function");
  });
});
