// The answer card alone, with no host: its size bound, the credential mask, a saved answer's call,
// the viewer's selections, and a check attached to the card (as a grounding check will be).
import { parsePackText } from "@lenspack/pack";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ANSWER_LIMITS, type AnswerCall, type DataCall, answerCard, boundCard, maskCredentials, savedCall, selectionsFrom, selectionsOf } from "../src";

const pack = parsePackText(readFileSync(fileURLToPath(new URL("../../../../examples/commerce/pack.yaml", import.meta.url)), "utf8"));
const asked = (filters: { dimension: string; op: "eq"; value: string }[]): DataCall => ({
  tool: "query",
  query: { kind: "value", measure: "orders", filters },
  data: { rows: [{ group: "all", value: 12, count: 12 }], total: 12, format: "number" },
  sources: [{ language: "sql", text: "SELECT count(*) FROM orders WHERE channel = $1", params: ["web"] }],
  now: new Date("2026-09-01T00:00:00Z"),
});
const web = { dimension: "channel", op: "eq" as const, value: "web" };

describe("the answer card's size and safety", () => {
  const call = (i: number, rows = 20, sql = 500): AnswerCall => ({
    tool: "query",
    description: `Call ${i}`,
    statements: [{ language: "sql", text: "x".repeat(sql) }],
    columns: [{ key: "group", label: "Group" }, { key: "value", label: "Value" }],
    rows: Array.from({ length: rows }, (_, r) => [`group ${r} ${"y".repeat(150)}`, r]),
    total: 400,
  });
  const bytes = (x: unknown) => new TextEncoder().encode(JSON.stringify(x)).length;

  it("keeps a small turn whole", () => {
    const x = { calls: [call(1, 5, 100)], sql: true };
    expect(boundCard(x)).toEqual(x);
  });

  it("stays within its bound: fewer rows, shorter statements, then fewer calls, counted", () => {
    const x = boundCard({ calls: Array.from({ length: 14 }, (_, i) => call(i, 20, 5000)), sql: true });
    expect(bytes(x)).toBeLessThanOrEqual(ANSWER_LIMITS.bytes);
    expect(x.calls.length + (x.more ?? 0)).toBe(14);
    expect(x.calls.length).toBeLessThanOrEqual(ANSWER_LIMITS.calls);
    expect(x.calls[0]!.description).toBe("Call 0");
    // Rows are dropped whole, never cut mid-row.
    for (const c of x.calls) for (const r of c.rows) expect(r).toHaveLength(2);
  });

  it("masks anything in a statement that looks like a credential", () => {
    expect(maskCredentials("SELECT * FROM remote('postgres://reader:s3cret@db:5432/x') WHERE password = 'hunter2'")).toBe("SELECT * FROM remote('postgres://***@db:5432/x') WHERE password = ***");
    expect(maskCredentials("SELECT a FROM t WHERE b = $1")).toBe("SELECT a FROM t WHERE b = $1");
  });

  it("a saved answer's call says when its data was read", () => {
    expect(savedCall(call(1, 1), new Date("2026-09-01T06:00:00Z")).saved).toEqual({ asOf: "2026-09-01T06:00:00.000Z" });
  });
});


describe("the viewer's selections on the card", () => {
  it("names each by the pack's label, and is applied only when every data call filtered on it", () => {
    expect(selectionsOf({ channel: "web" }, pack, [asked([web]), asked([web])])).toEqual([{ field: "channel", label: "Sales channel", value: "web", applied: true }]);
    expect(selectionsOf({ channel: "web" }, pack, [asked([web]), asked([])])[0]!.applied).toBe(false);
    expect(selectionsOf({ channel: "web" }, pack, [])[0]!.applied).toBe(false);
  });

  it("keeps only field-to-text pairs from a request", () => {
    expect(selectionsFrom({ channel: "web", n: 3, empty: "", nested: { a: 1 } })).toEqual({ channel: "web" });
    expect(selectionsFrom(["web"])).toBeUndefined();
    expect(selectionsFrom(null)).toBeUndefined();
  });
});

describe("one turn's card", () => {
  it("gathers each call as it runs, shows what the view allows, and takes a check on the reply", () => {
    const card = answerCard({ pack, sql: false, definitions: false, selections: { channel: "web" } });
    expect(card.record()).toBeNull();
    card.onData(asked([web]));
    // A check reads the full results, not the bounded card, then attaches to the same card.
    expect(card.calls()).toHaveLength(1);
    card.check({ kind: "grounding", ok: false, summary: "One number in the reply is in no tool result.", items: ["14"] });
    const x = card.record()!;
    expect(x.sql).toBe(false);
    expect(x.calls[0]!.statements).toBeUndefined();
    expect(x.calls[0]!.description).toMatch(/^Orders \(the pack's approved measure “orders”\), for Sales channel = web/);
    expect(x.selections).toEqual([{ field: "channel", label: "Sales channel", value: "web", applied: true }]);
    expect(x.checks).toEqual([{ kind: "grounding", ok: false, summary: "One number in the reply is in no tool result.", items: ["14"] }]);
  });
});
