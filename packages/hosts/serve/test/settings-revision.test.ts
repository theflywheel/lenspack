// The settings store's revision and its conflict rule (settings.ts): every write of a setting is one more revision,
// kept in the file with who made each section's last change; a writer that read revision N may not write a section
// changed after N, and nothing is written when it tries; one that names no revision writes as before. The pack's
// runtime layer follows the same rule with its versions (pack-layer.ts).
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SettingsConflictError, ifMatchRevision, packLayerStore, revisionTag, settingsStore } from "../src";

const dir = () => mkdtempSync(join(tmpdir(), "lenspack-settings-rev-"));

describe("the settings store's revision", () => {
  it("counts every write of a setting, says who made each section's last change, and keeps both after a reload", () => {
    const d = dir();
    const s = settingsStore(d);
    expect([s.revision(), s.lastChange()]).toEqual([0, null]);
    s.as({ by: "ana" }, () => s.set("language", { default: "fr" }));
    s.as({ by: "api:ci" }, () => s.set("queue", { maxWaiting: 3 }));
    s.set("speech", { holdMs: 900 });
    expect(s.revision()).toBe(3);
    expect(s.lastChange()).toMatchObject({ section: "speech", revision: 3 });
    expect(s.lastChange()!.by).toBeUndefined();
    const again = settingsStore(d);
    expect(again.revision()).toBe(3);
    expect(again.get("_revisions")).toBeUndefined();
    s.as({ by: "ben" }, () => s.set("language", undefined));
    expect(settingsStore(d).lastChange()).toMatchObject({ section: "language", revision: 4, by: "ben" });
  });

  it("refuses a write made on an older revision of that section, and writes nothing", () => {
    const d = dir();
    const s = settingsStore(d);
    s.as({ by: "ana" }, () => s.set("language", { default: "fr" }));
    const read = s.revision();
    s.as({ by: "ben" }, () => s.set("language", { default: "en" }));
    const before = readFileSync(join(d, "settings.json"), "utf8");
    let err: unknown;
    try {
      s.as({ by: "ana", ifRevision: read }, () => s.set("language", { default: "pt" }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SettingsConflictError);
    expect((err as SettingsConflictError).change).toMatchObject({ section: "language", by: "ben", revision: 2 });
    expect(readFileSync(join(d, "settings.json"), "utf8")).toBe(before);
    expect([s.get("language"), s.revision()]).toEqual([{ default: "en" }, 2]);
    // Another section on the same old copy: nobody changed it since, so it goes through.
    s.as({ by: "ana", ifRevision: read }, () => s.set("queue", { maxWaiting: 3 }));
    // The revision read now, or none at all: through.
    s.as({ by: "ana", ifRevision: s.revision() }, () => s.set("language", { default: "pt" }));
    s.as({ by: "ana" }, () => s.set("language", { default: "hi" }));
    expect(s.get("language")).toEqual({ default: "hi" });
  });

  it("carries the writer through awaits, and keeps records (the admins roster) outside the revision", async () => {
    const s = settingsStore(dir());
    s.set("language", { default: "fr" });
    await s.as({ by: "ana", ifRevision: 0 }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      s.set("adminRoster", [{ user: "ana" }], { record: true });
      expect(() => s.set("language", { default: "en" })).toThrow(SettingsConflictError);
    });
    expect([s.revision(), s.get("adminRoster")]).toEqual([1, [{ user: "ana" }]]);
  });

  it("reads If-Match: the store's own tags, * or nothing for no check, anything else refused", () => {
    expect(revisionTag(12)).toBe('"settings-12"');
    expect(ifMatchRevision('"settings-12"')).toBe(12);
    expect(ifMatchRevision('W/"settings-3"')).toBe(3);
    expect(ifMatchRevision('"pack-4"', "pack")).toBe(4);
    expect(ifMatchRevision(undefined)).toBeNull();
    expect(ifMatchRevision("*")).toBeNull();
    for (const bad of ['"pack-4"', "12", '"settings-"']) expect(ifMatchRevision(bad)).toBeInstanceOf(Error);
  });
});

describe("the pack layer's versions under the same rule", () => {
  it("saves only while the version the writer read is in force", () => {
    const store = packLayerStore(dir());
    const v1 = store.append({ by: "ana", action: "edit", summary: "labels", changed: ["labels"], layer: { labels: { a: "A" } } }, { ifVersion: 0 });
    expect(v1.version).toBe(1);
    expect(store.stale(1)).toBeNull();
    expect(store.stale(null)).toBeNull();
    expect(() => store.append({ by: "ben", action: "edit", summary: "hints", changed: ["hints"], layer: {} }, { ifVersion: 0 })).toThrow(/^the pack changed elsewhere by ana since this copy was read \(now version 1; this change was made on version 0\)/);
    expect(store.current().version).toBe(1);
    expect(store.append({ by: "ben", action: "edit", summary: "hints", changed: ["hints"], layer: {} }).version).toBe(2);
  });
});
