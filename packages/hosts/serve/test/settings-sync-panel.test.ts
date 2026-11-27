// @vitest-environment jsdom
// The admin pages (web/admin/panel.js) and settings changed elsewhere, against faked routes: the page sends back the
// revision it read (If-Match) with every settings change; when the server refuses one as changed elsewhere it reloads
// and says who; and while open it notices a change made elsewhere (on coming back into view, and every 30 seconds),
// drawing the tab again, or, while the admin is typing, saying so with a button to reload. The rule itself is the
// server's (packages/hosts/superset/test/settings-revision.test.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PANEL = readFileSync(join(__dirname, "..", "web", "admin", "panel.js"), "utf8");
// Each page mounted gets addresses of its own: an earlier test's page (its listeners stay on window) is not counted.
let mounted = 0;
let HOST = "";
let API = "";

type Call = { url: string; method: string; headers: Record<string, string>; body?: unknown };
type Answer = { status: number; body: unknown; tag?: string };
let calls: Call[] = [];
let revision = 4;
let pack = { version: 1, by: "ana" };
let answer: (c: Call) => Answer | undefined;

const FEATURES = { values: { voice: true }, options: [{ key: "voice", label: "Voice", help: "The microphone." }], source: { voice: "default" } };
const PACK_VIEW = () => ({ version: pack.version, yaml: "labels: {}\n", layer: {}, sources: {}, runtimeFields: ["labels"], configOnly: [], warnings: [], pack: { name: "shop", datasets: 1, dimensions: 1, measures: 1 } });

function boot(hash: string) {
  document.body.innerHTML = "";
  history.replaceState(null, "", `/${hash}`);
  mounted++;
  HOST = `http://x/p${mounted}/_superset/`;
  API = `http://x/p${mounted}/api/`;
  (window as unknown as Record<string, unknown>).__lpAdmin = { shell: "superset", superset: true, sections: "all", host: HOST, api: { panel: API, host: HOST } };
  new Function(PANEL)();
}
const settle = async () => {
  for (let i = 0; i < 25; i++) await new Promise((r) => setTimeout(r, 0));
};
const main = () => document.querySelector("#main")!;
const toast = () => document.querySelector(".toast")!.textContent;
const gets = (url: string) => calls.filter((c) => c.method === "GET" && c.url.replace(/\?.*$/, "") === url).length;

beforeEach(() => {
  calls = [];
  revision = 4;
  pack = { version: 1, by: "ana" };
  answer = () => undefined;
  localStorage.clear();
  vi.stubGlobal("CSS", { escape: (v: string) => v });
  Element.prototype.scrollIntoView = () => {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const c: Call = { url: String(url), method: init.method ?? "GET", headers: (init.headers ?? {}) as Record<string, string>, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) };
      calls.push(c);
      // Answered for any page's addresses; counted for the page under test only.
      const u = c.url.replace(/\?.*$/, "").replace(/^http:\/\/x\/p\d+\//, `http://x/p${mounted}/`);
      const tag = `"settings-${revision}"`;
      const r: Answer =
        answer(c) ??
        (u === `${API}packs`
          ? { status: 200, body: { packs: [{ name: "shop" }], me: { user: "ana" } } }
          : u === `${API}settings`
            ? { status: 200, body: { features: FEATURES }, tag }
            : u === `${API}settings/features`
              ? { status: 200, body: { features: FEATURES }, tag: `"settings-${++revision}"` }
              : u === `${HOST}settings/revision`
                ? { status: 200, body: { revision, lastChange: { section: "language", by: "ben" }, pack }, tag }
                : u === `${HOST}settings/pack`
                  ? { status: 200, body: PACK_VIEW(), tag: `"pack-${pack.version}"` }
                  : u === `${HOST}settings/pack/versions`
                    ? { status: 200, body: { versions: [] } }
                    : u.startsWith(HOST)
                      ? { status: 404, body: { error: "not here" } }
                      : { status: 200, body: { questions: [], proposals: [] } });
      const headers = new Headers(r.tag ? { ETag: r.tag } : {});
      return { ok: r.status < 400, status: r.status, headers, json: async () => r.body };
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the admin pages and settings changed elsewhere", () => {
  it("send back the revision they read with every settings change, and the newer one after their own change", async () => {
    boot("#settings");
    await settle();
    const box = main().querySelector('input[type="checkbox"]') as HTMLInputElement;
    box.checked = false;
    box.dispatchEvent(new Event("change"));
    await settle();
    const writes = calls.filter((c) => c.url.startsWith(`${API}settings/features`));
    expect(writes[0]!.headers["If-Match"]).toBe('"settings-4"');
    // Their own change moved the revision; the next one is sent on it, not refused as a change made elsewhere.
    (main().querySelector('input[type="checkbox"]') as HTMLInputElement).dispatchEvent(new Event("change"));
    await settle();
    expect(calls.filter((c) => c.url.startsWith(`${API}settings/features`))[1]!.headers["If-Match"]).toBe('"settings-5"');
  });

  it("reload and say who when a change is refused as made elsewhere", async () => {
    boot("#settings");
    await settle();
    const before = gets(`${API}settings`);
    answer = (c) => (c.url.startsWith(`${API}settings/features`) ? { status: 409, body: { code: "changed-elsewhere", by: "ben", error: "x" }, tag: '"settings-9"' } : undefined);
    (main().querySelector('input[type="checkbox"]') as HTMLInputElement).dispatchEvent(new Event("change"));
    await settle();
    expect(toast()).toBe("Changed elsewhere by ben, reloaded. Make your change again on what is shown now.");
    expect(gets(`${API}settings`)).toBe(before + 1);
  });

  it("notice a change made elsewhere when they come back into view: drawn again, or a notice while the admin types", async () => {
    boot("#settings");
    await settle();
    const before = gets(`${API}settings`);
    window.dispatchEvent(new Event("focus"));
    await settle();
    // Nothing moved: nothing drawn again.
    expect(gets(`${API}settings`)).toBe(before);
    revision = 6;
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(gets(`${API}settings`)).toBe(before + 1);
    expect(toast()).toBe("Changed elsewhere by ben; this page now shows it.");
    // Typing: not drawn again under their hands, but told.
    main().dispatchEvent(new Event("input", { bubbles: true }));
    revision = 7;
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(gets(`${API}settings`)).toBe(before + 1);
    expect(main().textContent).toContain("Changed elsewhere by ben while you were editing here.");
    // And a change sent from that form still goes on the old revision, so the server refuses it rather than undoing Ben's.
    (main().querySelector('input[type="checkbox"]') as HTMLInputElement).dispatchEvent(new Event("change"));
    await settle();
    expect(calls.filter((c) => c.url.startsWith(`${API}settings/features`)).at(-1)!.headers["If-Match"]).toBe('"settings-6"');
  });

  it("ask every 30 seconds while open", async () => {
    vi.useFakeTimers({ toFake: ["setInterval"] });
    boot("#settings");
    await settle();
    const asked = () => calls.filter((c) => c.url === `${HOST}settings/revision`).length;
    const n = asked();
    vi.advanceTimersByTime(30_000);
    await settle();
    expect(asked()).toBe(n + 1);
  });

  it("on the Pack tab: the version shown goes with a change, and a refusal keeps the admin's text beside the reloaded pack", async () => {
    boot("#pack");
    await settle();
    const area = main().querySelector("textarea") as HTMLTextAreaElement;
    area.value = "labels: { region: Area }\n";
    pack = { version: 2, by: "ben" };
    answer = (c) => (c.method === "PUT" ? { status: 409, body: { code: "changed-elsewhere", by: "ben", error: "x" } } : undefined);
    Array.from(main().querySelectorAll("button")).find((b) => b.textContent === "Save")!.click();
    await settle();
    expect(calls.find((c) => c.method === "PUT")!.headers["If-Match"]).toBe('"pack-1"');
    expect(toast()).toBe("Changed elsewhere by ben, reloaded. Make your change again on what is shown now.");
    expect(main().querySelector("details pre")!.textContent).toBe("labels: { region: Area }\n");
    // The next change goes on the version now shown.
    answer = (c) => (c.method === "PUT" ? { status: 200, body: { ok: true, version: { version: 3 } } } : undefined);
    Array.from(main().querySelectorAll("button")).find((b) => b.textContent === "Save")!.click();
    await settle();
    expect(calls.filter((c) => c.method === "PUT").at(-1)!.headers["If-Match"]).toBe('"pack-2"');
  });
});
