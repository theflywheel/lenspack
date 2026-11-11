import { describe, expect, it } from "vitest";

import { changesSince, describeChanges, listInWords } from "../src/changes";
import { memoryStore } from "../src/store";
import { catalogue, packRef } from "./fixtures";

const kpi = (title: string) => ({ kind: "kpi" as const, title, query: { kind: "value" as const, measure: "count" }, aggregate: "last" as const });

async function boardWithThree() {
  const store = memoryStore();
  await store.create({ id: "x", pack: packRef, title: "T" });
  const r = await store.patch({
    id: "x",
    catalogue,
    source: "chat",
    ops: [
      { op: "add_widget", id: "a", widget: kpi("Alpha"), placement: { place: "bottom", width: "half" } },
      { op: "add_widget", id: "b", widget: kpi("Beta"), placement: { place: "bottom", width: "half" } },
      { op: "add_widget", id: "c", widget: kpi("Gamma"), placement: { place: "bottom", width: "full" } },
    ],
  });
  if (!r.ok) throw new Error(r.error);
  return { store, board: r.board };
}

describe("describeChanges", () => {
  it("names a removed widget by its title, and does not call the widgets that closed the gap moved", async () => {
    const { store, board } = await boardWithThree();
    const r = await store.patch({ id: "x", catalogue, ops: [{ op: "remove_widget", id: "a" }] });
    if (!r.ok) throw new Error(r.error);
    expect(describeChanges(board.config, r.board.config)).toEqual(["removed “Alpha”"]);
  });

  it("reports a widget dragged to another place, and a resize", async () => {
    const { board } = await boardWithThree();
    const layout = board.config.layout.map((l) => (l.i === "c" ? { ...l, y: 0, w: 6 } : l.i === "a" || l.i === "b" ? { ...l, y: l.y + 4 } : l));
    expect(describeChanges(board.config, { ...board.config, layout })).toEqual(["moved and resized “Gamma”"]);
    const taller = board.config.layout.map((l) => (l.i === "b" ? { ...l, h: l.h + 2 } : l));
    expect(describeChanges(board.config, { ...board.config, layout: taller })).toEqual(["resized “Beta”"]);
  });

  it("is empty when nothing changed", async () => {
    const { board } = await boardWithThree();
    expect(describeChanges(board.config, structuredClone(board.config))).toEqual([]);
  });
});

describe("changesSince", () => {
  it("lists the edits after a version that the chat did not make, oldest first, a drag by the summary it was saved with", async () => {
    const { store, board } = await boardWithThree();
    const since = board.version;
    await store.replaceConfig({ id: "x", config: { ...board.config, layout: board.config.layout.map((l) => (l.i === "c" ? { ...l, y: 0 } : { ...l, y: l.y + 4 })) }, summary: "moved “Gamma”" });
    const removed = await store.patch({ id: "x", catalogue, ops: [{ op: "remove_widget", id: "b" }] });
    if (!removed.ok) throw new Error(removed.error);
    await store.revertTo("x", removed.board.version - 1);
    // The chat's own later edit is not the user's.
    await store.patch({ id: "x", catalogue, source: "chat", ops: [{ op: "set_title", title: "Renamed" }] });
    const changes = changesSince(await store.versions("x"), since);
    expect(changes).toEqual([
      { version: since + 1, source: "layout", text: "moved “Gamma”" },
      { version: since + 2, source: "ops", text: "removed “Beta”" },
      { version: since + 3, source: "revert", text: `restored v${since + 1} (added “Beta”)` },
    ]);
    expect(changesSince(await store.versions("x"), since + 4)).toEqual([]);
  });

  it("describes a layout save without a summary from the diff", async () => {
    const { store, board } = await boardWithThree();
    await store.replaceConfig({ id: "x", config: { ...board.config, layout: board.config.layout.map((l) => (l.i === "a" ? { ...l, w: 3 } : l)) } });
    expect(changesSince(await store.versions("x"), board.version).map((c) => c.text)).toEqual(["resized “Alpha”"]);
  });
});

it("lists in words", () => {
  expect(listInWords(["a"])).toBe("a");
  expect(listInWords(["a", "b", "c"])).toBe("a, b and c");
});
