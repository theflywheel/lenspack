// The pack's runtime layer as policy alone: who may change the pack, which parts a change at runtime may touch, how the
// layer is laid over the deploy config's overlay, and that exclusions only ever grow.
import { describe, expect, it } from "vitest";

import { ADMIN_ROLE, PACK_CONFIG_FIELDS, PACK_DATA_BOUNDARY, PACK_RUNTIME_FIELDS, apiKeyAdmin, applyPackLayer, packChangeRefusals, packEditRights, packFieldsChanged, packLayerFrom, packLayerWith, packRuntimeView, principalOf, sameValue } from "../src";

const base = {
  pack: "shop",
  timeZone: "Europe/Lisbon",
  description: "Orders and returns.",
  labels: { region: "Region" },
  exclude: { columns: ["customer_name", "Latitude"], datasets: ["staff_shifts"] },
  examples: [{ question: "Orders by region", query: { kind: "breakdown", dimension: "region", measure: "orders" } }],
};

describe("who may change the pack", () => {
  it("is an admin, as for every other setting", () => {
    expect(packEditRights(principalOf({ user: "ana", roles: [ADMIN_ROLE] }))).toEqual({ read: true, edit: true });
    expect(packEditRights(principalOf({ user: "bo", roles: ["viewer"] }))).toEqual({ read: false, edit: false, why: "only admins can read or change the pack" });
  });

  it("is an admin API key while its name is set, in any access mode", () => {
    const access = { modes: ["superset-users"] as const, owners: ["olga"], granted: [], passwords: [], apiKeys: ["ci"] };
    expect(packEditRights(apiKeyAdmin("ci"), access).edit).toBe(true);
    expect(packEditRights(apiKeyAdmin("ci"), { ...access, apiKeys: [] }).edit).toBe(false);
  });
});

describe("what a change at runtime may touch", () => {
  it("names the runtime parts, the config-only parts and the data boundary apart", () => {
    expect(PACK_RUNTIME_FIELDS).toEqual(["description", "instructions", "labels", "hints", "measures", "examples", "notDimensions", "hierarchies", "exclude"]);
    for (const f of ["pack", "entities", "timeZone", "geo", "mapStyle", "panel"]) expect(PACK_CONFIG_FIELDS[f]).toBeTruthy();
    expect(PACK_DATA_BOUNDARY).toEqual(["datasets", "scope", "dashboards", "dashboardScope", "auth"]);
    for (const f of PACK_RUNTIME_FIELDS) expect(PACK_CONFIG_FIELDS[f]).toBeUndefined();
  });

  it("refuses config-only parts, the data boundary and anything unknown, saying why", () => {
    const r = packChangeRefusals({ labels: {}, entities: { 11: "sales" }, timeZone: "UTC", datasets: [1, 2], scope: [], colour: "red" }, base);
    expect(r).toEqual([
      expect.stringMatching(/^entities is set in the deploy config only \(each dataset's key/),
      expect.stringMatching(/^timeZone is set in the deploy config only/),
      "datasets is part of the deployment's data boundary, never part of the pack: the deploy config sets it, and an admin may only narrow it (settings/boundary)",
      "scope is part of the deployment's data boundary, never part of the pack: the deploy config sets it, and an admin may only narrow it (settings/boundary)",
      expect.stringMatching(/^colour is not a part of the pack that can be changed here/),
    ]);
  });

  it("lets a change add exclusions, never remove one the deploy config makes (any case)", () => {
    expect(packChangeRefusals({ exclude: { columns: ["CUSTOMER_NAME", "latitude", "phone"], datasets: ["staff_shifts", 12] } }, base)).toEqual([]);
    expect(packChangeRefusals({ exclude: { columns: ["phone"], datasets: ["staff_shifts"] } }, base)).toEqual([
      'exclude.columns: "customer_name" is excluded by the deploy config, and a change here can only add exclusions, never remove one',
      'exclude.columns: "Latitude" is excluded by the deploy config, and a change here can only add exclusions, never remove one',
    ]);
    expect(packChangeRefusals({ exclude: { columns: ["customer_name", "latitude"] } }, base)).toEqual([expect.stringMatching(/^exclude.datasets: "staff_shifts" is excluded by the deploy config/)]);
    // null hands exclusions back to the deploy config's alone: nothing is removed.
    expect(packChangeRefusals({ exclude: null }, base)).toEqual([]);
    expect(packChangeRefusals({ exclude: ["phone"] }, base)[0]).toBe("exclude is { columns: [...], datasets: [...] }");
    expect(packChangeRefusals({ exclude: { columns: [""], rows: 1 } }, base)[0]).toBe("exclude is { columns: [...], datasets: [...] }");
  });
});

describe("the layer over the deploy config's overlay", () => {
  it("holds only what differs, and exclusions beyond the config's", () => {
    const given = { description: "Orders and returns.", labels: { region: "Area" }, exclude: { columns: ["customer_name", "latitude", "phone"], datasets: ["staff_shifts"] }, examples: base.examples };
    expect(packLayerFrom(base, given)).toEqual({ labels: { region: "Area" }, exclude: { columns: ["phone"] } });
    // A field left out, or null, follows the config.
    expect(packLayerFrom(base, { description: null })).toEqual({});
  });

  it("lays the layer over the base, each field whole, exclusions joined, config-only parts untouched", () => {
    const out = applyPackLayer(base, { labels: { region: "Area" }, examples: [], exclude: { columns: ["phone", "CUSTOMER_NAME"], datasets: [12] } });
    expect(out).toEqual({ ...base, labels: { region: "Area" }, examples: [], exclude: { columns: ["customer_name", "Latitude", "phone"], datasets: ["staff_shifts", 12] } });
    // Whatever the layer says, the config's exclusions stay: the layer can't hold a removal.
    expect(applyPackLayer(base, { exclude: {} }).exclude).toEqual(base.exclude);
    // A field outside the runtime part in a layer (a file edited by hand) is not laid over.
    expect(applyPackLayer(base, { timeZone: "UTC" } as never).timeZone).toBe("Europe/Lisbon");
  });

  it("changes some fields of a layer, null handing one back to the config", () => {
    const layer = { labels: { region: "Area" }, hints: { region: "Sales region" } };
    expect(packLayerWith(base, layer, { labels: null, instructions: "Weeks start on Monday." })).toEqual({ hints: { region: "Sales region" }, instructions: "Weeks start on Monday." });
    // Setting a field back to the config's own value drops it from the layer.
    expect(packLayerWith(base, layer, { labels: { region: "Region" } })).toEqual({ hints: { region: "Sales region" } });
    expect(packLayerWith(base, { exclude: { columns: ["phone"] } }, { exclude: null })).toEqual({});
  });

  it("shows the runtime parts as the pack uses them, and which changed between two layers", () => {
    expect(packRuntimeView(base, { hints: { region: "Sales region" } })).toEqual({ description: base.description, labels: base.labels, hints: { region: "Sales region" }, examples: base.examples, exclude: base.exclude });
    expect(packFieldsChanged(base, {}, { labels: { region: "Area" }, exclude: { columns: ["phone"] } })).toEqual(["labels", "exclude"]);
    expect(packFieldsChanged(base, { labels: { region: "Area" } }, { labels: { region: "Area" } })).toEqual([]);
  });

  it("compares values whatever the order of their keys", () => {
    expect(sameValue({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toBe(true);
    expect(sameValue([1, 2], [2, 1])).toBe(false);
    expect(sameValue(undefined, null)).toBe(true);
  });
});
