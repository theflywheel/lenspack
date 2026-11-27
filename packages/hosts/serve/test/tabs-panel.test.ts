// @vitest-environment jsdom
// The tab cards on the admin pages' Settings tab (web/admin/panel.js), against a host's <prefix>/settings and
// <prefix>/tabs routes, faked here: the tab rules and switches with Save, each dashboard's tabs with the protected
// ones ticked (saved as TAB ids), chat-made tabs with their makers and counts, and deleting one (asking again when email
// reports are sent from it). The routes themselves are tested in packages/hosts/superset/test/serve-routes.test.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PANEL = readFileSync(join(__dirname, "..", "web", "admin", "panel.js"), "utf8");
const HOST = "http://x/_superset/";

const TABS = { editable: "all", protected: { "9": ["TAB-old"] }, maxPerDashboard: 20, maxPerUser: 3, maxWidgetsPerTab: "auto", create: true, playground: false, defaults: {}, saved: {} };
const FEATURES = { options: [], values: { chatTabs: true, playground: false }, source: {} };
const LIST = {
  tabs: [],
  limits: { maxPerDashboard: 20, maxPerUser: 3, maxWidgetsPerTab: "auto" },
  dashboards: [
    {
      board: "superset-12", dashboard: 12, title: "Stock", missing: ["TAB-gone"], chatTabs: 1, byUser: { olu: 1 }, widgetLimit: 6,
      tabs: [
        { id: "TAB-ov", title: "Overview", parent: null, protected: true, inherited: false, ownOnly: false, chat: null, widgets: 4 },
        { id: "TAB-in", title: "Inside", parent: "TAB-ov", protected: false, inherited: true, ownOnly: false, chat: null, widgets: 2 },
        { id: "TAB-trend", title: "Trend", parent: null, protected: false, inherited: false, ownOnly: false, chat: null, widgets: 3 },
        { id: "TAB-lp-1", title: "olu", parent: null, protected: false, inherited: false, ownOnly: false, chat: { user: "olu", playground: true }, widgets: 1 },
      ],
    },
  ],
};

type Call = { url: string; method: string; body?: unknown };
let calls: Call[] = [];
let answer: (c: Call) => { status: number; body: unknown } | undefined;

function boot(shell: Record<string, unknown>) {
  document.body.innerHTML = "";
  history.replaceState(null, "", "/#settings");
  (window as unknown as Record<string, unknown>).__lpAdmin = { shell: "superset", host: HOST, api: { panel: "http://x/api/", host: HOST }, ...shell };
  new Function(PANEL)();
}
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};
const main = () => document.querySelector("main") ?? document.body;
const button = (text: string) => Array.from(document.querySelectorAll("button")).find((b) => b.textContent === text) as HTMLButtonElement;

beforeEach(() => {
  calls = [];
  answer = () => undefined;
  localStorage.clear();
  Element.prototype.scrollIntoView = () => {};
  vi.stubGlobal("CSS", { escape: (v: string) => v.replace(/[^\w-]/g, "\\$&") });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const c: Call = { url: String(url), method: init.method ?? "GET", ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) };
      calls.push(c);
      const u = c.url.replace(/\?.*$/, "");
      const r =
        answer(c) ??
        (u === "http://x/api/packs"
          ? { status: 200, body: { packs: [{ name: "shop" }], me: { user: "ana" } } }
          : u === "http://x/api/settings"
            ? { status: 200, body: { features: { options: [], values: {}, source: {} }, brand: null } }
            : u === `${HOST}settings`
              ? { status: 200, body: { tabs: TABS, features: FEATURES } }
              : u === `${HOST}tabs`
                ? { status: 200, body: LIST }
                : { status: 200, body: { questions: [], proposals: [] } });
      return { ok: r.status < 400, status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body) };
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const box = (label: string) => document.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;

describe("the tab cards", () => {
  it("show the rules, and each dashboard's tabs with the protected ones ticked, makers and counts", async () => {
    boot({ superset: true, sections: "all" });
    await settle();
    expect(document.body.textContent).toContain("Tabs on dashboards");
    expect((document.querySelector('input[name="lp-tabs-mode"][value="all"]') as HTMLInputElement).checked).toBe(true);
    expect(box("Protected: Overview").checked).toBe(true);
    expect(box("Protected: Inside").disabled).toBe(true);
    expect(box("Protected: Trend").checked).toBe(false);
    const row = Array.from(document.querySelectorAll("tr")).find((r) => r.textContent?.includes("TAB-lp-1"))!;
    expect(row.textContent).toContain("olu");
    expect(row.textContent).toContain("playground");
    expect(document.body.textContent).toContain("Chat tabs: 1 of 20. Widget limit per tab: 6.");
    expect(document.body.textContent).toContain("olu 1/3");
    expect(document.body.textContent).toContain("TAB-gone");
  });

  it("saves the rules, and a switch only when it changed", async () => {
    boot({ superset: true, sections: "all" });
    await settle();
    (document.querySelector('input[name="lp-tabs-mode"][value="own"]') as HTMLInputElement).checked = true;
    const play = Array.from(document.querySelectorAll("label.switch")).find((l) => l.textContent?.includes("playground"))!.querySelector("input") as HTMLInputElement;
    play.checked = true;
    const card = Array.from(document.querySelectorAll("section.card")).find((c) => c.querySelector("h2")?.textContent === "Tabs on dashboards")!;
    (Array.from(card.querySelectorAll("button")).find((b) => b.textContent === "Save") as HTMLButtonElement).click();
    await settle();
    expect(calls.find((c) => c.method === "PUT" && c.url === `${HOST}settings/tabs`)!.body).toEqual({ editable: "own", maxPerUser: 3, maxPerDashboard: 20, maxWidgetsPerTab: "auto" });
    expect(calls.find((c) => c.method === "PUT" && c.url === `${HOST}settings/features`)!.body).toEqual({ playground: true });
  });

  it("saves protected tabs as TAB ids, keeping other dashboards' lists", async () => {
    boot({ superset: true, sections: "all" });
    await settle();
    box("Protected: Trend").checked = true;
    button("Save protected tabs").click();
    await settle();
    expect(calls.find((c) => c.method === "PUT" && c.url === `${HOST}settings/tabs`)!.body).toEqual({ protected: { "9": ["TAB-old"], "12": ["TAB-ov", "TAB-trend"] } });
  });

  it("deletes a chat-made tab after asking, and asks again when email reports are sent from it", async () => {
    boot({ superset: true, sections: "all" });
    await settle();
    const asked: string[] = [];
    vi.stubGlobal("confirm", (q: string) => (asked.push(q), true));
    answer = (c) => (c.method === "DELETE" && !c.url.includes("confirm=1") ? { status: 409, body: { error: "Email reports or alerts are sent from this tab (Weekly)", reports: ["Weekly"] } } : undefined);
    button("Delete").click();
    await settle();
    expect(asked[0]).toContain("“olu”");
    expect(asked[1]).toContain("Weekly");
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual([`${HOST}tabs/12/TAB-lp-1`, `${HOST}tabs/12/TAB-lp-1?confirm=1`]);
  });
});
