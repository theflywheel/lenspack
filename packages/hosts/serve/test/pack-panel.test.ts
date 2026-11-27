// @vitest-environment jsdom
// The admin pages' Pack tab (web/admin/panel.js) against a host's <prefix>/settings/pack routes, faked here: shown
// only where the host offers it, the pack as it runs, Validate and Save with the problems shown inline, and the
// versions with Revert and the export link. The routes themselves are tested in the Superset host
// (packages/hosts/superset/test/pack-runtime.test.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PANEL = readFileSync(join(__dirname, "..", "web", "admin", "panel.js"), "utf8");
const HOST = "http://x/_superset/";

const VIEW = {
  version: 1,
  changedBy: "api:ci",
  changedAt: "2026-11-27T09:00:00Z",
  yaml: "labels:\n  region: Sales region\n",
  overlay: { labels: { region: "Sales region" } },
  layer: { labels: { region: "Sales region" } },
  sources: { labels: "settings", examples: "config", description: "none" },
  runtimeFields: ["description", "labels", "examples"],
  configOnly: [{ field: "timeZone", reason: "where the deployment is", value: "UTC" }],
  warnings: [],
  pack: { name: "shop", datasets: 1, dimensions: 3, measures: 4 },
};
const VERSIONS = {
  current: 1,
  versions: [{ version: 1, at: "2026-11-27T09:00:00Z", by: "api:ci", action: "edit", summary: "labels", changed: ["labels"], why: "clearer word" }],
};

type Call = { url: string; method: string; body?: unknown };
let calls: Call[] = [];
let answer: (c: Call) => { status: number; body: unknown } | undefined;

function boot(shell: Record<string, unknown>) {
  document.body.innerHTML = "";
  history.replaceState(null, "", "/#pack");
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
  // jsdom has no CSS.escape or scrolling, which the panel uses to scroll to a section.
  Element.prototype.scrollIntoView = () => {};
  vi.stubGlobal("CSS", { escape: (v: string) => v.replace(/[^\w-]/g, "\\$&") });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const c: Call = { url: String(url), method: init.method ?? "GET", ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) };
      calls.push(c);
      const given = answer(c);
      const u = c.url.replace(/\?.*$/, "");
      const r =
        given ??
        (u === "http://x/api/packs"
          ? { status: 200, body: { packs: [{ name: "shop" }], me: { user: "ana" } } }
          : u === `${HOST}settings/pack`
            ? { status: 200, body: VIEW }
            : u === `${HOST}settings/pack/versions`
              ? { status: 200, body: VERSIONS }
              : { status: 200, body: { questions: [], proposals: [] } });
      return { ok: r.status < 400, status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body) };
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("the Pack tab", () => {
  it("is offered on a Superset deployment's admin pages, beside the definitions, and not on Lenspack's own server", async () => {
    boot({ superset: true, sections: "all" });
    await settle();
    expect(document.querySelector('[data-tab="pack"]')).not.toBeNull();
    boot({ shell: "panel", superset: undefined });
    await settle();
    expect(document.querySelector('[data-tab="pack"]')).toBeNull();
  });

  it("shows the pack as it runs: the version, where each part comes from, the config-only parts and the versions", async () => {
    boot({ superset: true, sections: "all" });
    await settle();
    const text = main().textContent!;
    expect(text).toContain("Version 1, by api:ci");
    expect(text).toContain("1 datasets, 3 dimensions, 4 measures");
    expect(text).toContain("changed here");
    expect(text).toContain("the deploy config");
    expect(text).toContain("where the deployment is");
    expect(text).toContain("clearer word");
    expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe(VIEW.yaml);
    expect(document.querySelector(`a[href="${HOST}settings/pack/export?download=1"]`)).not.toBeNull();
  });

  it("validates and saves the YAML, showing a refusal's problems inline and changing nothing", async () => {
    boot({ superset: true, sections: "all" });
    await settle();
    const area = document.querySelector("textarea") as HTMLTextAreaElement;
    area.value = "measures:\n  - { dataset: orders, name: weight, agg: sum, column: weight_kg }\n";
    answer = (c) =>
      c.url.endsWith("settings/pack/validate") || (c.method === "PUT" && c.url === `${HOST}settings/pack`)
        ? { status: 400, body: { error: "bad", problems: ['overlay.measures[0] (weight): column "weight_kg" is not a column of Superset dataset "orders"'] } }
        : undefined;
    button("Validate").click();
    await settle();
    expect(calls.find((c) => c.url.endsWith("/validate"))).toMatchObject({ method: "POST", body: { yaml: area.value } });
    expect(main().querySelector(".bad-line")!.textContent).toContain('column "weight_kg" is not a column');
    button("Save").click();
    await settle();
    expect(calls.find((c) => c.method === "PUT")).toMatchObject({ body: { yaml: area.value, version: 1 } });
    expect(main().querySelector(".bad-line")!.textContent).toContain("Not changed");

    answer = (c) => (c.method === "PUT" ? { status: 200, body: { ok: true, version: { version: 2 }, warnings: [] } } : undefined);
    area.value = "labels:\n  region: Area\n";
    button("Save").click();
    await settle();
    expect(document.querySelector(".toast")!.textContent).toBe("Saved as version 2.");
  });

  it("goes back to a version and resets a part, after asking", async () => {
    const two = { ...VIEW, version: 2 };
    answer = (c) =>
      c.url === `${HOST}settings/pack` && c.method === "GET"
        ? { status: 200, body: two }
        : c.method === "POST" && /\/(revert|reset)$/.test(c.url)
          ? { status: 200, body: { ok: true, version: { version: 3 } } }
          : undefined;
    vi.spyOn(window, "confirm").mockReturnValue(true);
    boot({ superset: true, sections: "all" });
    await settle();
    button("Go back to this").click();
    await settle();
    expect(calls.find((c) => c.url.endsWith("/revert"))).toMatchObject({ body: { version: 1 } });
    button("Back to the config").click();
    await settle();
    expect(calls.find((c) => c.url.endsWith("/reset"))).toMatchObject({ body: { fields: ["labels"] } });
  });

  it("says so when the host has no pack routes", async () => {
    answer = (c) => (c.url.startsWith(`${HOST}settings/pack`) ? { status: 404, body: { error: "not found" } } : undefined);
    boot({ superset: true, sections: "all" });
    await settle();
    expect(main().textContent).toContain("This host does not let the pack change while it runs.");
  });
});
