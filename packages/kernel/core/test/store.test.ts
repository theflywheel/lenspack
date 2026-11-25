import { describe, expect, it } from "vitest";

import { emptyBoard } from "../src/schema";
import { type BoardStore, describeOps, memoryStore, stagedStore } from "../src/store";
import { summarise, widthWords } from "../src/summarise";
import { catalogue, packRef } from "./fixtures";

describe("memory store", () => {
  it("versions every patch and lets a rollback be undone", async () => {
    const store = memoryStore();
    const board = await store.create({ id: "x", pack: packRef, title: "T" });
    expect(board.version).toBe(1);

    const patched = await store.patch({
      id: "x",
      catalogue,
      ops: [{ op: "add_widget", id: "a", widget: { kind: "kpi", title: "K", query: { kind: "value", measure: "count" } } }],
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

  it("quotes the start of a text tile, so a placeholder for a chart says what it stands for", async () => {
    const store = memoryStore();
    await store.create({ id: "t", pack: packRef, title: "T" });
    const long = `Kept as Superset has it: a heatmap of visits by site and day. ${"More words here. ".repeat(20)}`;
    const r = await store.patch({ id: "t", catalogue, ops: [{ op: "add_widget", id: "n", widget: { kind: "text", title: "Visits, site by day", body: long } }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const text = summarise(r.board.config);
    expect(text).toContain("n (text, half width (6/12)) says “Kept as Superset has it: a heatmap of visits by site and day.");
    const quoted = /says “(.*?)”/.exec(text)![1]!;
    expect(quoted.length).toBeLessThanOrEqual(200);
    expect(quoted.endsWith("…")).toBe(true);
  });

  it("keeps who a board is shared with, apart from its versions", async () => {
    const store = memoryStore();
    await store.create({ id: "x", pack: packRef, title: "T", owner: "ann", tenant: "t1" });
    expect(await store.get("x")).toMatchObject({ owner: "ann", tenant: "t1", shared: false, everyone: false, people: [] });
    await store.share("x", { everyone: false, people: ["bob"] });
    await store.patch({ id: "x", catalogue, ops: [{ op: "set_title", title: "New" }] });
    expect(await store.get("x")).toMatchObject({ version: 2, shared: true, everyone: false, people: ["bob"] });
    expect((await store.list())[0]).toMatchObject({ shared: true, everyone: false, people: ["bob"] });
    await store.share("x", { everyone: true, people: [] });
    expect(await store.get("x")).toMatchObject({ shared: true, everyone: true, people: [] });
    // The pack's own boards have no owner and are not shared by anyone.
    await store.create({ id: "pack", pack: packRef, title: "P" });
    expect(await store.share("pack", { everyone: true, people: [] })).toBeNull();
  });

  it("summarises by row", async () => {
    const store = memoryStore();
    await store.create({ id: "x", pack: packRef, title: "T" });
    const r = await store.patch({
      id: "x",
      catalogue,
      ops: [
        { op: "add_widget", id: "a", widget: { kind: "kpi", title: "Total", query: { kind: "value", measure: "count" } }, placement: { place: "top", width: "third" } },
        { op: "add_widget", id: "b", widget: { kind: "chart", chart: "bar", title: "By region", query: { kind: "breakdown", dimension: "region", measure: "count", limit: 12, sort: "desc" }, options: { legend: true, colorScheme: "default" } } },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const text = summarise(r.board.config);
    expect(text).toContain("row 1: a (kpi, a third width (4/12)) count “Total”");
    // A third and a half fit side by side, so both land on row 1.
    expect(text).toContain("| b (bar, half width (6/12)) count by region “By region”");
  });
});

describe("restoring", () => {
  it("records nothing when the restored version is what the board already shows", async () => {
    const { memoryStore, emptyBoard } = await import("../src");
    const store = memoryStore();
    await store.create({ id: "b", pack: { pack: "p", version: 1 }, title: "B", config: emptyBoard({ pack: "p", version: 1 }, "B") });
    const before = (await store.versions("b")).length;
    const same = await store.revertTo("b", 1);
    expect(same?.version).toBe(1);
    expect((await store.versions("b")).length).toBe(before);
  });
});

describe("widthWords", () => {
  it("names the common widths and gives the columns, plain n/12 otherwise", () => {
    expect(widthWords(12)).toBe("full width (12/12)");
    expect(widthWords(9)).toBe("three quarters width (9/12)");
    expect(widthWords(8)).toBe("two thirds width (8/12)");
    expect(widthWords(6)).toBe("half width (6/12)");
    expect(widthWords(4)).toBe("a third width (4/12)");
    expect(widthWords(3)).toBe("a quarter width (3/12)");
    expect(widthWords(5)).toBe("5/12 width");
    expect(widthWords(24, 24)).toBe("full width (24/24)");
    expect(widthWords(6, 24)).toBe("6/24 width");
  });
});

describe("staged store", () => {
  const kpi = { op: "add_widget", id: "a", widget: { kind: "kpi", title: "K", query: { kind: "value", measure: "count" } } } as const;

  it("holds a board's edits until commit; reads see them, the store underneath does not", async () => {
    const inner = memoryStore();
    await inner.create({ id: "x", pack: packRef, title: "T" });
    const staged = stagedStore(inner, "x");
    const r = await staged.patch({ id: "x", catalogue, ops: [kpi], source: "chat" });
    expect(r.ok && r.board.version).toBe(2);
    await staged.revertTo("x", 1);
    await staged.patch({ id: "x", catalogue, ops: [{ op: "set_title", title: "New" }], source: "chat" });
    expect((await staged.get("x"))!.config.title).toBe("New");
    expect((await staged.versions("x")).map((v) => `${v.version} ${v.summary}`)).toEqual(["4 renamed to “New”", "3 restored v1", "2 added a", "1 created"]);
    expect((await inner.get("x"))!.version).toBe(1);
    await staged.commit();
    expect((await inner.versions("x")).map((v) => `${v.version} ${v.source} ${v.summary}`)).toEqual(["4 chat renamed to “New”", "3 revert restored v1", "2 chat added a", "1 create created"]);
    // After a commit it reads through again.
    expect((await staged.get("x"))!.version).toBe(4);
  });

  it("discard leaves the store underneath untouched; a commit keeps an edit made there meanwhile", async () => {
    const inner = memoryStore();
    await inner.create({ id: "x", pack: packRef, title: "T" });
    const staged = stagedStore(inner, "x");
    await staged.patch({ id: "x", catalogue, ops: [kpi] });
    staged.discard();
    expect((await staged.get("x"))!.version).toBe(1);
    expect(await inner.versions("x")).toHaveLength(1);

    await staged.patch({ id: "x", catalogue, ops: [kpi] });
    await inner.patch({ id: "x", catalogue, ops: [{ op: "set_title", title: "By hand" }] });
    await staged.commit();
    const now = (await inner.get("x"))!;
    expect(now.config.title).toBe("By hand");
    expect(Object.keys(now.config.widgets)).toEqual(["a"]);
    // The turn's edits, applied again on top of the edit by hand, are saved as one version.
    expect((await inner.versions("x")).map((v) => v.version)).toEqual([3, 2, 1]);
  });

  it("after a change underneath that a later edit no longer fits, saves nothing and says which edit", async () => {
    const inner = memoryStore();
    await inner.create({ id: "x", pack: packRef, title: "T" });
    await inner.patch({ id: "x", catalogue, ops: [{ ...kpi, id: "w" }] });
    const staged = stagedStore(inner, "x");
    // The first edit would still fit; the second changes a widget that is about to be removed by hand.
    await staged.patch({ id: "x", catalogue, ops: [kpi], source: "chat" });
    await staged.patch({ id: "x", catalogue, ops: [{ op: "update_widget", id: "w", widget: { ...kpi.widget, title: "W" } }], source: "chat" });
    await inner.patch({ id: "x", catalogue, ops: [{ op: "remove_widget", id: "w" }] });
    await expect(staged.commit()).rejects.toThrow('the board was changed meanwhile, and "changed w" no longer fits it (No widget called "w"). Nothing was saved');
    expect((await inner.versions("x")).map((v) => v.version)).toEqual([3, 2, 1]);
    expect((await inner.get("x"))!.config.widgets).toEqual({});
    // The held edits are gone either way: the next turn starts from the store.
    expect((await staged.get("x"))!.version).toBe(3);
  });

  it("a store underneath that refuses a later edit is put back where it was", async () => {
    const inner = memoryStore();
    await inner.create({ id: "x", pack: packRef, title: "T" });
    let patches = 0;
    const refusing: BoardStore = { ...inner, patch: async (input) => (++patches === 2 ? { ok: false, error: "the host did not take it" } : inner.patch(input)) };
    const staged = stagedStore(refusing, "x");
    await staged.patch({ id: "x", catalogue, ops: [kpi] });
    await staged.patch({ id: "x", catalogue, ops: [{ op: "set_title", title: "New" }] });
    await expect(staged.commit()).rejects.toThrow("the host did not take it");
    const now = (await inner.get("x"))!;
    expect(now.config.title).toBe("T");
    expect(now.config.widgets).toEqual({});
    expect((await inner.versions("x")).map((v) => `${v.version} ${v.summary}`)).toEqual(["3 restored v1", "2 added a", "1 created"]);
  });

  it("asOne saves where the edits ended up as one version, so a corrected edit never reaches the store", async () => {
    const inner = memoryStore();
    await inner.create({ id: "x", pack: packRef, title: "T" });
    const staged = stagedStore(inner, "x");
    await staged.patch({ id: "x", catalogue, ops: [kpi], source: "chat" });
    await staged.patch({ id: "x", catalogue, ops: [{ op: "remove_widget", id: "a" }, { ...kpi, id: "b" }], source: "chat" });
    await staged.commit({ asOne: true });
    expect((await inner.versions("x")).map((v) => `${v.version} ${v.source} ${v.summary}`)).toEqual(["2 chat added “K”", "1 create created"]);
    expect(Object.keys((await inner.get("x"))!.config.widgets)).toEqual(["b"]);
  });
});

describe("describeOps", () => {
  it("names a filter by its label, as the board shows it", () => {
    const filter = { id: "f1", type: "select" as const, label: "Region", field: "region", applies: ["*"] };
    const board = { ...emptyBoard(packRef, "T"), filters: [filter] };
    expect(describeOps([{ op: "add_filter", filter }, { op: "update_filter", id: "f1", filter: { ...filter, label: "Area" } }, { op: "remove_filter", id: "f1" }], board)).toBe(
      "added filter Region, changed filter Area, removed filter Region",
    );
    // Without the board, a removed filter is named by its id.
    expect(describeOps([{ op: "remove_filter", id: "f1" }])).toBe("removed filter f1");
  });
});
