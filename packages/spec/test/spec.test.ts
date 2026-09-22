import { describe, expect, it } from "vitest";

import { catalogueFrom } from "../src/catalogue";
import { PackError, parsePack, parsePackText } from "../src/load";

const minimal = {
  pack: "fixture",
  version: 1,
  entities: {
    items: { source: "items", time: "created_at", joins: [{ to: "owners", on: "items.owner_id = owners.id", type: "many_to_one" }] },
    owners: { source: "owners" },
  },
  dimensions: [
    { key: "region", entity: "items", sql: "region" },
    { key: "attr_colour", entity: "items", json: ["attrs", "colour"] },
    { key: "tier", entity: "owners", sql: "tier" },
  ],
  measures: [
    { key: "count", entity: "items", agg: "count" },
    { key: "amount", entity: "items", agg: "sum", sql: "amount_cents / 100.0", format: "currency" },
    { key: "avg_amount", entity: "items", derived: "amount / count", format: "currency" },
  ],
};

describe("pack parsing", () => {
  it("accepts a minimal pack and derives a catalogue", () => {
    const pack = parsePack(minimal);
    const cat = catalogueFrom(pack);
    expect(cat.dimensions.map((d) => d.key)).toEqual(["region", "attr_colour", "tier"]);
    expect(cat.dimensions[1]?.label).toBe("Attr colour");
    expect(cat.measures.find((m) => m.key === "amount")?.format).toBe("currency");
    expect(cat.entities.find((e) => e.key === "items")?.hasTime).toBe(true);
    expect(cat.entities.find((e) => e.key === "owners")?.hasTime).toBe(false);
    expect(cat.measures.every((m) => m.verified)).toBe(true);
  });

  it("parses YAML", () => {
    const pack = parsePackText(`
pack: yamlpack
version: 2
entities:
  t: { source: public.t }
measures:
  - { key: n, entity: t, agg: count }
`);
    expect(pack.version).toBe(2);
    expect(pack.measures[0]?.key).toBe("n");
  });

  const bad = (mutate: (p: any) => void, expected: string) => {
    const copy = JSON.parse(JSON.stringify(minimal));
    mutate(copy);
    try {
      parsePack(copy);
    } catch (e) {
      expect(e).toBeInstanceOf(PackError);
      expect((e as PackError).message).toContain(expected);
      return;
    }
    throw new Error("expected a PackError");
  };

  it("rejects a dimension on an unknown entity", () => bad((p) => (p.dimensions[0].entity = "ghost"), 'unknown entity "ghost"'));
  it("rejects duplicate keys across dimensions and measures", () => bad((p) => (p.measures[0].key = "region"), "already used"));
  it("rejects a join to an unknown entity", () => bad((p) => (p.entities.items.joins[0].to = "ghost"), 'unknown entity "ghost"'));
  it("rejects a join whose on-clause names other entities", () => bad((p) => (p.entities.items.joins[0].on = "items.owner_id = ghosts.id"), "must reference exactly"));
  it("rejects a dimension with both sql and json", () => bad((p) => (p.dimensions[0].json = ["a"]), "exactly one of sql or json"));
  it("rejects a measure with neither agg nor derived", () => bad((p) => delete p.measures[0].agg, "agg"));
  it("rejects a non-count aggregate without sql", () => bad((p) => delete p.measures[1].sql, "needs sql"));
  it("rejects a derived measure across entities", () => {
    bad((p) => {
      p.measures.push({ key: "owner_n", entity: "owners", agg: "count" });
      p.measures[2].derived = "amount / owner_n";
    }, 'is on "owners"');
  });
  it("rejects a derived measure built on a derived measure", () => {
    bad((p) => p.measures.push({ key: "twice", entity: "items", derived: "avg_amount / count" }), "cannot be an operand");
  });
  it("rejects grains on a non-time dimension", () => bad((p) => (p.dimensions[0].grains = ["day"]), "only apply to a time dimension"));
  it("rejects an uppercase key", () => bad((p) => (p.dimensions[0].key = "Region"), "lowercase"));
});
