import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { catalogueFrom, parsePackText } from "@lenspack/pack";

import { OverlayError, QuestionError, StaleWrite, applyOverlay, fileDocs, memoryDocs, overlayStore, questionLog, updateDoc } from "../src";

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
const files = () => fileDocs(tmp());

describe("the definitions overlay", () => {
  it("merges instructions, hints and synonyms into the pack and catalogue without changing either", async () => {
    const ov = overlayStore(files(), "shop", { keys });
    await ov.add({ kind: "instruction", text: "Weeks start on Monday." }, "ana", "asked twice");
    await ov.add({ kind: "hint", key: "amount", text: "Before refunds." }, "ana", "");
    await ov.add({ kind: "synonym", key: "region", words: ["area", "zone"], text: "" }, "ana", "");
    await ov.add({ kind: "definition", when: "sales this month", text: "calendar month to date" }, "ana", "");
    const catalogue = catalogueFrom(PACK);
    const merged = applyOverlay(await ov.entries(), PACK, catalogue);
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

  it("versions every change with who, when and why, undoes and restores, and survives a reload", async () => {
    const dir = tmp();
    let clock = Date.parse("2026-11-01T10:00:00Z");
    const ov = overlayStore(fileDocs(dir), "shop", { keys, now: () => new Date((clock += 1000)) });
    const k0 = await ov.key();
    const a = await ov.add({ kind: "instruction", text: "One." }, "ana", "first");
    await ov.add({ kind: "instruction", text: "Two." }, "ben", "second");
    expect(await ov.version()).toBe(2);
    expect(await ov.key()).not.toBe(k0);
    await ov.edit(a.entry.id, { text: "One, edited." }, "ana", "typo");
    await ov.remove(a.entry.id, "ben", "not needed");
    expect((await ov.entries()).map((e) => e.text)).toEqual(["Two."]);
    const undo = await ov.undo("ana", "");
    expect(undo.action).toBe("undo");
    expect((await ov.entries()).map((e) => e.text)).toEqual(["One, edited.", "Two."]);
    await ov.restore(1, "ana", "back to the start");
    expect((await ov.entries()).map((e) => e.text)).toEqual(["One."]);
    // Newest first.
    const h = (await ov.history()).slice().reverse();
    expect(h.map((c) => c.action)).toEqual(["add", "add", "edit", "remove", "undo", "restore"]);
    expect(h[3]).toMatchObject({ by: "ben", why: "not needed", undone: true });
    expect(h[0]!.at).toBe("2026-11-01T10:00:02.000Z");
    // Written to the state directory as a typed document, read back by a new store.
    const again = overlayStore(fileDocs(dir), "shop", { keys });
    expect(await again.version()).toBe(await ov.version());
    expect(await again.entries()).toEqual(await ov.entries());
    const doc = JSON.parse(readFileSync(join(dir, "definitions-shop.json"), "utf8"));
    expect(doc).toMatchObject({ kind: "lenspack/definitions", pack: "shop", version: 6 });
    expect(doc.history).toHaveLength(6);
  });

  it("refuses unknown keys and a change past the budget, but allows one that shrinks it", async () => {
    const ov = overlayStore(files(), "shop", { keys, budget: 120 });
    await expect(ov.add({ kind: "hint", key: "nope", text: "x" }, "ana", "")).rejects.toThrow(OverlayError);
    const big = await ov.add({ kind: "instruction", text: "x".repeat(90) }, "ana", "");
    await expect(ov.add({ kind: "instruction", text: "y".repeat(60) }, "ana", "")).rejects.toThrow(/budget|characters/);
    expect(await ov.size()).toBeLessThanOrEqual(120);
    await ov.edit(big.entry.id, { text: "short" }, "ana", "");
    expect(await ov.size()).toBeLessThan(40);
  });

  it("keeps no copy in the process: two stores on one document see each other's changes", async () => {
    const docs = memoryDocs();
    const one = overlayStore(docs, "shop", { keys });
    const two = overlayStore(docs, "shop", { keys });
    await one.add({ kind: "instruction", text: "From the first server." }, "ana", "");
    await two.add({ kind: "instruction", text: "From the second." }, "ben", "");
    expect((await one.entries()).map((e) => e.text)).toEqual(["From the first server.", "From the second."]);
    expect(await one.version()).toBe(2);
  });
});

describe("the document store", () => {
  it("refuses a write based on a copy that has changed, and updateDoc retries on the newer one", async () => {
    for (const docs of [memoryDocs(), files()]) {
      const r1 = await docs.put("a.json", "1", null);
      await expect(docs.put("a.json", "2", null)).rejects.toThrow(StaleWrite);
      await docs.put("a.json", "2", r1);
      await expect(docs.put("a.json", "3", r1)).rejects.toThrow(StaleWrite);
      let calls = 0;
      const n = await updateDoc<number, number>(docs, "n.json", () => 0, (v) => {
        calls += 1;
        // Another writer gets in between the first read and write.
        if (calls === 1) void docs.put("n.json", "10");
        return { next: v + 1, result: v + 1 };
      });
      expect(n).toBe(11);
      expect(calls).toBe(2);
      await docs.put("runs/x.json", "{}");
      expect(await docs.list("runs/")).toEqual(["runs/x.json"]);
      await docs.remove("runs/x.json");
      expect(await docs.list("runs/")).toEqual([]);
    }
  });
});

describe("the open-questions log", () => {
  const readings = [
    { label: "Calendar month", explanation: "From the 1st to today", query: { kind: "value", measure: "sales", time: "this month" } },
    { label: "Last 30 days", explanation: "A rolling window", query: { kind: "value", measure: "sales", time: "30d" } },
  ];
  it("logs a question, counts repeats against it, and needs two readings unless an admin adds it", async () => {
    const log = questionLog(files(), "shop");
    const q = await log.note({ pattern: "sales this month", readings, example: "How many sales this month?", source: "turn" });
    expect(q).toMatchObject({ status: "open", count: 1, sources: ["turn"] });
    const again = await log.note({ pattern: "Sales this month", readings, example: "sales so far this month", source: "review" });
    expect(again.id).toBe(q.id);
    expect(again).toMatchObject({ count: 2, sources: ["turn", "review"] });
    expect(again.examples).toHaveLength(2);
    await expect(log.note({ pattern: "something", readings: readings.slice(0, 1), source: "turn" })).rejects.toThrow(QuestionError);
    expect((await log.note({ pattern: "something", readings: readings.slice(0, 1), source: "admin" })).status).toBe("open");
    await log.choose(q.id, "Calendar month");
    await log.choose(q.id, "Calendar month");
    expect((await log.get(q.id)).choices).toEqual({ "Calendar month": 2 });
  });

  it("answers, dismisses and reopens", async () => {
    const log = questionLog(files(), "shop");
    const q = await log.note({ pattern: "sales this month", readings, source: "turn" });
    const r1 = (await log.get(q.id)).readings[0]!.id;
    expect(await log.answer(q.id, r1, "ana", "the finance team counts this way", "def1")).toMatchObject({ status: "answered", chosen: r1, answeredBy: "ana", definition: "def1" });
    await expect(log.answer(q.id, "r9", "ana", "", "x")).rejects.toThrow(QuestionError);
    expect(await log.list("open")).toHaveLength(0);
    expect(await log.reopen(q.id)).toMatchObject({ status: "open" });
    expect((await log.get(q.id)).chosen).toBeUndefined();
    expect((await log.dismiss(q.id, "ben", "not a real question")).status).toBe("dismissed");
    expect(await log.list("dismissed")).toHaveLength(1);
  });
});
