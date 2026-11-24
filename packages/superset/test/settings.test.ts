import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { settingsStore } from "../src/settings";

describe("settingsStore", () => {
  it("keeps sections in one file, survives a reload, and removes a section on undefined", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "lp-settings-")), "state");
    const a = settingsStore(dir);
    expect(a.get("speech")).toBeUndefined();
    a.set("speech", { model: "mistralai/voxtral-mini-transcribe-3-0" });
    a.set("language", { default: "fr" });
    const b = settingsStore(dir);
    expect(b.get("speech")).toEqual({ model: "mistralai/voxtral-mini-transcribe-3-0" });
    expect(b.get("language")).toEqual({ default: "fr" });
    b.set("speech", undefined);
    expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))).toEqual({ language: { default: "fr" } });
    // Written by rename: no temporary file is left behind.
    expect(readdirSync(dir)).toEqual(["settings.json"]);
    expect(existsSync(b.path)).toBe(true);
  });
});

