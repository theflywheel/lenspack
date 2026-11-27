// @vitest-environment jsdom
// The chat panel's language menu lists only the offered languages (plus Auto); a saved pick or a Superset language
// that is not offered falls back to the deployment's default.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const web = (f: string) => readFileSync(join(__dirname, "..", "web", f), "utf8");

function supersetLocale(locale: string | null) {
  document.body.innerHTML = "";
  if (locale) {
    const app = document.createElement("div");
    app.id = "app";
    app.dataset.bootstrap = JSON.stringify({ common: { locale } });
    document.body.append(app);
  }
}
function mountChat(language: Record<string, unknown>) {
  delete (window as unknown as Record<string, unknown>).LenspackChat;
  new Function(web("chat.js"))();
  const root = document.createElement("div");
  document.body.append(root);
  (window as unknown as { LenspackChat: { mount(r: HTMLElement, o: unknown): unknown } }).LenspackChat.mount(root, { api: "http://x/lenspack", pack: "p", board: "superset-9", examples: { en: ["Visits"] }, speech: { enabled: false }, language });
  return root;
}
const button = (root: HTMLElement) => root.querySelector(".lpc-lang > button")!.textContent!.replace(/\s+/g, " ").trim();
const menu = (root: HTMLElement) => Array.from(root.querySelectorAll(".lpc-menu label")).map((l) => l.textContent!.trim());
const OFFER = { default: "auto", offer: ["en", "fr", "pt"] };

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
});

describe("language.offer in the panel", () => {
  it("lists only the offered languages and Auto", () => {
    supersetLocale(null);
    expect(menu(mountChat(OFFER)).slice(0, 4)).toEqual(["Auto", "English", "Français", "Português"]);
  });

  it("lists all four when nothing is said", () => {
    supersetLocale(null);
    expect(menu(mountChat({ default: "auto" })).slice(0, 5)).toEqual(["Auto", "English", "Français", "हिन्दी", "Português"]);
  });

  it("ignores a saved pick that is not offered and uses the default", () => {
    supersetLocale(null);
    localStorage.setItem("lenspack-voice", JSON.stringify({ lang: "hi" }));
    expect(button(mountChat({ ...OFFER, default: "fr" }))).toBe("Auto · FR ▾");
  });

  it("keeps a saved pick that is offered", () => {
    supersetLocale(null);
    localStorage.setItem("lenspack-voice", JSON.stringify({ lang: "pt" }));
    expect(button(mountChat(OFFER))).toBe("PT ▾");
  });

  it("ignores a Superset language that is not offered", () => {
    supersetLocale("hi");
    expect(button(mountChat({ ...OFFER, default: "fr" }))).toBe("Auto · FR ▾");
    supersetLocale("fr");
    expect(button(mountChat({ ...OFFER, default: "pt" }))).toBe("Auto · FR ▾");
  });
});
