import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { catalogueFrom, parsePackText } from "@lenspack/pack";

import { OverlayError, QuestionError, applyOverlay, overlayStore, questionLog } from "../src";

const PACK = parsePackText(`pack: shop
version: 1
instructions: Count only paid orders.
entities:
  sales: { source: sales, grain: one row per sale, time: sold_at }
dimensions:
  - { key: region, entity: sales, sql: region, label: Region }
measures:
  - { key: sales, entity: sales, agg: count, label: Sales }
  - { key: amount, entity: sales, agg: sum, sql: amount, label: Amount, hint: In euros. }
`);
const keys = () => new Set(["region", "sales", "amount"]);
const tmp = () => mkdtempSync(join(tmpdir(), "lp-overlay-"));

describe("the definitions overlay", () => {
  it("merges instructions, hints and synonyms into the pack and catalogue without changing either", () => {
    const ov = overlayStore(tmp(), "shop", { keys });
    ov.add({ kind: "instruction", text: "Weeks start on Monday." }, "ana", "asked twice");
    ov.add({ kind: "hint", key: "amount", text: "Before refunds." }, "ana", "");
    ov.add({ kind: "synonym", key: "region", words: ["area", "zone"], text: "" }, "ana", "");
    ov.add({ kind: "definition", when: "sales this month", text: "calendar month to date" }, "ana", "");
    const catalogue = catalogueFrom(PACK);
    const merged = applyOverlay(ov.entries(), PACK, catalogue);
    expect(merged.pack.instructions).toContain("Count only paid orders.");
    expect(merged.pack.instructions).toContain("DEFINITIONS SET BY AN ADMIN");
    expect(merged.pack.instructions).toContain("Weeks start on Monday.");
    expect(merged.pack.instructions).toContain("sales this month");
    expect(merged.pack.measures.find((m) => m.key === "amount")?.hint).toBe("In euros. Before refunds.");
    expect(merged.catalogue.dimensions.find((d) => d.key === "region")?.synonyms).toEqual(expect.arrayContaining(["area", "zone"]));
    // The inputs are as they were.
    expect(PACK.instructions).toBe("Count only paid orders.");
    expect(PACK.measures.find((m) => m.key === "amount")?.hint).toBe("In euros.");
    // An empty overlay hands back the very same objects.
    const same = applyOverlay([], PACK, catalogue);
    expect(same.pack).toBe(PACK);
  });

  it("versions every change with who, when and why, undoes and restores, and survives a reload", () => {
    const dir = tmp();
    let clock = Date.parse("2026-11-01T10:00:00Z");
    const ov = overlayStore(dir, "shop", { keys, now: () => new Date((clock += 1000)) });
    const k0 = ov.key();
    const a = ov.add({ kind: "instruction", text: "One." }, "ana", "first");
    ov.add({ kind: "instruction", text: "Two." }, "ben", "second");
    expect(ov.version()).toBe(2);
    expect(ov.key()).not.toBe(k0);
    ov.edit(a.entry.id, { text: "One, edited." }, "ana", "typo");
    ov.remove(a.entry.id, "ben", "not needed");
    expect(ov.entries().map((e) => e.text)).toEqual(["Two."]);
    const undo = ov.undo("ana", "");
    expect(undo.action).toBe("undo");
    expect(ov.entries().map((e) => e.text)).toEqual(["One, edited.", "Two."]);
    ov.restore(1, "ana", "back to the start");
    expect(ov.entries().map((e) => e.text)).toEqual(["One."]);
    // Newest first.
    const h = ov.history().slice().reverse();
    expect(h.map((c) => c.action)).toEqual(["add", "add", "edit", "remove", "undo", "restore"]);
    expect(h[3]).toMatchObject({ by: "ben", why: "not needed", undone: true });
    expect(h[0]!.at).toBe("2026-11-01T10:00:02.000Z");
    // Written to the state directory, read back by a new store.
    const again = overlayStore(dir, "shop", { keys });
    expect(again.version()).toBe(ov.version());
    expect(again.entries()).toEqual(ov.entries());
    expect(JSON.parse(readFileSync(join(dir, "definitions-shop.json"), "utf8")).history).toHaveLength(6);
  });

  it("refuses unknown keys and a change past the budget, but allows one that shrinks it", () => {
    const ov = overlayStore(tmp(), "shop", { keys, budget: 120 });
    expect(() => ov.add({ kind: "hint", key: "nope", text: "x" }, "ana", "")).toThrow(OverlayError);
    const big = ov.add({ kind: "instruction", text: "x".repeat(90) }, "ana", "");
    expect(() => ov.add({ kind: "instruction", text: "y".repeat(60) }, "ana", "")).toThrow(/budget|characters/);
    expect(ov.size()).toBeLessThanOrEqual(120);
    ov.edit(big.entry.id, { text: "short" }, "ana", "");
    expect(ov.size()).toBeLessThan(40);
  });
});

describe("the open-questions log", () => {
  const readings = [
    { label: "Calendar month", explanation: "From the 1st to today", query: { kind: "value", measure: "sales", time: "this month" } },
    { label: "Last 30 days", explanation: "A rolling window", query: { kind: "value", measure: "sales", time: "30d" } },
  ];
  it("logs a question, counts repeats against it, and needs two readings unless an admin adds it", () => {
    const log = questionLog(tmp(), "shop");
    const q = log.note({ pattern: "sales this month", readings, example: "How many sales this month?", source: "turn" });
    expect(q).toMatchObject({ status: "open", count: 1, sources: ["turn"] });
    const again = log.note({ pattern: "Sales this month", readings, example: "sales so far this month", source: "review" });
    expect(again.id).toBe(q.id);
    expect(again).toMatchObject({ count: 2, sources: ["turn", "review"] });
    expect(again.examples).toHaveLength(2);
    expect(() => log.note({ pattern: "something", readings: readings.slice(0, 1), source: "turn" })).toThrow(QuestionError);
    expect(log.note({ pattern: "something", readings: readings.slice(0, 1), source: "admin" }).status).toBe("open");
    log.choose(q.id, "Calendar month");
    log.choose(q.id, "Calendar month");
    expect(log.get(q.id).choices).toEqual({ "Calendar month": 2 });
  });

  it("answers, dismisses and reopens", () => {
    const log = questionLog(tmp(), "shop");
    const q = log.note({ pattern: "sales this month", readings, source: "turn" });
    const r1 = log.get(q.id).readings[0]!.id;
    expect(log.answer(q.id, r1, "ana", "the finance team counts this way", "def1")).toMatchObject({ status: "answered", chosen: r1, answeredBy: "ana", definition: "def1" });
    expect(() => log.answer(q.id, "r9", "ana", "", "x")).toThrow(QuestionError);
    expect(log.list("open")).toHaveLength(0);
    expect(log.reopen(q.id)).toMatchObject({ status: "open" });
    expect(log.get(q.id).chosen).toBeUndefined();
    expect(log.dismiss(q.id, "ben", "not a real question").status).toBe("dismissed");
    expect(log.list("dismissed")).toHaveLength(1);
  });
});
