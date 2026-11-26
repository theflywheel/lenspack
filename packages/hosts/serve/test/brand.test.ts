// What the assistant is called: the defaults stay Lenspack's, a deployment's name and button label reach every
// language, a language's own words win, the text is checked (no markup, length caps), the environment and the
// settings page override the config, and the prompt introduces the assistant by its name.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { catalogueFrom, loadPack } from "@lenspack/pack";
import { describe, expect, it } from "vitest";

import { BUSY_TEXT, DEFAULT_BRAND, markOf, PROMPT_VERSION, brandFromEnv, brandSettings, busyText, configSchema, parseBrand, promptVersionFor, resolveBrand, settingsStore, systemParts } from "../src";

const tickets = fileURLToPath(new URL("../../../../examples/tickets/pack.yaml", import.meta.url));
const state = () => settingsStore(join(mkdtempSync(join(tmpdir(), "lp-brand-")), "state"));
const PNG = `data:image/png;base64,${Buffer.from("not really a png, but small").toString("base64")}`;

describe("the brand's defaults", () => {
  it("are Lenspack's own, worded as the panel words them today, in all four languages", () => {
    expect(DEFAULT_BRAND).toEqual({
      name: "Lenspack",
      buttonLabel: "Ask Lenspack",
      icon: null,
      poweredBy: false,
      i18n: {
        en: { name: "Lenspack", buttonLabel: "Ask Lenspack", mark: "L" },
        fr: { name: "Lenspack", buttonLabel: "Demander à Lenspack", mark: "L" },
        hi: { name: "Lenspack", buttonLabel: "Lenspack से पूछें", mark: "L" },
        pt: { name: "Lenspack", buttonLabel: "Perguntar ao Lenspack", mark: "L" },
      },
    });
    expect(brandSettings({ env: {}, settings: null }).get()).toEqual(DEFAULT_BRAND);
    expect(BUSY_TEXT).toBe(busyText("Lenspack"));
    expect(BUSY_TEXT).toMatch(/^Lenspack is too busy right now\./);
  });
});

describe("a deployment's name and button label", () => {
  it("a name alone keeps each language's translated label, with the name in it", () => {
    const b = resolveBrand({ name: "Campaign assistant" });
    expect(b).toMatchObject({ name: "Campaign assistant", buttonLabel: "Ask Campaign assistant", poweredBy: true });
    expect(Object.fromEntries(Object.entries(b.i18n).map(([l, w]) => [l, w.buttonLabel]))).toEqual({
      en: "Ask Campaign assistant",
      fr: "Demander à Campaign assistant",
      hi: "Campaign assistant से पूछें",
      pt: "Perguntar ao Campaign assistant",
    });
    expect(b.i18n.fr.poweredBy).toBe("Propulsé par Lenspack");
  });

  it("marks the button and panel with the name's first letter, uppercased, per language", () => {
    const b = resolveBrand({ name: "campaign assistant", i18n: { fr: { name: "Assistant de campagne" }, hi: { name: "डेटा सहायक" } } });
    expect(Object.fromEntries(Object.entries(b.i18n).map(([l, w]) => [l, w.mark]))).toEqual({ en: "C", fr: "A", hi: "ड", pt: "C" });
    expect(markOf("élan")).toBe("É");
    expect(markOf("   ")).toBe("?");
    expect(markOf("")).toBe("?");
  });

  it("a label of the deployment's own is used in every language, {name} filled in", () => {
    const b = resolveBrand({ name: "Campaign assistant", buttonLabel: "Ask the data" });
    for (const w of Object.values(b.i18n)) expect(w).toMatchObject({ name: "Campaign assistant", buttonLabel: "Ask the data" });
    expect(resolveBrand({ name: "Field desk", buttonLabel: "Open {name}" }).i18n.hi.buttonLabel).toBe("Open Field desk");
  });

  it("a language's own words win over the general ones, for that language only", () => {
    const b = resolveBrand({ name: "Campaign assistant", i18n: { fr: { name: "Assistant de campagne", buttonLabel: "Interroger les données" }, pt: { name: "Assistente da campanha" } } });
    expect(b.i18n.en).toMatchObject({ name: "Campaign assistant", buttonLabel: "Ask Campaign assistant" });
    expect(b.i18n.fr).toMatchObject({ name: "Assistant de campagne", buttonLabel: "Interroger les données" });
    expect(b.i18n.pt).toMatchObject({ name: "Assistente da campanha", buttonLabel: "Perguntar ao Assistente da campanha" });
    expect(b.i18n.hi.buttonLabel).toBe("Campaign assistant से पूछें");
  });

  it("the attribution line can be turned off, and never shows while the name is Lenspack", () => {
    expect(resolveBrand({ name: "Ask the data", poweredBy: false })).toMatchObject({ poweredBy: false });
    expect(resolveBrand({ name: "Ask the data", poweredBy: false }).i18n.en.poweredBy).toBeUndefined();
    expect(resolveBrand({ poweredBy: true }).poweredBy).toBe(false);
    expect(resolveBrand({ buttonLabel: "Open the chat" })).toMatchObject({ poweredBy: false, buttonLabel: "Open the chat" });
  });
});

describe("checking the brand", () => {
  it("refuses markup, blanks, long names, stray braces and unknown fields", () => {
    expect(() => parseBrand({ name: "<b>Data</b>" })).toThrow("brand.name: name is plain text: no < or >");
    expect(() => parseBrand({ buttonLabel: "Ask <script>" })).toThrow("brand.buttonLabel: buttonLabel is plain text");
    expect(() => parseBrand({ name: "   " })).toThrow("brand.name: name can't be empty");
    expect(() => parseBrand({ name: "x".repeat(41) })).toThrow("brand.name: name is at most 40 characters");
    expect(() => parseBrand({ buttonLabel: "y".repeat(41) })).toThrow("at most 40 characters");
    expect(() => parseBrand({ name: "Data {0}" })).toThrow("name can't contain { or }");
    expect(() => parseBrand({ buttonLabel: "Ask {who}" })).toThrow("buttonLabel may hold {name}");
    expect(() => parseBrand({ i18n: { fr: { name: "<i>x</i>" } } })).toThrow("brand.i18n.fr.name: name is plain text");
    expect(() => parseBrand({ i18n: { de: { name: "Daten" } } })).toThrow(/brand\.i18n/);
    expect(() => parseBrand({ colour: "red" })).toThrow(/brand/);
    expect(parseBrand({ name: "  Campaign assistant " })).toEqual({ name: "Campaign assistant" });
    expect(parseBrand(undefined)).toEqual({});
  });

  it("takes an icon from an https address, a path on this site or a small data:image URI, and nothing else", () => {
    for (const icon of ["https://example.org/mark.svg", "/static/mark.png", PNG]) expect(parseBrand({ icon }).icon).toBe(icon);
    const big = `data:image/png;base64,${Buffer.alloc(33 * 1024).toString("base64")}`;
    for (const icon of ["http://example.org/mark.png", "//example.org/mark.png", "javascript:alert(1)", "data:text/html;base64,PGI+", "https://x/a b.png", big, 'https://x/"onload="'])
      expect(() => parseBrand({ icon }), icon.slice(0, 40)).toThrow("icon is an https:// URL");
  });

  it("is part of lenspack.yaml's schema", () => {
    const base = { sources: { s: { url: "duckdb::memory:" } }, packs: [{ pack: "p.yaml", source: "s" }] };
    expect(configSchema.parse({ ...base, brand: { name: "Campaign assistant", poweredBy: false } }).brand).toEqual({ name: "Campaign assistant", poweredBy: false });
    expect(() => configSchema.parse({ ...base, brand: { name: "<b>" } })).toThrow();
  });
});

describe("where the brand comes from", () => {
  it("reads LENSPACK_BRAND_NAME, _BUTTON, _ICON and _POWERED_BY, checked like the config", () => {
    expect(brandFromEnv({ LENSPACK_BRAND_NAME: "Campaign assistant", LENSPACK_BRAND_BUTTON: "Ask the data", LENSPACK_BRAND_ICON: "/mark.svg", LENSPACK_BRAND_POWERED_BY: "off" })).toEqual({
      name: "Campaign assistant",
      buttonLabel: "Ask the data",
      icon: "/mark.svg",
      poweredBy: false,
    });
    expect(brandFromEnv({ LENSPACK_BRAND_NAME: "" })).toEqual({});
    expect(() => brandFromEnv({ LENSPACK_BRAND_NAME: "<img src=x>" })).toThrow("LENSPACK_BRAND.name: name is plain text");
    expect(() => brandFromEnv({ LENSPACK_BRAND_POWERED_BY: "maybe" })).toThrow("LENSPACK_BRAND_POWERED_BY: use on or off");
  });

  it("the environment wins over the config, and an admin's settings over both; each field on its own", () => {
    const b = brandSettings({ config: { name: "From config", buttonLabel: "Config label" }, env: { LENSPACK_BRAND_NAME: "From env" }, settings: state() });
    expect(b.get()).toMatchObject({ name: "From env", buttonLabel: "Config label" });
    expect(b.view(true).source).toMatchObject({ name: "env", buttonLabel: "config", icon: "default", poweredBy: "default" });
    expect(b.update({ name: "Set here" })).toMatchObject({ ok: true, brand: { name: "Set here" } });
    expect(b.get()).toMatchObject({ name: "Set here", buttonLabel: "Config label" });
    expect(b.view(true)).toMatchObject({ source: { name: "settings" }, defaults: { name: "From env" }, saved: { name: "Set here" } });
    // null puts a field back to the deployment's value.
    expect(b.update({ name: null })).toMatchObject({ ok: true, brand: { name: "From env" } });
    expect(() => brandSettings({ config: { name: "<b>" }, settings: null })).toThrow("brand.name");
  });

  it("an admin's change is kept, merged by language, checked, and read on the next call (no restart)", () => {
    const store = state();
    const b = brandSettings({ env: {}, settings: store });
    expect(b.update({ name: "Campaign assistant", i18n: { fr: { buttonLabel: "Interroger les données" }, pt: { name: "Assistente" } } })).toMatchObject({ ok: true });
    expect(b.update({ i18n: { pt: { name: null }, hi: { buttonLabel: "डेटा से पूछें" } } })).toMatchObject({ ok: true });
    expect(store.get("brand")).toEqual({ name: "Campaign assistant", i18n: { fr: { buttonLabel: "Interroger les données" }, hi: { buttonLabel: "डेटा से पूछें" } } });
    // Another server on the same state directory (a restart, a second copy) reads the same brand.
    const again = brandSettings({ env: {}, settings: settingsStore(store.path.replace(/\/settings\.json$/, "")) });
    expect(again.get().i18n).toMatchObject({ fr: { buttonLabel: "Interroger les données" }, hi: { buttonLabel: "डेटा से पूछें" }, pt: { name: "Campaign assistant" } });
    // Refused changes change nothing.
    expect(b.update({ name: "<b>bold</b>" })).toEqual({ ok: false, error: "brand.name: name is plain text: no < or >" });
    expect(b.update({ colour: "red" })).toMatchObject({ ok: false, error: expect.stringMatching(/^unknown brand field "colour"/) });
    expect(b.update({ i18n: "fr" })).toMatchObject({ ok: false });
    expect(b.get().name).toBe("Campaign assistant");
    expect(b.update({ name: null, i18n: null })).toMatchObject({ ok: true });
    expect(store.get("brand")).toBeUndefined();
    expect(b.get()).toEqual(DEFAULT_BRAND);
    // Without a state directory nothing can be saved, and the page is told it can't change it.
    const fixed = brandSettings({ config: { name: "Fixed" }, env: {}, settings: null });
    expect(fixed.update({ name: "Other" })).toMatchObject({ ok: false, error: expect.stringContaining("brand: in its config") });
    expect(fixed.view(true).writable).toBe(false);
  });
});

describe("the brand in the prompt", () => {
  it("introduces the assistant by its name, Lenspack by default; the rest of the prompt is the same", async () => {
    const pack = await loadPack(tickets);
    const [plain] = systemParts(pack, catalogueFrom(pack));
    const [named] = systemParts(pack, catalogueFrom(pack), undefined, undefined, undefined, undefined, { name: "Campaign assistant" });
    expect(plain.startsWith("You are Lenspack, a dashboard assistant. You build and edit a dashboard")).toBe(true);
    expect(named.startsWith("You are Campaign assistant, a dashboard assistant. You build and edit a dashboard")).toBe(true);
    expect(named.replace("Campaign assistant", "Lenspack")).toBe(plain);
  });

  it("is part of the prompt version that saved answers key on", () => {
    expect(promptVersionFor()).toBe(String(PROMPT_VERSION));
    expect(promptVersionFor("Lenspack")).toBe(String(PROMPT_VERSION));
    expect(promptVersionFor("Campaign assistant")).not.toBe(promptVersionFor());
    expect(promptVersionFor("Campaign assistant")).not.toBe(promptVersionFor("Ask the data"));
  });
});
