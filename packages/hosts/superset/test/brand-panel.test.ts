// @vitest-environment jsdom
// The assistant's name in the chat panel and on the dashboard button: Lenspack's words by default, the deployment's
// name and label (from /_superset/info brand) in all four languages, a language's own words, the icon, the
// "Powered by Lenspack" line, and a name with markup in it shown as text, never as markup.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { type Brand, DEFAULT_BRAND, resolveBrand } from "@lenspack/serve";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const web = (f: string) => readFileSync(join(__dirname, "..", "web", f), "utf8");
type Chat = { setOffline(on: boolean): void };
const ICON = `data:image/png;base64,${Buffer.from("a small mark").toString("base64")}`;

function supersetLocale(locale: string | null) {
  document.body.innerHTML = "";
  if (locale) {
    const app = document.createElement("div");
    app.id = "app";
    app.dataset.bootstrap = JSON.stringify({ common: { locale } });
    document.body.append(app);
  }
}
function mountChat(brand?: Brand | Record<string, unknown>) {
  delete (window as unknown as Record<string, unknown>).LenspackChat;
  new Function(web("chat.js"))();
  const root = document.createElement("div");
  document.body.append(root);
  const chat = (window as unknown as { LenspackChat: { mount(r: HTMLElement, o: unknown): Chat } }).LenspackChat.mount(root, {
    api: "http://x/lenspack",
    pack: "p",
    board: "superset-9",
    examples: { en: ["Visits by region"] },
    speech: { enabled: false },
    ...(brand ? { brand } : {}),
  });
  return { root, chat };
}
const title = (root: HTMLElement) => root.querySelector(".lpc-ttl b")!.textContent;
const poweredBy = (root: HTMLElement) => root.querySelector(".lpc-by") as HTMLAnchorElement;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}), body: null, text: async () => "" })));
});
afterEach(() => vi.unstubAllGlobals());

const LANGS = [
  ["en", null],
  ["fr", "fr"],
  ["hi", "hi"],
  ["pt", "pt_BR"],
] as const;

describe("the chat panel's name", () => {
  it.each(LANGS)("is Lenspack's by default (%s), with or without the server's brand", (_, locale) => {
    const expected = { en: "Ask Lenspack", fr: "Demander à Lenspack", hi: "Lenspack से पूछें", pt: "Perguntar ao Lenspack" }[_];
    for (const brand of [undefined, DEFAULT_BRAND]) {
      supersetLocale(locale);
      const { root, chat } = mountChat(brand);
      expect(title(root)).toBe(expected);
      expect(poweredBy(root).hidden).toBe(true);
      expect(root.querySelector(".lpc-mark")!.textContent).toBe("L");
      chat.setOffline(true);
      expect(root.querySelector(".lpc-down")!.textContent).toContain("Lenspack");
    }
  });

  it.each(LANGS)("takes the deployment's name and translated label (%s)", (lang, locale) => {
    supersetLocale(locale);
    const { root, chat } = mountChat(resolveBrand({ name: "Campaign assistant" }));
    expect(title(root)).toBe({ en: "Ask Campaign assistant", fr: "Demander à Campaign assistant", hi: "Campaign assistant से पूछें", pt: "Perguntar ao Campaign assistant" }[lang]);
    chat.setOffline(true);
    const down = root.querySelector(".lpc-down")!.textContent!;
    expect(down).toContain("Campaign assistant");
    expect(down).not.toContain("Lenspack");
    expect(poweredBy(root).hidden).toBe(false);
    expect(poweredBy(root).textContent).toBe({ en: "Powered by Lenspack", fr: "Propulsé par Lenspack", hi: "Lenspack द्वारा संचालित", pt: "Com tecnologia Lenspack" }[lang]);
    expect(poweredBy(root).href).toBe("https://github.com/theflywheel/lenspack");
  });

  it.each(LANGS)("uses the deployment's own button label in every language (%s), and a language's own label there", (lang, locale) => {
    supersetLocale(locale);
    const { root } = mountChat(resolveBrand({ name: "Campaign assistant", buttonLabel: "Ask the data", i18n: { fr: { buttonLabel: "Interroger les données" } } }));
    expect(title(root)).toBe(lang === "fr" ? "Interroger les données" : "Ask the data");
  });

  it("follows a language picked in the menu", () => {
    supersetLocale(null);
    const { root } = mountChat(resolveBrand({ name: "Campaign assistant", i18n: { pt: { name: "Assistente da campanha" } } }));
    expect(title(root)).toBe("Ask Campaign assistant");
    (root.querySelector(".lpc-lang > button") as HTMLButtonElement).click();
    const pt = Array.from(root.querySelectorAll(".lpc-menu label")).find((l) => l.textContent!.includes("Português"))!.querySelector("input")!;
    pt.checked = true;
    pt.dispatchEvent(new Event("change"));
    expect(title(root)).toBe("Perguntar ao Assistente da campanha");
  });

  it("can leave out the attribution line, and shows the deployment's icon", () => {
    supersetLocale(null);
    const { root } = mountChat(resolveBrand({ name: "Ask the data", poweredBy: false, icon: ICON }));
    expect(poweredBy(root).hidden).toBe(true);
    const img = root.querySelector(".lpc-mark img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(ICON);
    expect(img.alt).toBe("");
  });

  it("reads the brand from /_superset/info when mounted without it", async () => {
    supersetLocale(null);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => (String(url).endsWith("/_superset/info") ? { features: {}, brand: resolveBrand({ name: "Campaign assistant", buttonLabel: "Ask the data" }) } : {}), body: null, text: async () => "" })));
    delete (window as unknown as Record<string, unknown>).LenspackChat;
    new Function(web("chat.js"))();
    const root = document.createElement("div");
    document.body.append(root);
    (window as unknown as { LenspackChat: { mount(r: HTMLElement, o: unknown): Chat } }).LenspackChat.mount(root, { api: "http://x/lenspack", pack: "p", board: "superset-9" });
    await vi.waitFor(() => expect(title(root)).toBe("Ask the data"));
    expect(poweredBy(root).hidden).toBe(false);
  });

  it("shows a name with markup in it as text, never as markup", () => {
    supersetLocale(null);
    // The server refuses this (brand.ts); the panel must still never parse it.
    const evil = "<img src=x onerror=alert(1)>";
    const words = { name: evil, buttonLabel: `Ask ${evil}`, poweredBy: "Powered by Lenspack" };
    const { root, chat } = mountChat({ name: evil, buttonLabel: words.buttonLabel, icon: null, poweredBy: true, i18n: { en: words, fr: words, hi: words, pt: words } });
    expect(title(root)).toBe(`Ask ${evil}`);
    chat.setOffline(true);
    expect(root.querySelector(".lpc-down")!.textContent).toContain(evil);
    expect(root.querySelectorAll("img")).toHaveLength(0);
  });
});

describe("the dashboard button's name", () => {
  const overlay = async (brand: Brand | undefined, locale: string | null = null) => {
    supersetLocale(locale);
    window.history.pushState({}, "", "/superset/dashboard/9/");
    delete (window as unknown as Record<string, unknown>).__lenspackOverlay;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        json: async () => (String(url).includes("/_superset/bind") ? { board: "superset-9", title: "Visits" } : String(url).includes("/_superset/info") ? { pack: "p", examples: [], panel: "float", ...(brand ? { brand } : {}) } : { ok: true }),
      })),
    );
    Object.defineProperty(document, "currentScript", { configurable: true, value: { src: "http://x/lenspack/overlay.js" } });
    new Function(web("overlay.js"))();
    await vi.waitFor(() => expect((document.querySelector(".lpo-btn") as HTMLElement).style.display).toBe("inline-flex"));
    return document.querySelector(".lpo-btn") as HTMLButtonElement;
  };

  it("says Ask Lenspack by default", async () => {
    expect((await overlay(undefined)).textContent).toBe("LAsk Lenspack");
    expect((await overlay(DEFAULT_BRAND, "fr")).textContent).toBe("LDemander à Lenspack");
  });

  it("says the deployment's label, in the page's language, with its icon", async () => {
    const brand = resolveBrand({ name: "Campaign assistant", buttonLabel: "Ask the data", icon: ICON, i18n: { hi: { buttonLabel: "डेटा से पूछें" } } });
    const btn = await overlay(brand);
    expect(btn.lastChild!.textContent).toBe("Ask the data");
    expect(btn.querySelector("b img")!.getAttribute("src")).toBe(ICON);
    expect((await overlay(brand, "hi")).lastChild!.textContent).toBe("डेटा से पूछें");
    expect((await overlay(resolveBrand({ name: "Campaign assistant" }), "pt_BR")).lastChild!.textContent).toBe("Perguntar ao Campaign assistant");
  });
});
