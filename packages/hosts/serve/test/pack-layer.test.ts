// The pack's runtime layer as a store: versions kept whole in pack-layer.json, owner-only, written whole or not at all,
// read back after a restart; a full disk changes nothing; a file that can't be read is set aside, never a failed start.
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PACK_VERSIONS_KEPT, SettingsSaveError, packLayerStore } from "../src";

const dir = () => join(mkdtempSync(join(tmpdir(), "lp-pack-layer-")), "state");

describe("packLayerStore", () => {
  it("starts with the deploy config alone (version 0)", () => {
    const s = packLayerStore(dir());
    expect(s.current()).toEqual({ version: 0, layer: {} });
    expect(s.versions()).toEqual([]);
    expect(s.get(0)).toMatchObject({ version: 0, layer: {}, summary: "the deploy config alone" });
    expect(s.get(1)).toBeUndefined();
    expect(existsSync(s.path)).toBe(false);
  });

  it("keeps each change as a version with who, when, why and what, and reads them back after a restart", () => {
    const d = dir();
    let t = 0;
    const s = packLayerStore(d, { now: () => new Date(Date.UTC(2026, 10, 27, 9, 0, t++)) });
    const v1 = s.append({ by: "api:ci", action: "edit", summary: "labels", changed: ["labels"], layer: { labels: { region: "Area" } }, why: "clearer word" });
    const v2 = s.append({ by: "ana", action: "edit", summary: "labels, examples", changed: ["labels", "examples"], layer: { labels: { region: "Zone" }, examples: [] } });
    const v3 = s.append({ by: "ana", action: "revert", summary: "back to version 1", changed: ["labels", "examples"], reverts: 1, layer: v1.layer });
    expect([v1.version, v2.version, v3.version]).toEqual([1, 2, 3]);
    expect(v1).toMatchObject({ at: "2026-11-27T09:00:00.000Z", by: "api:ci", why: "clearer word" });
    const again = packLayerStore(d);
    expect(again.current()).toEqual({ version: 3, layer: { labels: { region: "Area" } } });
    expect(again.versions().map((v) => [v.version, v.action, v.by])).toEqual([[1, "edit", "api:ci"], [2, "edit", "ana"], [3, "revert", "ana"]]);
    expect(again.get(2)?.layer).toEqual({ labels: { region: "Zone" }, examples: [] });
    expect(again.get(3)?.reverts).toBe(1);
  });

  it("writes the file whole, for its owner only, leaving no temporary file", () => {
    const d = dir();
    const s = packLayerStore(d);
    s.append({ by: "ana", action: "edit", summary: "hints", changed: ["hints"], layer: { hints: { region: "Sales region" } } });
    expect(statSync(s.path).mode & 0o777).toBe(0o600);
    expect(readdirSync(d)).toEqual(["pack-layer.json"]);
    expect(JSON.parse(readFileSync(s.path, "utf8")).versions).toHaveLength(1);
  });

  it("changes nothing when the disk refuses the write", () => {
    if (process.getuid?.() === 0) return; // root writes anywhere
    const d = dir();
    const s = packLayerStore(d);
    s.append({ by: "ana", action: "edit", summary: "hints", changed: ["hints"], layer: { hints: { a: "b" } } });
    chmodSync(d, 0o500);
    try {
      expect(() => s.append({ by: "ana", action: "edit", summary: "labels", changed: ["labels"], layer: { labels: { a: "b" } } })).toThrow(SettingsSaveError);
    } finally {
      chmodSync(d, 0o700);
    }
    expect(s.current()).toEqual({ version: 1, layer: { hints: { a: "b" } } });
    expect(packLayerStore(d).current().version).toBe(1);
  });

  it("keeps the newest versions only, numbering on", () => {
    const s = packLayerStore(dir());
    for (let i = 0; i < PACK_VERSIONS_KEPT + 5; i++) s.append({ by: "ana", action: "edit", summary: "x", changed: ["description"], layer: { description: `v${i}` } });
    expect(s.versions()).toHaveLength(PACK_VERSIONS_KEPT);
    expect(s.versions()[0]!.version).toBe(6);
    expect(s.current().version).toBe(PACK_VERSIONS_KEPT + 5);
    expect(s.get(1)).toBeUndefined();
  });

  it("sets aside a file it can't read and starts on the deploy config alone", () => {
    const d = dir();
    packLayerStore(d);
    writeFileSync(join(d, "pack-layer.json"), "{ not json");
    const lines: string[] = [];
    const s = packLayerStore(d, { log: (l) => lines.push(l) });
    expect(s.current()).toEqual({ version: 0, layer: {} });
    expect(s.setAside).toMatch(/pack-layer\.json\.unreadable-/);
    expect(readdirSync(d).some((f) => f.startsWith("pack-layer.json.unreadable-"))).toBe(true);
    expect(lines[0]).toMatch(/^warning: the pack's runtime changes .* could not be read .*starting with the deploy config's pack alone$/);
    // A file whose versions aren't versions is set aside too.
    writeFileSync(join(d, "pack-layer.json"), JSON.stringify({ versions: [{ version: "one" }] }));
    expect(packLayerStore(d, { log: () => {} }).current().version).toBe(0);
  });
});
