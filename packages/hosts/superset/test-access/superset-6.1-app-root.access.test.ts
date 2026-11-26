// Superset 6.1 under a path of its host (SUPERSET_APP_ROOT=/superset), as some Helm charts run it: Superset answers
// only below /superset, so everything the plugin and Lenspack give a browser must start with it. The whole access
// suite runs at the root; this checks what changes under a path. Run with `pnpm test:access app-root`.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PACK, type Session, type Stack, http, openPage, readChat, startStack } from "./stack";

const ROOT = "/superset";

describe.sequential("Superset 6.1.0 under /superset", () => {
  let stack: Stack;
  let admin: Session;
  let owner: Session;
  let A: number;

  beforeAll(async () => {
    stack = await startStack("6.1.0", { appRoot: ROOT });
    A = stack.fixtures.dashboards.a;
    admin = await stack.as("lp_admin");
    owner = await stack.as("lp_owner");
  });
  afterAll(async () => {
    await stack?.stop();
  });

  it("answers only below its root, the assistant's route included", async () => {
    expect((await http(stack.superset, "GET", "/lenspack/overlay.js")).status).toBe(404);
    const script = await owner.send("GET", "/lenspack/overlay.js");
    expect(script.status).toBe(200);
    expect(script.text).toContain("window.__lenspackOverlay");
  });

  it("loads the page script's overlay from below the root", async () => {
    const page = await owner.send("GET", `/superset/dashboard/${A}/`);
    expect(page.status).toBe(200);
    expect(page.text).toContain(`var base = "${ROOT}/lenspack";`);
    expect(page.text).not.toContain('"/lenspack/overlay.js"');
  });

  it("tells the overlay Superset's root, binds the dashboard and answers the chat through the route", async () => {
    const info = await owner.send("GET", "/lenspack/_superset/info");
    expect(info.status).toBe(200);
    expect(info.json.supersetRoot).toBe(ROOT);
    expect((await owner.send("GET", `/lenspack/_superset/bind?dashboard=${A}`)).json).toMatchObject({ board: `superset-${A}` });
    const turn = readChat(await owner.send("POST", `/lenspack/api/${PACK}/superset-${A}/chat?review=off`, { body: { messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "TOOL list_metrics {}" }] }] } }));
    expect(turn.status, turn.error).toBe(200);
    expect(turn.tools.map((t) => t.tool)).toEqual(["list_metrics"]);
  });

  it("after a chat removes a chart, the page drops it: the check against the saved dashboard reads Superset's API below the root", async () => {
    const board = `superset-${A}`;
    const added = await owner.send("POST", `/lenspack/api/${PACK}/${board}/ops`, {
      body: { ops: ["one", "two"].map((n) => ({ op: "add_widget", id: `root_${n}`, widget: { title: `Root ${n}`, kind: "chart", chart: "bar", query: { kind: "breakdown", dimension: "region", measure: "visit_total" } }, placement: { place: "bottom", width: "half" } })) },
    });
    expect(added.json, added.text).toMatchObject({ ok: true });
    const widgets = (await owner.send("GET", `/lenspack/api/${PACK}/${board}`)).json.board.config.widgets as Record<string, { title: string }>;
    const id = Object.entries(widgets).find(([, w]) => w.title === "Root one")![0];
    const browser = await openPage(owner, `${ROOT}/superset/dashboard/${A}/`);
    try {
      const { page } = browser;
      // Every read of a saved dashboard the page makes (by id or by slug: Superset may show the slug in the address), by path, with Superset's answer.
      const reads: [string, number][] = [];
      page.on("response", (r) => {
        const path = new URL(r.url()).pathname;
        if (/\/api\/v1\/dashboard\/[^/]+$/.test(path)) reads.push([path, r.status()]);
      });
      await page.waitForFunction(() => document.querySelectorAll(".dashboard-content .anchor-link-container[id^='CHART-']").length === 2, null, { timeout: 60_000 });
      await page.click(".lpo-btn");
      await page.waitForSelector(".lpc-in");
      reads.length = 0;
      await page.fill(".lpc-in", `TOOL remove_widget ${JSON.stringify({ id })}`);
      await page.click(".lpc-go");
      // Under /superset, Superset's in-place refresh can leave the removed chart drawn: the check against the saved
      // dashboard is what finds it and reloads the page. Without Superset's root on its read, it never did.
      await page.waitForFunction(() => document.querySelectorAll(".dashboard-content .anchor-link-container[id^='CHART-']").length === 1, null, { timeout: 45_000 });
      await new Promise((r) => setTimeout(r, 5000));
      // Every read of the saved dashboard went below Superset's root, and Superset answered it.
      expect(reads.length).toBeGreaterThan(0);
      const key = /\/superset\/dashboard\/([^/]+)/.exec(new URL(page.url()).pathname)![1];
      for (const [path, status] of reads) expect([path, status]).toEqual([`${ROOT}/api/v1/dashboard/${key}`, 200]);
    } finally {
      await browser.close();
    }
  });

  it("links a person's own dashboards below the root", async () => {
    const made = await owner.send("POST", `/lenspack/_superset/my/dashboards?dashboard=${A}`, { body: { title: "Root check" } });
    expect(made.status, made.text).toBe(200);
    expect(made.json.url).toBe(`${ROOT}/superset/dashboard/${made.json.dashboard}/`);
    const back = await owner.send("GET", made.json.url.slice(ROOT.length));
    expect(back.status).toBe(200);
  });

  it("serves the admin panel, the settings page and its redirects below the root", async () => {
    const panel = await admin.send("GET", "/lenspack/_superset/admin/");
    expect(panel.status).toBe(200);
    const settings = await admin.send("GET", "/ai-assistant/");
    expect(settings.status).toBe(200);
    const actions = [...settings.text.matchAll(/<form[^>]* action="([^"]+)"/g)].map((m) => m[1]!);
    expect(actions.length).toBeGreaterThan(0);
    for (const a of actions) expect(a.startsWith(`${ROOT}/ai-assistant/`), a).toBe(true);
    expect(settings.text).toContain(`href="${ROOT}/lenspack/_superset/admin/"`);
    expect(settings.text).toContain(`href="${ROOT}/superset/welcome/"`);
    // A form sent back: Superset's CSRF token from the page, then a redirect below the root.
    const token = /name="csrf_token" value="([^"]+)"/.exec(settings.text)![1]!;
    const sent = await admin.send("POST", "/ai-assistant/telemetry", { headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf_token: token, retentionDays: "30" }).toString() });
    expect(sent.status).toBe(302);
    expect(new URL(String(sent.headers.location), stack.superset).pathname).toBe(`${ROOT}/ai-assistant/`);
  });

  it("puts the settings menu entry below the root", async () => {
    const home = await admin.send("GET", "/superset/welcome/");
    expect(home.text).toContain(`${ROOT}/ai-assistant/`);
  });
});
