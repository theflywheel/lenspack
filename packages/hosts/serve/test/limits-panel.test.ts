// @vitest-environment jsdom
// The question limits card on the admin pages' Settings tab (web/admin/panel.js), against a host's <prefix>/settings
// and <prefix>/limits routes, faked here: the limits in force, named people's own limits, Save, and who was counted
// today with a reset each. The routes themselves are tested in packages/hosts/serve/test/limits.test.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PANEL = readFileSync(join(__dirname, "..", "web", "admin", "panel.js"), "utf8");
const HOST = "http://x/_superset/";

const LIMITS = { questionsPerDay: 50, perMinute: 5, perHour: 0, adminsExempt: false, users: { ada: { questionsPerDay: 200 } }, on: true, defaults: {}, source: "default", writable: true };
const TODAY = { day: "2026-11-27", on: true, people: [{ user: "olu", today: 50, lastMinute: 1, lastHour: 9, limits: { questionsPerDay: 50, perMinute: 5, perHour: 0 }, atLimit: "questionsPerDay", refusedToday: 2, lastRefused: null }], counted: 1, kept: "file" };

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
              ? { status: 200, body: { limits: LIMITS } }
              : u === `${HOST}limits`
                ? { status: 200, body: TODAY }
                : { status: 200, body: { questions: [], proposals: [] } });
      return { ok: r.status < 400, status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body) };
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const fields = (label: string) => Array.from(document.querySelectorAll("label.field")).filter((l) => l.querySelector("span")?.textContent === label).map((l) => l.querySelector("input") as HTMLInputElement);

describe("the question limits card", () => {
  it("shows the limits, named people's own, and who was counted today", async () => {
    boot({ superset: true, sections: "all" });
    await settle();
    expect(document.body.textContent).toContain("Question limits per person");
    expect(fields("Questions per day")[0]!.value).toBe("50");
    expect(fields("Questions per minute")[0]!.value).toBe("5");
    expect(fields("Superset user name")[0]!.value).toBe("ada");
    expect(fields("Questions per day")[1]!.value).toBe("200");
    expect(calls.some((c) => c.url === `${HOST}limits?all=1`)).toBe(true);
    const row = Array.from(document.querySelectorAll("tr")).find((r) => r.textContent?.includes("olu"))!;
    expect(row.textContent).toContain("50 / 50");
    expect(row.textContent).toContain("per day");
  });

  it("saves everyone's and named people's limits together, an empty box meaning everyone's", async () => {
    boot({ superset: true, sections: "all" });
    await settle();
    fields("Questions per hour")[0]!.value = "30";
    button("Add a person").click();
    const names = fields("Superset user name");
    names[1]!.value = "bea";
    fields("Questions per minute")[2]!.value = "1";
    button("Save").click();
    await settle();
    const put = calls.find((c) => c.method === "PUT" && c.url === `${HOST}settings/limits`)!;
    expect(put.body).toEqual({ questionsPerDay: 50, perHour: 30, perMinute: 5, adminsExempt: false, users: { ada: { questionsPerDay: 200 }, bea: { perMinute: 1 } } });
  });

  it("resets one person's counts for today, after asking", async () => {
    boot({ superset: true, sections: "all" });
    await settle();
    vi.stubGlobal("confirm", () => true);
    button("Reset").click();
    await settle();
    expect(calls.some((c) => c.method === "DELETE" && c.url === `${HOST}limits?user=olu`)).toBe(true);
  });
});
