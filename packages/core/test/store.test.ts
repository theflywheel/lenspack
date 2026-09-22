import { describe, expect, it } from "vitest";

import { memoryStore } from "../src/store";
import { summarise } from "../src/summarise";
import { catalogue, packRef } from "./fixtures";

describe("memory store", () => {
  it("versions every patch and lets a rollback be undone", async () => {
    const store = memoryStore();
    const board = await store.create({ id: "x", pack: packRef, title: "T" });
    expect(board.version).toBe(1);

    const patched = await store.patch({
      id: "x",
      catalogue,
      ops: [{ op: "add_widget", id: "a", widget: { kind: "kpi", title: "K", query: { kind: "value", measure: "count" }, aggregate: "last" } }],
    });
    expect(patched.ok).toBe(true);
    if (!patched.ok) return;
    expect(patched.board.version).toBe(2);

    const reverted = await store.revertTo("x", 1);
    expect(reverted?.version).toBe(3);
    expect(Object.keys(reverted!.config.widgets)).toHaveLength(0);

    const versions = await store.versions("x");
    expect(versions.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(versions[0]?.source).toBe("revert");
  });

  it("rejects a stale expected version", async () => {
    const store = memoryStore();
    await store.create({ id: "x", pack: packRef, title: "T" });
    const result = await store.patch({ id: "x", catalogue, ops: [{ op: "set_title", title: "New" }], expectedVersion: 7 });
    expect(result.ok).toBe(false);
  });

  it("summarises by row", async () => {
    const store = memoryStore();
    await store.create({ id: "x", pack: packRef, title: "T" });
    const r = await store.patch({
      id: "x",
      catalogue,
      ops: [
        { op: "add_widget", id: "a", widget: { kind: "kpi", title: "Total", query: { kind: "value", measure: "count" }, aggregate: "last" }, placement: { place: "top", width: "third" } },
        { op: "add_widget", id: "b", widget: { kind: "chart", chart: "bar", title: "By region", query: { kind: "breakdown", dimension: "region", measure: "count", limit: 12, sort: "desc" }, options: { legend: true, colorScheme: "default" } } },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const text = summarise(r.board.config);
    expect(text).toContain("row 1: a (kpi, 4/12 wide) count “Total”");
    // A third and a half fit side by side, so both land on row 1.
    expect(text).toContain("| b (bar, 6/12 wide) count by region “By region”");
  });
});
