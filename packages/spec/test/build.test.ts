import { describe, expect, it } from "vitest";

import { emitPack, packBuilder, slug, whereSig } from "../src/build";

describe("the shared pack builder", () => {
  it("slugs names the way each pack source always has", () => {
    expect(slug("Open Complaints (%)", { empty: "measure" })).toBe("open_complaints");
    expect(slug("7 day", { empty: "measure" })).toBe("n_7_day");
    expect(slug("!!", { empty: "measure" })).toBe("measure");
    expect(slug("householdVisits_perDay", { camel: true, max: 12, empty: "unnamed" })).toBe("household_vi");
    expect(slug("2024Visits", { camel: true, digit: "k" })).toBe("k2024_visits");
    expect(slug("", { camel: true, digit: "k" })).toBe("k");
  });
  it("matches predicates in any order", () => {
    const a = { field: "a", op: "eq" as const, value: 1 };
    const b = { field: "b", op: "exists" as const };
    expect(whereSig([a, b])).toBe(whereSig([b, a]));
  });
  it("hands out free keys, makes a measure once per signature, and conforms a dimension once per entity", () => {
    const p = packBuilder();
    p.dimensions.set("x", { key: "x", entity: "e", field: "x", type: "string", synonyms: [], verified: true });
    expect(p.key("x")).toBe("x_2");
    expect(p.key("x_n", "x_n", "")).toBe("x_n");
    const make = () => ({ key: p.key("count"), entity: "e", agg: "count" as const, format: "number" as const, synonyms: [], verified: true });
    expect(p.measure("s", make)).toBe("count");
    expect(p.measure("s", make)).toBe("count");
    expect(p.measure("t", make)).toBe("count_2");
    expect(p.conform(p.dimensions.get("x")!, "f", { field: "y" })).toBe(true);
    expect(p.conform(p.dimensions.get("x")!, "f", { field: "z" })).toBe(false);
    expect(p.conform(p.dimensions.get("x")!, "e", { field: "z" })).toBe(false);
    expect(p.dimensions.get("x")!.also).toEqual({ f: { field: "y" } });
  });
  it("emits the parsed pack and its YAML without undefined values", () => {
    const { pack, packYaml } = emitPack({ pack: "t", version: 1, entities: { e: { source: "s", grain: undefined } }, dimensions: [], measures: [{ key: "n", entity: "e", agg: "count", hint: undefined }] });
    expect("hint" in pack.measures[0]!).toBe(false);
    expect(packYaml).not.toContain("grain");
    expect(packYaml).toContain("key: n");
  });
});
