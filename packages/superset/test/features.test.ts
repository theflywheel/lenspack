import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkOps, meteredConnector } from "@lenspack/engine";
import { describe, expect, it } from "vitest";

import { supersetConnector } from "../src/connector";
import { FEATURES, features, featuresFromConfig, featuresFromEnv } from "../src/features";
import { EDITS_OFF_MESSAGE, type Identity, canEdit, principalOf } from "../src/identity";
import { type SupersetDataset, packFromDatasets } from "../src/index";
import { settingsStore } from "../src/settings";

const dir = () => join(mkdtempSync(join(tmpdir(), "lp-features-")), "state");

describe("off switches", () => {
  it("are all on by default", () => {
    const f = features({ settings: settingsStore(dir()) });
    expect(Object.values(f.values()).every(Boolean)).toBe(true);
    expect(Object.keys(f.values())).toEqual([...FEATURES]);
  });

  it("read the config strictly: an unknown name or a non-boolean is an error", () => {
    expect(featuresFromConfig({ voice: false, maps: true })).toEqual({ voice: false, maps: true });
    expect(() => featuresFromConfig({ vioce: false })).toThrow(/unknown feature "vioce"/);
    expect(() => featuresFromConfig({ voice: "off" })).toThrow(/true or false/);
    expect(() => featuresFromConfig(["voice"])).toThrow(/map of feature/);
  });

  it("read LENSPACK_FEATURES as name=on|off, +name/-name, or JSON", () => {
    expect(featuresFromEnv("voice=off, heatmap=false,maps=on")).toEqual({ voice: false, heatmap: false, maps: true });
    expect(featuresFromEnv("-reviewer,+newChat,markdown")).toEqual({ reviewer: false, newChat: true, markdown: true });
    expect(featuresFromEnv('{"overlay": false}')).toEqual({ overlay: false });
    expect(featuresFromEnv("")).toEqual({});
    expect(() => featuresFromEnv("voice=maybe")).toThrow(/on or off/);
    expect(() => featuresFromEnv("speech=off")).toThrow(/can't read/);
    expect(() => featuresFromEnv("-voice=on")).toThrow(/both a sign and a value/);
  });

  it("take the config, then the environment, then the admin's choice", () => {
    const settings = settingsStore(dir());
    const f = features({ config: { voice: false, heatmap: false, maps: false }, env: "heatmap=on,reviewer=off", settings });
    expect(f.values()).toMatchObject({ voice: false, heatmap: true, maps: false, reviewer: false, overlay: true });
    expect(f.view(true).source).toMatchObject({ voice: "config", heatmap: "env", reviewer: "env", overlay: "default" });

    expect(f.update({ voice: true, overlay: false })).toMatchObject({ ok: true });
    expect(f.values()).toMatchObject({ voice: true, overlay: false });
    const v = f.view(true);
    expect(v.source).toMatchObject({ voice: "settings", overlay: "settings" });
    // defaults: what the deployment says without the admin, for a "reset" button.
    expect(v.defaults).toMatchObject({ voice: false, overlay: true });
    expect(v.options.find((o) => o.key === "boardEdits")?.label).toBe("Dashboard edits");

    // null drops the admin's value; the deployment's applies again.
    expect(f.update({ voice: null })).toMatchObject({ ok: true });
    expect(f.on("voice")).toBe(false);
    expect(settings.get("features")).toEqual({ overlay: false });
  });

  it("survive a restart, and refuse a bad update whole", () => {
    const d = dir();
    const a = features({ settings: settingsStore(d) });
    a.update({ markdown: false });
    expect(a.update({ newChat: false, nope: true })).toEqual({ ok: false, error: expect.stringMatching(/unknown feature "nope"/) });
    expect(a.update({ newChat: "no" })).toEqual({ ok: false, error: expect.stringMatching(/true, false or null/) });
    const b = features({ settings: settingsStore(d) });
    expect(b.values()).toMatchObject({ markdown: false, newChat: true });
  });
});

describe("what the server refuses when a switch is off", () => {
  const as = (over: Partial<Identity>): Identity => ({ u: "someone", a: false, d: 7, e: false, v: true, t: Math.floor(Date.now() / 1000), ...over });

  it("boardEdits off: nobody edits, not even an admin, and the chat is told why", () => {
    const admin = as({ u: "admin", a: true, e: true });
    expect(canEdit(admin, "superset")).toBe(true);
    expect(canEdit(admin, "signed-in", false)).toBe(false);
    expect(principalOf(admin, "signed-in", false)).toEqual({ user: "admin", edit: false, maintain: false, readOnly: EDITS_OFF_MESSAGE });
  });

  const DATASETS: SupersetDataset[] = [
    {
      id: 9,
      table_name: "sites",
      columns: [
        { column_name: "latitude", groupby: false, filterable: false, type: "Float64" },
        { column_name: "longitude", groupby: false, filterable: false, type: "Float64" },
        { column_name: "kind", groupby: true, type: "String" },
        { column_name: "area", groupby: true, type: "String" },
      ],
      metrics: [{ metric_name: "sites", expression: "count()" }],
    },
  ];
  const { pack, binding } = packFromDatasets(DATASETS, { pack: "t", entities: { "9": "site" } });
  const heat = { op: "add_widget", id: "h", widget: { title: "Sites", kind: "chart", chart: "heatmap", options: { legend: true, colorScheme: "sequential" }, query: { kind: "breakdown", dimension: "kind", by: "area", measure: "sites" } } } as never;
  const map = { op: "add_widget", id: "m", widget: { title: "Sites", kind: "chart", chart: "map", options: { legend: true, colorScheme: "default" }, query: { kind: "points", entity: "site", color: "kind", limit: 100 } } } as never;

  it("heatmap and maps off: the connector's capabilities change at once, and new ones are refused", () => {
    const on = { heatmap: true, maps: true };
    const connector = supersetConnector({} as never, binding, { capabilities: () => ({ ...(on.heatmap ? {} : { heatmap: false }), ...(on.maps ? {} : { points: false }) }) });
    expect(checkOps([heat, map], pack, { capabilities: connector.capabilities })).toEqual({ ok: true });
    on.heatmap = false;
    on.maps = false;
    expect(checkOps([heat], pack, { capabilities: connector.capabilities })).toMatchObject({ ok: false, error: expect.stringMatching(/Heatmaps are turned off/) });
    expect(checkOps([map], pack, { capabilities: connector.capabilities })).toMatchObject({ ok: false, error: expect.stringMatching(/Maps are not available/) });
    // The app wraps the connector to count its queries; the wrapper still reads the switches live.
    const metered = meteredConnector(connector);
    on.heatmap = true;
    expect(metered.capabilities.heatmap).toBeUndefined();
    on.heatmap = false;
    expect(metered.capabilities.heatmap).toBe(false);
    // Without the option, the connector offers what Superset can do.
    expect(supersetConnector({} as never, binding).capabilities).toMatchObject({ points: true, timeHeatmap: false });
  });
});
