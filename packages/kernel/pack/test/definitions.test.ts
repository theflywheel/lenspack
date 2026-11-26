import { describe, expect, it } from "vitest";

import { OverlayError, definitionsDocKey, editDefinitions, emptyDefinitions, parseDefinitions } from "../src";

const keys = new Set(["sales", "region"]);

describe("the definitions document", () => {
  it("is changed by pure steps: each one a new version, the input untouched", () => {
    const start = emptyDefinitions("shop");
    const e = editDefinitions(start, { keys, now: () => new Date("2026-11-01T10:00:00Z") });
    const { entry } = e.add({ kind: "hint", key: "sales", text: "Paid sales only." }, "ana", "asked twice");
    e.add({ kind: "instruction", text: "Weeks start on Monday." }, "ben", "");
    e.remove(entry.id, "ana", "");
    e.undo("ana");
    const doc = e.doc();
    expect(start).toEqual(emptyDefinitions("shop"));
    expect(doc).toMatchObject({ kind: "lenspack/definitions", pack: "shop", version: 4 });
    expect(doc.entries.map((x) => x.kind)).toEqual(["hint", "instruction"]);
    expect(doc.history.map((c) => c.action)).toEqual(["add", "add", "remove", "undo"]);
    expect(doc.history[2]!.undone).toBe(true);
    expect(() => e.add({ kind: "hint", key: "nope", text: "x" }, "ana", "")).toThrow(OverlayError);
  });

  it("reads back what it wrote, and an older file with no kind or pack", () => {
    const e = editDefinitions(emptyDefinitions("shop"), { keys });
    e.add({ kind: "synonym", key: "region", words: ["area"], text: "" }, "ana", "");
    const doc = e.doc();
    expect(parseDefinitions(JSON.parse(JSON.stringify(doc)), "shop")).toEqual(doc);
    const old = parseDefinitions({ version: doc.version, entries: doc.entries, history: doc.history }, "shop");
    expect(old.kind).toBe("lenspack/definitions");
    expect(old.pack).toBe("shop");
    expect(() => parseDefinitions({ entries: "nope" }, "shop")).toThrow(OverlayError);
  });

  it("keys on the entries, not just the counter", () => {
    const a = editDefinitions(emptyDefinitions("shop"), { keys });
    a.add({ kind: "instruction", text: "One." }, "ana", "");
    const b = editDefinitions(emptyDefinitions("shop"), { keys });
    b.add({ kind: "instruction", text: "Another." }, "ana", "");
    expect(a.doc().version).toBe(b.doc().version);
    expect(definitionsDocKey(a.doc())).not.toBe(definitionsDocKey(b.doc()));
    expect(definitionsDocKey(a.doc())).toMatch(/^d1-[0-9a-f]{8}$/);
  });
});
