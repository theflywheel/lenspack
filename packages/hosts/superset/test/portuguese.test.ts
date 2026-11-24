// @vitest-environment jsdom
// Portuguese in the panel: Superset's pt and pt_BR interfaces both give the Portuguese panel on Auto, a pick
// of Português is sent as the reply language and speech hint, and the language-menu switch still applies.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const web = (f: string) => readFileSync(join(__dirname, "..", "web", f), "utf8");
type Chat = { setOffline(on: boolean): void };
const bodies: Record<string, unknown>[] = [];

function supersetLocale(locale: string | null) {
  document.body.innerHTML = "";
  if (locale) {
    const app = document.createElement("div");
    app.id = "app";
    app.dataset.bootstrap = JSON.stringify({ common: { locale } });
    document.body.append(app);
  }
}
function mountChat(extra: Record<string, unknown> = {}) {
  delete (window as unknown as Record<string, unknown>).LenspackChat;
  new Function(web("chat.js"))();
  const root = document.createElement("div");
  document.body.append(root);
  (window as unknown as { LenspackChat: { mount(r: HTMLElement, o: unknown): Chat } }).LenspackChat.mount(root, {
    api: "http://x/lenspack",
    pack: "p",
    board: "superset-9",
    examples: { en: ["Children vaccinated per day"], pt: ["Crianças vacinadas por dia"] },
    speech: { enabled: false },
    ...extra,
  });
  return root;
}
const langButton = (root: HTMLElement) => root.querySelector(".lpc-lang > button")!.textContent!.replace(/\s+/g, " ").trim();
const chips = (root: HTMLElement) => Array.from(root.querySelectorAll(".lpc-chip")).map((c) => c.textContent);

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  bodies.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: string }) => {
      if (init?.body) bodies.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({}), body: null, text: async () => "" };
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("Portuguese in the chat panel", () => {
  it.each(["pt_BR", "pt"])("follows Superset's %s interface on Auto: Portuguese words and chips", (locale) => {
    supersetLocale(locale);
    const root = mountChat();
    expect(root.querySelector(".lpc-ttl b")!.textContent).toBe("Perguntar ao Lenspack");
    expect(langButton(root)).toBe("Auto · PT ▾");
    expect(chips(root)).toEqual(["Crianças vacinadas por dia"]);
    expect((root.querySelector(".lpc-in") as HTMLTextAreaElement).placeholder).toMatch(/^Peça um gráfico/);
  });

  it("offers Português in the menu, and a pick is sent as the reply language", async () => {
    supersetLocale(null);
    localStorage.setItem("lenspack-voice", JSON.stringify({ lang: "pt" }));
    const root = mountChat();
    expect(langButton(root)).toBe("PT ▾");
    (root.querySelector(".lpc-lang > button") as HTMLButtonElement).click();
    expect(Array.from(root.querySelectorAll(".lpc-menu label")).map((l) => l.textContent!.trim())).toContain("Português");
    const input = root.querySelector(".lpc-in") as HTMLTextAreaElement;
    input.value = "Quantas crianças foram vacinadas?";
    (root.querySelector(".lpc-go") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(bodies.some((b) => Array.isArray(b.messages))).toBe(true));
    expect(bodies.find((b) => Array.isArray(b.messages))!.language).toBe("pt");
  });

  it("with the language menu switched off, a saved pick no longer applies and the menu is hidden", () => {
    supersetLocale(null);
    localStorage.setItem("lenspack-voice", JSON.stringify({ lang: "pt" }));
    const root = mountChat({ features: { languageMenu: false } });
    expect((root.querySelector(".lpc-lang") as HTMLElement).hidden).toBe(true);
    expect(root.querySelector(".lpc-ttl b")!.textContent).toBe("Ask Lenspack");
    expect(chips(root)).toEqual(["Children vaccinated per day"]);
  });
});

describe("Portuguese on the overlay button", () => {
  beforeEach(() => {
    window.history.pushState({}, "", "/superset/dashboard/9/");
    delete (window as unknown as Record<string, unknown>).__lenspackOverlay;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        json: async () => (String(url).includes("/_superset/bind") ? { board: "superset-9", title: "Painel" } : String(url).includes("/_superset/info") ? { pack: "p", examples: [], panel: "float" } : { ok: true }),
      })),
    );
  });

  it("says Perguntar ao Lenspack under Superset's pt_BR interface", async () => {
    supersetLocale("pt_BR");
    Object.defineProperty(document, "currentScript", { configurable: true, value: { src: "http://x/lenspack/overlay.js" } });
    new Function(web("overlay.js"))();
    await vi.waitFor(() => expect((document.querySelector(".lpo-btn") as HTMLElement).style.display).toBe("inline-flex"));
    expect(document.querySelector(".lpo-btn")!.textContent).toContain("Perguntar ao Lenspack");
  });
});
