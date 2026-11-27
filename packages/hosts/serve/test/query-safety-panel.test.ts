// @vitest-environment jsdom
// The query limits card on the admin pages' Settings tab (web/admin/panel.js), against a host's
// <prefix>/settings/query-safety routes, faked here: the limits as in force, Save (tighter at once, looser only after
// the admin confirms), the pack's warnings, and the dry run. The routes themselves are tested in the Superset host
// (packages/hosts/superset/test/serve-routes.test.ts and dry-run.test.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PANEL = readFileSync(join(__dirname, "..", "web", "admin", "panel.js"), "utf8");
const HOST = "http://x/_superset/";

const QS = {
  limits: { maxRows: 20000, maxGroups: 100000, maxSeriesPoints: 20000, maxWindowDays: null, requireTime: false, defaultWindowDays: null },
  server: { maxQueriesPerTurn: 100, timeoutSeconds: 30, maxConcurrent: 8 },
  heavy: { maxRows: 10000, maxGroups: 10000, maxSeriesPoints: 5000, maxWindowDays: 400, requireTime: true, defaultWindowDays: 90 },
  datasets: { visits: { table: "visits", id: 5, heavy: false, highCardinality: [], cardinality: {} } },
  saved: {},
  source: "deployment",
  warnings: [],
  packRisks: [{ level: "warning", message: "\"household_id\" reads like one value per record" }],
  writable: true,
};
const DRY = { shapes: 40, compiled: 52, refused: [{ what: "x", message: "y" }], unanswerable: 0, findings: [{ what: "a list of visits rows", entity: "visits", level: "danger", message: "no LIMIT", sql: "SELECT *" }], errors: [], pack: [], text: "query safety dry run: 40 query shapes" };

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
              ? { status: 200, body: { querySafety: QS } }
              : u === `${HOST}settings/query-safety/dry-run`
                ? { status: 200, body: DRY }
                : { status: 200, body: { questions: [], proposals: [] } });
      return { ok: r.status < 400, status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body) };
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const field = (label: string) => Array.from(document.querySelectorAll("label.field")).find((l) => l.querySelector("span")?.textContent === label)!.querySelector("input") as HTMLInputElement;

describe("the query limits card", () => {
  it("shows the limits in force, the datasets and the pack's warnings", async () => {
    boot({ superset: true, sections: "all" });
    await settle();
    expect(document.body.textContent).toContain("Query limits");
    expect(field("Rows a query").value).toBe("20000");
    expect(field("Queries a question").value).toBe("100");
    expect(field("Longest time range (days, empty: none)").value).toBe("");
    expect(document.body.textContent).toContain("Heavy (needs a time range, last 90 days by default)");
    expect(document.body.textContent).toContain('"household_id" reads like one value per record');
  });

  it("saves a change, and sends a looser one again with confirm only once the admin agrees", async () => {
    boot({ superset: true, sections: "all" });
    await settle();
    const puts = () => calls.filter((c) => c.method === "PUT");
    answer = (c) => (c.method === "PUT" && !(c.body as { confirm?: boolean }).confirm && (c.body as { maxQueriesPerTurn: number }).maxQueriesPerTurn > 100 ? { status: 409, body: { error: "looser", looser: ["maxQueriesPerTurn 100 → 500"] } } : undefined);
    field("Queries a question").value = "40";
    button("Save").click();
    await settle();
    expect(puts()[0]).toMatchObject({ url: `${HOST}settings/query-safety`, body: { maxQueriesPerTurn: 40, maxWindowDays: null, datasets: {} } });
    const ask = vi.fn(() => false);
    vi.stubGlobal("confirm", ask);
    field("Queries a question").value = "500";
    button("Save").click();
    await settle();
    expect(ask).toHaveBeenCalledWith(expect.stringContaining("maxQueriesPerTurn 100 → 500"));
    expect(puts()).toHaveLength(2);
    ask.mockReturnValue(true);
    field("Queries a question").value = "500";
    button("Save").click();
    await settle();
    expect(puts().map((c) => (c.body as { confirm?: boolean }).confirm)).toEqual([undefined, undefined, undefined, true]);
  });

  it("marks a dataset heavy, and runs the dry run", async () => {
    boot({ superset: true, sections: "all" });
    await settle();
    const box = Array.from(document.querySelectorAll("label.switch")).find((l) => l.textContent?.startsWith("visits"))!.querySelector("input") as HTMLInputElement;
    box.checked = true;
    button("Save").click();
    await settle();
    expect(calls.find((c) => c.method === "PUT")!.body).toMatchObject({ datasets: { visits: { heavy: true } } });
    button("Check every query shape").click();
    await settle();
    expect(calls.some((c) => c.method === "POST" && c.url === `${HOST}settings/query-safety/dry-run`)).toBe(true);
    expect(document.body.textContent).toContain("40 shapes, 52 compiled by Superset (none run): 1 dangerous, 0 warnings, 1 refused by the limits, 0 errors");
  });
});
