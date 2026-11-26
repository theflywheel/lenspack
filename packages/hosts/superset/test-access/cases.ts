// What Lenspack shows and changes for each Superset user, against a real Superset (see stack.ts for the stack and
// fixtures.py for the people, roles, rules and dashboards). Every case states the exact outcome: who gets which rows,
// which refusal, which status. The cases test outcomes, not how Lenspack gets there, so they keep holding when
// queries move to running as the user inside Superset.
//
// The chat runs on a stub model that calls the tool it is told to ("TOOL query {...}"): the point is what the tools
// and routes let through, not the model's words.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type Identity, signIdentity } from "../src/identity";
import { type Position, layoutProblems, reachable } from "../src/layout";
import { type ChatResult, PACK, type Session, type Stack, http, openPage, readChat, startStack } from "./stack";

const VISITS = { North: 3, South: 4, East: 8, West: 16 };
const STOCK = { North: 32, South: 64, East: 128, West: 256 };
const ALL_MEASURES = ["stock_count", "stock_total", "visit_count", "visit_total"];
const USERS = ["lp_admin", "lp_owner", "lp_viewer", "lp_partial", "lp_north", "lp_inlist", "lp_complex", "lp_templ", "lp_rbac", "lp_rbac_off", "lp_noroles", "lp_outage", "lp_misroute", "lp_lensadmin", "lp_lensuser", "lp_reader", "lp_alpha"] as const;
type User = (typeof USERS)[number];

const READ_ONLY = /can view this dashboard but not edit it in Superset/;
const EDITS_OFF = /Changing dashboards through the chat is turned off/;
const NO_ACCESS = /your Superset access doesn't include it\. A Superset admin can give you access\./;

const byGroup = (rows: { group: string; value: number }[] | undefined) => Object.fromEntries((rows ?? []).map((r) => [r.group, r.value]));
const sorted = (xs: string[]) => [...xs].sort();
const BREAKDOWN = (measure: string) => ({ query_kind: "breakdown", measure, dimension: "region" });
const explainQuery = (measure: string) => `q=${encodeURIComponent(JSON.stringify({ kind: "breakdown", measure, dimension: "region" }))}`;

export function accessSuite(version: string) {
  describe.sequential(`Superset ${version}`, () => {
    let stack: Stack;
    const s = {} as Record<User, Session>;
    let A: string;
    let B: string;
    let C: string;
    let modelCallsBefore = 0;

    const chat = async (who: User, board: string, tool: string, args: object): Promise<ChatResult> =>
      readChat(await s[who].lp("POST", `api/${PACK}/${board}/chat?review=off`, { messages: [{ id: `m${Date.now()}`, role: "user", parts: [{ type: "text", text: `TOOL ${tool} ${JSON.stringify(args)}` }] }] }));
    const toolOutput = (r: ChatResult) => {
      expect(r.status, r.error).toBe(200);
      expect(r.tools, JSON.stringify({ text: r.text, reuse: r.reuse, error: r.error })).toHaveLength(1);
      return r.tools[0]!.output;
    };
    /** What Superset would sign for a request, signed here with the same key (derived from its SECRET_KEY). */
    const signed = (over: Partial<Identity>, key = stack.identityKey) => signIdentity({ u: "lp_viewer", a: false, r: ["Gamma", "lp_stock", "lp_visits"], t: Math.floor(Date.now() / 1000), ...over }, key);
    const direct = (method: string, path: string, header?: string, body?: object) => http(stack.lenspack, method, path, { headers: header ? { "x-lenspack-identity": header } : {}, ...(body ? { body } : {}) });
    const dashboardTitle = async (id: number) => (await s.lp_admin.send("GET", `/api/v1/dashboard/${id}`)).json.result.dashboard_title as string;
    /** The personal dashboards a user has (the panel's list). */
    const mine = async (who: User) => ((await s[who].lp("GET", "_superset/my")).json.dashboards as { dashboard: number }[]).map((d) => d.dashboard);
    const widgetOps = (widgets: [string, string, string][]) => ({
      ops: widgets.map(([id, title, measure]) => ({ op: "add_widget", id, widget: { title, kind: "chart", chart: "bar", query: { kind: "breakdown", dimension: "region", measure } }, placement: { place: "bottom", width: "half" } })),
    });

    beforeAll(async () => {
      stack = await startStack(version);
      A = `superset-${stack.fixtures.dashboards.a}`;
      B = `superset-${stack.fixtures.dashboards.b}`;
      C = `superset-${stack.fixtures.dashboards.c}`;
      for (const u of USERS) s[u] = await stack.as(u);
      // The dashboards start empty: the admin puts a chart of each dataset on A and a stock chart on B, through Lenspack.
      const a = await s.lp_admin.lp("POST", `api/${PACK}/${A}/ops`, widgetOps([["visits_by_region", "Visits by region", "visit_total"], ["stock_by_region", "Stock by region", "stock_total"]]));
      expect(a.status, a.text).toBe(200);
      const b = await s.lp_admin.lp("POST", `api/${PACK}/${B}/ops`, widgetOps([["stock_b", "Stock by region", "stock_total"]]));
      expect(b.status, b.text).toBe(200);
      const c = await s.lp_admin.lp("POST", `api/${PACK}/${C}/ops`, widgetOps([["visits_c", "Visits by region", "visit_total"]]));
      expect(c.status, c.text).toBe(200);
    }, 900_000);

    afterAll(async () => {
      await stack?.stop();
    }, 120_000);

    describe("the default", () => {
      it("applies each user's Superset access without being told to (hostPolicy: superset)", () => {
        expect(stack.log()).toMatch(/host policy superset/);
        expect(stack.log()).not.toMatch(/host policy off/);
      });
    });

    describe("viewing", () => {
      it("refuses the chat and the board API on a dashboard the user can't open in Superset (403)", async () => {
        // B has a dashboard role: lp_viewer reads the stock dataset but is not in the role.
        for (const [method, path] of [["GET", `api/${PACK}/${B}`], ["GET", `api/${PACK}/${B}/data`], ["GET", `api/${PACK}/${B}/options?field=region`], ["POST", `api/${PACK}/${B}/chat`], ["POST", `api/${PACK}/${B}/ops`]] as const) {
          const r = await s.lp_viewer.lp(method, path, method === "POST" ? { messages: [], ops: [] } : undefined);
          expect([path, r.status]).toEqual([path, 403]);
        }
        // A has charts on both datasets: a user with no roles reads neither, so may not open it.
        expect((await s.lp_noroles.lp("GET", `api/${PACK}/${A}`)).status).toBe(403);
        // The same refusal from Lenspack itself, for a request Superset signed as "may not view".
        expect((await direct("GET", `/api/${PACK}/${B}`, signed({ d: stack.fixtures.dashboards.b, b: B, p: PACK, e: false, v: false }))).status).toBe(403);
      });

      it("opens a dashboard through its dashboard role, and opens it for its role only", async () => {
        expect((await s.lp_rbac.lp("GET", `api/${PACK}/${B}`)).status).toBe(200);
        expect((await s.lp_rbac.lp("GET", `api/${PACK}/${A}`)).status).toBe(403);
      });

      it("binds only a dashboard the user may open", async () => {
        expect((await s.lp_viewer.lp("GET", `_superset/bind?dashboard=${stack.fixtures.dashboards.b}`)).status).toBe(403);
        expect((await s.lp_viewer.lp("GET", `_superset/bind?dashboard=${stack.fixtures.dashboards.a}`)).status).toBe(200);
      });

      it("lists only the dashboards the user may open", async () => {
        const boards = async (who: User) => sorted(((await s[who].lp("GET", `api/${PACK}`)).json.boards as { id: string }[]).map((b) => b.id));
        const dashboards = async (who: User) => sorted(((await s[who].lp("GET", "_superset/dashboards")).json as { id: number }[]).map((d) => `superset-${d.id}`));
        expect(await boards("lp_admin")).toEqual(sorted([A, B, C]));
        expect(await boards("lp_viewer")).toEqual([A]);
        expect(await boards("lp_rbac")).toEqual(sorted([B, C]));
        expect(await boards("lp_noroles")).toEqual([]);
        // The dashboard with tabs opens for its owner (an admin) only, and is not bound to a board yet (its cases bind it).
        expect(await dashboards("lp_admin")).toEqual(sorted([A, B, C, `superset-${stack.fixtures.dashboards.t}`]));
        expect(await dashboards("lp_viewer")).toEqual([A]);
        expect(await dashboards("lp_rbac")).toEqual(sorted([B, C]));
        expect(await dashboards("lp_noroles")).toEqual([]);
      });

      it("refuses a request signed for dashboard A used on dashboard B (403)", async () => {
        const forA = signed({ u: "lp_owner", d: stack.fixtures.dashboards.a, b: A, p: PACK, e: true, v: true });
        expect((await direct("GET", `/api/${PACK}/${A}`, forA)).status).toBe(200);
        for (const path of [`/api/${PACK}/${B}`, `/api/${PACK}/${B}/data`]) expect([path, (await direct("GET", path, forA)).status]).toEqual([path, 403]);
        expect((await direct("POST", `/api/${PACK}/${B}/chat`, forA, { messages: [] })).status).toBe(403);
        // And the pack named differently from the one signed.
        expect((await direct("GET", `/api/other/${A}`, forA)).status).toBe(403);
      });

      it("treats a missing, tampered, wrongly keyed, expired or future identity as not signed in (401)", async () => {
        const good = signed({ u: "lp_admin", a: true, r: ["Admin"] });
        expect((await direct("GET", `/api/${PACK}`, good)).status).toBe(200);
        const [body, sig] = [good.slice(0, good.lastIndexOf(".")), good.slice(good.lastIndexOf(".") + 1)];
        const claims = JSON.parse(Buffer.from(body, "base64url").toString());
        const tampered = `${Buffer.from(JSON.stringify({ ...claims, u: "someone_else" })).toString("base64url")}.${sig}`;
        const promoted = signed({ u: "lp_viewer" }).replace(/^[^.]+/, Buffer.from(JSON.stringify({ ...claims, u: "lp_viewer", a: true })).toString("base64url"));
        const now = Math.floor(Date.now() / 1000);
        for (const [what, header] of [
          ["unsigned", undefined],
          ["tampered", tampered],
          ["admin flag added", promoted],
          ["wrong key", signed({ u: "lp_admin", a: true }, "f".repeat(64))],
          ["expired", signed({ u: "lp_admin", a: true, t: now - 600 })],
          ["from the future", signed({ u: "lp_admin", a: true, t: now + 600 })],
          ["garbage", "not-a-signature"],
        ] as const)
          for (const path of [`/api/${PACK}`, `/api/${PACK}/${A}/data`, "/_superset/settings", "/api/_usage"]) expect([what, path, (await direct("GET", path, header)).status]).toEqual([what, path, 401]);
      });

      it("refuses path tricks (400), through Superset and at Lenspack", async () => {
        const tricks = [
          `api/${PACK}/${A}/../${B}/data`,
          `api/${PACK}/${A}/%2e%2e/${B}/data`,
          `api/${PACK}/${A}/.%2e/${B}/data`,
          `api/${PACK}/${A}/..%2f${B}/data`,
          `api/${PACK}/${A}%2f..%2f${B}/data`,
          `api/${PACK}/${A}/%252e%252e/${B}/data`,
          `api/${PACK}/${A}/..%5c${B}/data`,
          `api/${PACK}/${A}/../../_usage`,
        ];
        for (const path of tricks) expect([path, (await s.lp_owner.send("GET", `/lenspack/${path}`)).status]).toEqual([path, 400]);
        const forA = signed({ u: "lp_owner", d: stack.fixtures.dashboards.a, b: A, p: PACK, e: true, v: true });
        for (const path of tricks.filter((p) => !p.includes("%25"))) expect([path, (await direct("GET", `/${path}`, forA)).status]).toEqual([path, 400]);
      });
    });

    describe("editing", () => {
      const rename = (title: string) => ({ ops: [{ op: "set_title", title }] });

      it("lets the dashboard owner edit, through the board API and the chat", async () => {
        const r = await s.lp_owner.lp("POST", `api/${PACK}/${A}/ops`, rename("Access A (owner)"));
        expect(r.status, r.text).toBe(200);
        expect(await dashboardTitle(stack.fixtures.dashboards.a)).toBe("Access A (owner)");
        expect(toolOutput(await chat("lp_owner", A, "rename_board", { title: "Access A (owner chat)" }))).toMatchObject({ applied: true });
        expect(await dashboardTitle(stack.fixtures.dashboards.a)).toBe("Access A (owner chat)");
      });

      it("refuses a viewer, with the chat's message, and changes nothing", async () => {
        const before = await dashboardTitle(stack.fixtures.dashboards.a);
        const r = await s.lp_viewer.lp("POST", `api/${PACK}/${A}/ops`, rename("Access A (viewer)"));
        expect(r.status).toBe(403);
        expect(r.json.error).toMatch(READ_ONLY);
        expect(JSON.stringify(toolOutput(await chat("lp_viewer", A, "rename_board", { title: "Access A (viewer chat)" })))).toMatch(READ_ONLY);
        expect(await dashboardTitle(stack.fixtures.dashboards.a)).toBe(before);
      });

      it("lets an admin edit a dashboard they don't own", async () => {
        const r = await s.lp_admin.lp("POST", `api/${PACK}/${A}/ops`, rename("Access A"));
        expect(r.status, r.text).toBe(200);
        expect(await dashboardTitle(stack.fixtures.dashboards.a)).toBe("Access A");
      });

      it("refuses everyone, admins included, while the boardEdits switch is off", async () => {
        const off = await s.lp_admin.lp("PUT", "_superset/settings/features", { boardEdits: false });
        expect(off.status, off.text).toBe(200);
        try {
          for (const who of ["lp_admin", "lp_owner"] as const) {
            const r = await s[who].lp("POST", `api/${PACK}/${A}/ops`, rename(`Access A (${who}, switched off)`));
            expect([who, r.status]).toEqual([who, 403]);
            expect(r.json.error).toMatch(EDITS_OFF);
            expect(JSON.stringify(toolOutput(await chat(who, A, "rename_board", { title: "switched off" })))).toMatch(EDITS_OFF);
          }
          expect(await dashboardTitle(stack.fixtures.dashboards.a)).toBe("Access A");
        } finally {
          expect((await s.lp_admin.lp("PUT", "_superset/settings/features", { boardEdits: null })).status).toBe(200);
        }
      });
    });

    // Superset's tabs: the layout as Superset keeps it (position_json, read back through Superset's own API), after
    // Lenspack's board API and chat change the dashboard. Every change lands where Superset draws it.
    describe("a dashboard with tabs", () => {
      let T: string;
      const layout = async () => JSON.parse((await s.lp_admin.send("GET", `/api/v1/dashboard/${stack.fixtures.dashboards.t}`)).json.result.position_json) as Position;
      const ops = (list: object[]) => s.lp_admin.lp("POST", `api/${PACK}/${T}/ops`, { ops: list });
      /** The tabs above each chart Superset draws, by chart title ("TAB-overview>TAB-trend"). */
      const tabsOf = (pos: Position) => {
        const drawn = reachable(pos);
        return Object.fromEntries(Object.values(pos).filter((c: any) => c?.type === "CHART" && drawn.has(c.id)).map((c: any) => [c.meta.sliceName, (c.parents as string[]).filter((p) => p.startsWith("TAB-")).join(">")]));
      };
      const kpi = (id: string, title: string, place = "bottom") => ({ op: "add_widget", id, widget: { title, kind: "kpi", query: { kind: "value", measure: "stock_total" } }, placement: { place, width: "quarter" } });

      beforeAll(async () => {
        // Bound on first use, as the overlay binds any dashboard it is opened on.
        const bound = await s.lp_admin.lp("GET", `_superset/bind?dashboard=${stack.fixtures.dashboards.t}`);
        expect(bound.status, bound.text).toBe(200);
        T = bound.json.board;
      });

      it("adds a chart to the first tab, never under the grid the tabs left behind", async () => {
        const r = await ops([kpi("stock_kpi", "Stock total")]);
        expect(r.json, r.text).toMatchObject({ ok: true });
        const pos = await layout();
        expect(tabsOf(pos)).toEqual({ "Stock total": "TAB-overview" });
        expect((pos.GRID_ID as { children: string[] }).children).toEqual([]);
        expect(layoutProblems(pos)).toEqual([]);
      });

      it("puts what the chat adds on the tab the viewer has open, or after the widget it names", async () => {
        const said = await s.lp_admin.lp("POST", `api/${PACK}/${T}/chat?review=off`, {
          messages: [{ id: "tabs1", role: "user", parts: [{ type: "text", text: `TOOL add_widget ${JSON.stringify({ id: "visits_kpi", title: "Visits total", kind: "kpi", query_kind: "value", measure: "visit_total", place: "bottom", width: "quarter" })}` }] }],
          view: { tabs: ["TAB-overview", "TAB-trend"] },
        });
        expect(toolOutput(readChat(said))).toMatchObject({ applied: true });
        expect((await ops([kpi("stock_kpi_2", "Stock again", "after:stock_kpi")])).json).toMatchObject({ ok: true });
        const pos = await layout();
        expect(tabsOf(pos)).toEqual({ "Stock total": "TAB-overview", "Visits total": "TAB-overview>TAB-trend", "Stock again": "TAB-overview" });
        expect(layoutProblems(pos)).toEqual([]);
        const charts = (await s.lp_admin.send("GET", `/api/v1/dashboard/${stack.fixtures.dashboards.t}/charts`)).json.result.map((c: { slice_name: string }) => c.slice_name);
        expect(sorted(charts)).toEqual(["Stock again", "Stock total", "Visits total"]);
      });

      it("resizes a chart where it is", async () => {
        expect((await ops([{ op: "resize_widget", id: "visits_kpi", width: "half" }])).json).toMatchObject({ ok: true });
        const pos = await layout();
        const chart = Object.values(pos).find((c: any) => c?.meta?.sliceName === "Visits total") as unknown as { meta: { width: number } };
        expect(chart.meta.width).toBe(6);
        expect(tabsOf(pos)["Visits total"]).toBe("TAB-overview>TAB-trend");
      });

      it("refuses a move plainly and changes nothing", async () => {
        const before = await layout();
        const r = await ops([{ op: "move_widget", id: "visits_kpi", placement: { place: "top", width: "half" } }]);
        expect(r.json).toMatchObject({ ok: false });
        expect(r.json.error).toMatch(/can't move charts on it yet/);
        expect(await layout()).toEqual(before);
      });

      it("a restore puts a removed chart back on its tab, at its size", async () => {
        const versions = (await s.lp_admin.lp("GET", `api/${PACK}/${T}/versions`)).json as { version: number }[];
        expect((await ops([{ op: "remove_widget", id: "visits_kpi" }])).json).toMatchObject({ ok: true });
        expect(tabsOf(await layout())["Visits total"]).toBeUndefined();
        expect((await s.lp_admin.lp("POST", `api/${PACK}/${T}/revert`, { version: versions[0]!.version })).status).toBe(200);
        const pos = await layout();
        expect(tabsOf(pos)["Visits total"]).toBe("TAB-overview>TAB-trend");
        expect((Object.values(pos).find((c: any) => c?.meta?.sliceName === "Visits total") as unknown as { meta: { width: number } }).meta.width).toBe(6);
        expect(layoutProblems(pos)).toEqual([]);
        const charts = (await s.lp_admin.send("GET", `/api/v1/dashboard/${stack.fixtures.dashboards.t}/charts`)).json.result.map((c: { slice_name: string }) => c.slice_name);
        expect(sorted(charts)).toEqual(["Stock again", "Stock total", "Visits total"]);
      });
    });

    // What a person sees: a headless browser on the dashboard, the overlay's chat asked to remove a chart. The page must
    // match the saved dashboard afterwards without a reload, also when the reply is cut off after the turn has
    // already removed the chart (the browser drops the connection once the server has finished).
    describe("the open page after a chat edit", () => {
      it("drops a removed chart without a reload, and says so plainly when the reply was cut off on its way", async () => {
        const copied = await s.lp_admin.lp("POST", `_superset/my/dashboards?dashboard=${stack.fixtures.dashboards.a}`, { copy: true });
        expect(copied.status, copied.text).toBe(200);
        const dash = copied.json.dashboard as number;
        const board = `superset-${dash}`;
        let browser: Awaited<ReturnType<typeof openPage>> | null = null;
        try {
          // A third chart, so the dashboard is never left empty.
          const kpi = await s.lp_admin.lp("POST", `api/${PACK}/${board}/ops`, { ops: [{ op: "add_widget", id: "stock_kpi", widget: { title: "Stock total", kind: "kpi", query: { kind: "value", measure: "stock_total" } }, placement: { place: "bottom", width: "quarter" } }] });
          expect(kpi.json, kpi.text).toMatchObject({ ok: true });
          const widgets = (await s.lp_admin.lp("GET", `api/${PACK}/${board}`)).json.board.config.widgets as Record<string, { title: string }>;
          const idOf = (title: string) => Object.entries(widgets).find(([, w]) => w.title === title)![0];
          browser = await openPage(s.lp_admin, `/superset/dashboard/${dash}/`);
          const { page } = browser;
          const shown = () => page.evaluate(() => (document.querySelector(".dashboard-content") as HTMLElement | null)?.innerText ?? "");
          const charts = () => page.evaluate(() => document.querySelectorAll(".dashboard-content .anchor-link-container[id^='CHART-']").length);
          await page.waitForFunction(() => document.querySelectorAll(".dashboard-content .anchor-link-container[id^='CHART-']").length === 3, null, { timeout: 60_000 });
          expect(await shown()).toContain("Stock by region");
          // Set on the page now: a reload would lose it.
          await page.evaluate(() => ((window as unknown as { __samePage: boolean }).__samePage = true));
          const samePage = () => page.evaluate(() => (window as unknown as { __samePage?: boolean }).__samePage === true);
          await page.click(".lpo-btn");
          await page.waitForSelector(".lpc-in");
          const ask = async (words: string) => {
            await page.fill(".lpc-in", words);
            await page.click(".lpc-go");
          };

          // The reply arrives: the chart goes from the page, in place.
          await ask(`TOOL remove_widget ${JSON.stringify({ id: idOf("Stock by region") })}`);
          await page.waitForFunction(() => document.querySelectorAll(".dashboard-content .anchor-link-container[id^='CHART-']").length === 2, null, { timeout: 30_000 });
          expect(await shown()).not.toContain("Stock by region");
          expect(await samePage()).toBe(true);

          // The reply is cut off after the server has removed the chart (as when a phone changes networks): the chat
          // finds out, says so, and the chart goes from the page all the same. Nothing is sent again.
          let chatPosts = 0;
          await page.route(
            (u) => /\/chat$/.test(u.pathname),
            async (route) => {
              chatPosts++;
              await (await route.fetch()).text();
              await route.abort("connectionreset");
            },
          );
          await ask(`TOOL remove_widget ${JSON.stringify({ id: idOf("Visits by region") })}`);
          await page.waitForFunction(() => document.querySelector(".lpo-panel")?.textContent?.includes("Your change was made"), null, { timeout: 30_000 });
          const notes = await page.evaluate(() => Array.from(document.querySelectorAll(".lpc-note")).map((n) => n.textContent));
          expect(notes.at(-1)).toBe("Your change was made: removed “Visits by region”. The connection dropped before the reply finished.");
          await page.waitForFunction(() => document.querySelectorAll(".dashboard-content .anchor-link-container[id^='CHART-']").length === 1, null, { timeout: 30_000 });
          expect(await shown()).not.toContain("Visits by region");
          expect(await shown()).toContain("Stock total");
          expect(await charts()).toBe(1);
          expect(await samePage()).toBe(true);
          expect(await page.locator(".lpc-note.bad").count()).toBe(0);
          expect(chatPosts).toBe(1);
          const after = JSON.parse((await s.lp_admin.send("GET", `/api/v1/dashboard/${dash}`)).json.result.position_json) as Position;
          expect(Object.values(after).filter((c: any) => c?.type === "CHART" && reachable(after).has(c.id))).toHaveLength(1);
        } finally {
          await browser?.close();
          await s.lp_admin.lp("POST", "_superset/my/dashboards/delete", { dashboard: dash });
        }
      });
    });

    describe("data", () => {
      const catalogue = async (who: User) => (await s[who].lp("GET", `api/${PACK}`)).json as { catalogue: { measures: { key: string }[]; dimensions: { key: string }[]; entities: { key: string }[] }; accessNotice?: string };
      const measures = async (who: User) => sorted((await catalogue(who)).catalogue.measures.map((m) => m.key));

      it("keeps a hidden dataset's measures, its own columns and its name out of the catalogue", async () => {
        for (const who of ["lp_admin", "lp_owner", "lp_viewer", "lp_north", "lp_inlist", "lp_templ"] as const) expect([who, await measures(who)]).toEqual([who, ALL_MEASURES]);
        const partial = (await catalogue("lp_partial")).catalogue;
        expect(sorted(partial.measures.map((m) => m.key))).toEqual(["visit_count", "visit_total"]);
        expect(partial.dimensions.map((d) => d.key)).not.toContain("item");
        expect(partial.dimensions.map((d) => d.key)).toContain("region");
        expect(partial.entities.map((e) => e.key)).toEqual(["visits"]);
        // The chat's own view of the catalogue.
        const listed = toolOutput(await chat("lp_partial", A, "list_metrics", {}));
        expect(sorted(listed.measures.map((m: { key: string }) => m.key))).toEqual(["visit_count", "visit_total"]);
        expect(listed.entities.map((e: { key: string }) => e.key)).toEqual(["visits"]);
      });

      it("refuses every query on a hidden dataset, saying it is the user's Superset access", async () => {
        const out = toolOutput(await chat("lp_partial", A, "query", BREAKDOWN("stock_total")));
        expect(out.ok).toBe(false);
        expect(out.error).toMatch(/"stock_total" is not available to you/);
        expect(out.error).toMatch(NO_ACCESS);
        const rows = toolOutput(await chat("lp_partial", A, "query", { query_kind: "rows", entity: "stock", dimension: "region" }));
        expect(rows.ok).toBe(false);
        expect(rows.error).toMatch(NO_ACCESS);
        const explained = await s.lp_partial.lp("GET", `api/${PACK}/explain?${explainQuery("stock_total")}`);
        expect(explained.json).toMatchObject({ ok: false, code: "ACCESS_HIDDEN" });
        // A measure that is not in the pack at all keeps the pack's own message, for anyone.
        for (const who of ["lp_partial", "lp_viewer"] as const) {
          const missing = toolOutput(await chat(who, A, "query", BREAKDOWN("doses")));
          expect(missing.error).toMatch(/"doses" is not a measure in pack "access"/);
          expect(missing.error).not.toMatch(/Superset access/);
        }
      });

      it("narrows chat queries by each user's RLS, to the exact rows", async () => {
        const want: Record<string, [Record<string, number> | null, Record<string, number> | null]> = {
          lp_admin: [VISITS, STOCK],
          lp_owner: [VISITS, STOCK],
          lp_viewer: [VISITS, STOCK],
          lp_partial: [VISITS, null],
          lp_north: [{ North: 3 }, { North: 32 }],
          lp_inlist: [{ North: 3, East: 8 }, STOCK],
          // The LIKE rule can't be translated, so visits is kept from lp_complex entirely (fails closed).
          lp_complex: [null, STOCK],
          // The template is rendered by Superset as lp_templ, then applied: the rows of team lp_templ only.
          lp_templ: [{ North: 1, East: 8 }, STOCK],
        };
        for (const [who, [visits, stock]] of Object.entries(want)) {
          for (const [measure, expected] of [["visit_total", visits], ["stock_total", stock]] as const) {
            const out = toolOutput(await chat(who as User, A, "query", BREAKDOWN(measure)));
            if (expected) expect([who, measure, byGroup(out.rows)]).toEqual([who, measure, expected]);
            else expect([who, measure, out.ok, out.error]).toEqual([who, measure, false, expect.stringMatching(NO_ACCESS)]);
          }
        }
        expect(stack.log()).toMatch(/access: visits is kept from lp_complex: the clause "region LIKE 'N%'"/);
      });

      it("never lets a user's own filter widen their rows", async () => {
        const south = toolOutput(await chat("lp_north", A, "query", { ...BREAKDOWN("visit_total"), filters: "region = South" }));
        expect(byGroup(south.rows)).toEqual({});
        const list = toolOutput(await chat("lp_north", A, "query", { query_kind: "rows", entity: "visits", dimension: "region,district,team" }));
        expect(new Set(list.rows.map((r: { region: string }) => r.region))).toEqual(new Set(["North"]));
        expect(list.rows).toHaveLength(2);
      });

      it("narrows the filter menus by RLS", async () => {
        const values = async (who: User) => sorted(((await s[who].lp("GET", `api/${PACK}/${A}/options?field=region`)).json as { value: string }[]).map((v) => v.value));
        expect(await values("lp_viewer")).toEqual(["East", "North", "South", "West"]);
        expect(await values("lp_north")).toEqual(["North"]);
        expect(await values("lp_inlist")).toEqual(["East", "North"]);
        expect(await values("lp_templ")).toEqual(["East", "North"]);
        // Region is on both datasets: with visits kept from lp_complex, the menu reads stock, which they may read in full.
        expect(await values("lp_complex")).toEqual(["East", "North", "South", "West"]);
        const listed = toolOutput(await chat("lp_north", A, "list_values", { dimension: "region" }));
        expect(listed.values.map((v: { value: string }) => v.value)).toEqual(["North"]);
      });

      it("narrows the board's widget data by RLS, and leaves out a hidden dataset's widgets", async () => {
        const data = async (who: User, board = A) => (await s[who].lp("GET", `api/${PACK}/${board}/data`)).json as Record<string, { rows: { group: string; value: number }[]; error?: string }>;
        const want: Record<string, [Record<string, number> | null, Record<string, number> | null]> = {
          lp_viewer: [VISITS, STOCK],
          lp_partial: [VISITS, null],
          lp_north: [{ North: 3 }, { North: 32 }],
          lp_inlist: [{ North: 3, East: 8 }, STOCK],
          lp_complex: [null, STOCK],
          lp_templ: [{ North: 1, East: 8 }, STOCK],
        };
        for (const [who, [visits, stock]] of Object.entries(want)) {
          const d = await data(who as User);
          for (const [widget, expected] of [["visits_by_region", visits], ["stock_by_region", stock]] as const) {
            if (expected) expect([who, widget, byGroup(d[widget]!.rows)]).toEqual([who, widget, expected]);
            else expect([who, widget, d[widget]!.rows, d[widget]!.error]).toEqual([who, widget, [], expect.stringMatching(/is not available to you/)]);
          }
        }
      });

      it("says up front, before any model call, when every dataset is kept from the user", async () => {
        // lp_rbac reads no dataset outside the dashboards their roles open (see "dashboard roles" below).
        expect((await catalogue("lp_rbac")).accessNotice).toMatch(NO_ACCESS);
        expect((await catalogue("lp_noroles")).accessNotice).toMatch(NO_ACCESS);
        // On a dashboard Superset says they may view, a user who reads nothing there is told so, and no model is asked.
        const forA = signed({ u: "lp_noroles", r: [], d: stack.fixtures.dashboards.a, b: A, p: PACK, e: false, v: true });
        expect((await direct("GET", `/api/${PACK}/${A}`, forA)).json.accessNotice).toMatch(NO_ACCESS);
        modelCallsBefore = stack.modelCalls();
        const r = readChat(await direct("POST", `/api/${PACK}/${A}/chat?review=off`, forA, { messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: `TOOL query ${JSON.stringify(BREAKDOWN("visit_total"))}` }] }] }));
        expect(r.status).toBe(403);
        expect(r.error).toMatch(NO_ACCESS);
        expect(stack.modelCalls()).toBe(modelCallsBefore);
        // A user who sees something gets no notice.
        expect((await catalogue("lp_partial")).accessNotice).toBeUndefined();
      });

      it("fails closed while Lenspack can't reach Superset, and recovers when it can", async () => {
        stack.cut(true);
        try {
          const c = await catalogue("lp_outage");
          expect(c.catalogue.measures).toEqual([]);
          expect(c.accessNotice).toMatch(/Superset access could not be checked/);
          const d = (await s.lp_outage.lp("GET", `api/${PACK}/${A}/data`)).json;
          expect([d.visits_by_region.rows, d.stock_by_region.rows]).toEqual([[], []]);
          const r = await chat("lp_outage", A, "query", BREAKDOWN("visit_total"));
          expect(r.status).toBe(403);
        } finally {
          stack.cut(false);
        }
        expect(await measures("lp_outage")).toEqual(ALL_MEASURES);
        expect(byGroup(toolOutput(await chat("lp_outage", A, "query", BREAKDOWN("visit_total"))).rows)).toEqual(VISITS);
      });

      it("refuses, never answers, while Superset answers 404 for the access route, and forgets it once the route is back", async () => {
        // A Superset pod without the plugin, or a path prefix sending the request elsewhere, in the middle of a run.
        stack.missingRoute("/api/v1/lenspack/access");
        try {
          // lp_misroute may not read stock: asked about only now, they must be refused it, not answered from the service account.
          for (const measure of ["stock_total", "visit_total"]) {
            const r = await chat("lp_misroute", A, "query", BREAKDOWN(measure));
            expect([measure, r.status, r.error]).toEqual([measure, 403, expect.stringMatching(/Superset access could not be checked/)]);
          }
          const d = (await s.lp_misroute.lp("GET", `api/${PACK}/${A}/data`)).json;
          expect([d.visits_by_region.rows, d.stock_by_region.rows]).toEqual([[], []]);
          expect((await catalogue("lp_misroute")).accessNotice).toMatch(/Superset access could not be checked/);
        } finally {
          stack.missingRoute(null);
        }
        expect(stack.log()).toMatch(/could not ask Superset about lp_misroute \(Superset answered 404 for \/api\/v1\/lenspack\/access/);
        // Back: the very next request asks the route again, and their own access applies, dataset permissions included.
        const stock = toolOutput(await chat("lp_misroute", A, "query", BREAKDOWN("stock_total")));
        expect([stock.ok, stock.error]).toEqual([false, expect.stringMatching(NO_ACCESS)]);
        expect(byGroup(toolOutput(await chat("lp_misroute", A, "query", BREAKDOWN("visit_total"))).rows)).toEqual(VISITS);
      });
    });

    describe("admin surfaces", () => {
      it("shows settings, the audit log and usage to Superset admins only; a dashboard owner is refused", async () => {
        // The default admins rule, ["Admin"]: a Superset role called "Lenspack admin" gives nothing until the rule names it.
        for (const path of ["_superset/settings", "_superset/audit?limit=5", "_superset/turns?limit=5", "api/_usage", "_superset/admin/"]) {
          expect([path, (await s.lp_admin.lp("GET", path)).status]).toEqual([path, 200]);
          for (const who of ["lp_owner", "lp_viewer", "lp_noroles", "lp_lensadmin"] as const) expect([who, path, (await s[who].lp("GET", path)).status]).toEqual([who, path, 403]);
        }
        expect((await s.lp_lensadmin.lp("GET", "_superset/settings")).json.error).toMatch(/only Superset admins/);
        expect((await s.lp_owner.lp("PUT", "_superset/settings/features", { boardEdits: false })).status).toBe(403);
        expect((await s.lp_admin.send("GET", "/ai-assistant/")).status).toBe(200);
        expect((await s.lp_owner.send("GET", "/ai-assistant/")).status).toBe(403);
      });
    });

    describe("caching", () => {
      it("gives two users with different RLS different, correct answers to the same question", async () => {
        for (let round = 0; round < 2; round++) {
          expect(byGroup(toolOutput(await chat("lp_viewer", A, "query", BREAKDOWN("visit_total"))).rows)).toEqual(VISITS);
          expect(byGroup(toolOutput(await chat("lp_north", A, "query", BREAKDOWN("visit_total"))).rows)).toEqual({ North: 3 });
          expect(byGroup((await s.lp_north.lp("GET", `api/${PACK}/${A}/data`)).json.visits_by_region.rows)).toEqual({ North: 3 });
          expect(byGroup((await s.lp_viewer.lp("GET", `api/${PACK}/${A}/data`)).json.visits_by_region.rows)).toEqual(VISITS);
        }
      });

      it("answer reuse never hands a saved answer to a user with different access, at tiers 1 to 3", async () => {
        // Saved answers are on by default. The small-model router (tier 4) is turned off so a miss is one full turn.
        const cache = (body: object) => s.lp_admin.lp("PUT", "_superset/settings/cache", body);
        expect((await cache({ router: "off", freshMinutes: 10 })).status).toBe(200);
        // Visits in one region, as each user may count them: lp_templ's rule leaves only their team's rows.
        const ask = (who: User, region: string) => chat(who, A, "query", { ...BREAKDOWN("visit_total"), filter_dimension: "region", filter_value: region });
        const NORTH: Partial<Record<User, Record<string, number>>> = { lp_viewer: { North: 3 }, lp_partial: { North: 3 }, lp_north: { North: 3 }, lp_inlist: { North: 3 }, lp_templ: { North: 1 } };
        const EAST: Partial<Record<User, Record<string, number>>> = { lp_viewer: { East: 8 }, lp_partial: { East: 8 }, lp_north: {}, lp_inlist: { East: 8 }, lp_templ: { East: 8 } };
        const who = Object.keys(NORTH) as User[];
        // Which saved entries served each user: no entry may serve two users whose access differs.
        const served = new Map<string, User>();
        const check = (u: User, r: ChatResult, want: Record<string, number>) => {
          expect([u, byGroup(toolOutput(r).rows)]).toEqual([u, want]);
          if (!r.reuse) return;
          const owner = served.get(r.reuse.entry) ?? u;
          expect([u, r.reuse.entry, owner]).toEqual([u, r.reuse.entry, u]);
          served.set(r.reuse.entry, u);
        };
        try {
          // First asks: lp_viewer's answer is saved first; nobody else is served from it.
          let before = stack.modelCalls();
          const first = await ask("lp_viewer", "North");
          expect(first.reuse).toBeUndefined();
          expect(stack.modelCalls()).toBeGreaterThan(before);
          check("lp_viewer", first, NORTH.lp_viewer!);
          for (const u of who.slice(1)) {
            const r = await ask(u, "North");
            expect([u, r.reuse]).toEqual([u, undefined]);
            check(u, r, NORTH[u]!);
          }

          // Tier 1: the same question again within minutes sends each user their own saved reply, with no model.
          before = stack.modelCalls();
          for (const u of who) {
            const r = await ask(u, "North");
            expect([u, r.reuse?.tier]).toEqual([u, "t1"]);
            check(u, r, NORTH[u]!);
          }
          expect(stack.modelCalls()).toBe(before);

          // Tier 2: with no fresh window, each saved plan runs again, under the asking user's own access.
          expect((await cache({ freshMinutes: 0 })).status).toBe(200);
          before = stack.modelCalls();
          for (const u of who) {
            const r = await ask(u, "North");
            expect([u, r.reuse?.tier]).toEqual([u, "t2"]);
            check(u, r, NORTH[u]!);
          }
          expect(stack.modelCalls()).toBe(before);

          // Tier 3: the same question about another region swaps the value into the user's own saved plan. Where the
          // user can't see that region, they get no rows, whether the slot or a full turn answers.
          // The rows differ from the saved ones, so the reply may take one small rewrite call; never a full turn.
          before = stack.modelCalls();
          const t3 = await ask("lp_viewer", "East");
          expect(t3.reuse?.tier).toBe("t3");
          expect(stack.modelCalls() - before).toBeLessThanOrEqual(1);
          check("lp_viewer", t3, EAST.lp_viewer!);
          for (const u of who.slice(1)) check(u, await ask(u, "East"), EAST[u]!);
          expect(new Set(served.values()).size).toBe(who.length);
        } finally {
          await cache({ router: null, freshMinutes: null });
        }
      });
    });

    describe("dashboard roles (DASHBOARD_RBAC)", () => {
      // Superset's rule: with DASHBOARD_RBAC on, a user who opens a dashboard through its dashboard roles may read the
      // data of the charts on it, without access to their datasets; RLS still applies. lp_rbac reads no dataset, opens
      // B (a stock chart; RLS North and South through B's role) and C (a visits chart), and not A.
      const B_STOCK = { North: 32, South: 64 };
      const dataOf = async (who: User, board: string) => (await s[who].lp("GET", `api/${PACK}/${board}/data`)).json as Record<string, { rows: { group: string; value: number }[]; error?: string }>;
      /** The rows of a chart as Superset itself serves them to a user on a dashboard (its chart data API, as the dashboard asks), or the status it refused with. */
      const supersetRows = async (who: User, dashboard: number, widget: string) => {
        const charts = (await s.lp_admin.send("GET", `/api/v1/dashboard/${dashboard}/charts`)).json.result as { id: number; slice_name: string }[];
        const board = `superset-${dashboard}`;
        const title = ((await s.lp_admin.lp("GET", `api/${PACK}/${board}`)).json.board.config.widgets[widget] as { title: string }).title;
        const chart = charts.find((c) => c.slice_name === title) ?? charts[0]!;
        const saved = (await s.lp_admin.send("GET", `/api/v1/chart/${chart.id}`)).json.result.query_context as string;
        const qc = JSON.parse(saved) as { form_data?: object; queries: { metrics?: unknown[] }[] };
        return chartRows(await s[who].send("POST", "/api/v1/chart/data", { body: { ...qc, form_data: { ...(qc.form_data ?? {}), dashboardId: dashboard, slice_id: chart.id } } }));
      };
      const chartRows = (r: { status: number; json: any }) => {
        if (r.status !== 200) return { refused: r.status };
        const rows = r.json.result[0].data as Record<string, unknown>[];
        return Object.fromEntries(rows.map((row) => [row.region, Object.entries(row).find(([k, v]) => k !== "region" && typeof v === "number")?.[1]]));
      };
      /** A request to Lenspack signed as Superset signs one for this dashboard, saying the user may view it. */
      const viewing = (u: User, dashboard: number, roles: string[]) => signed({ u, r: roles, d: dashboard, b: `superset-${dashboard}`, p: PACK, e: false, v: true });

      it("on B, a dashboard-role user with no dataset access reads B's chart data: the rows Superset's own chart shows them, RLS included", async () => {
        // Superset itself, as B asks for its chart.
        expect(await supersetRows("lp_rbac", stack.fixtures.dashboards.b, "stock_b")).toEqual(B_STOCK);
        // Lenspack: the chat, the board's own data and the filter menu on B.
        expect(byGroup(toolOutput(await chat("lp_rbac", B, "query", BREAKDOWN("stock_total"))).rows)).toEqual(B_STOCK);
        expect(byGroup((await dataOf("lp_rbac", B)).stock_b!.rows)).toEqual(B_STOCK);
        expect(sorted(((await s.lp_rbac.lp("GET", `api/${PACK}/${B}/options?field=region`)).json as { value: string }[]).map((v) => v.value))).toEqual(["North", "South"]);
        // Never more than RLS lets through, whatever the question asks.
        expect(byGroup(toolOutput(await chat("lp_rbac", B, "query", { ...BREAKDOWN("stock_total"), filters: "region = West" })).rows)).toEqual({});
        // B's catalogue shows the stock dataset only, and no notice.
        const onB = (await s.lp_rbac.lp("GET", `api/${PACK}/${B}`)).json;
        expect(sorted(onB.catalogue.measures.map((m: { key: string }) => m.key))).toEqual(["stock_count", "stock_total"]);
        expect(onB.accessNotice).toBeUndefined();
        // The same on C for the visits chart there (no RLS on visits for them).
        expect(await supersetRows("lp_rbac", stack.fixtures.dashboards.c, "visits_c")).toEqual(VISITS);
        expect(byGroup(toolOutput(await chat("lp_rbac", C, "query", BREAKDOWN("visit_total"))).rows)).toEqual(VISITS);
        expect(stack.log()).toMatch(/dashboard roles \(DASHBOARD_RBAC\) are on/);
      });

      it("is refused for the same dataset on another dashboard, for a dataset not behind the dashboard's charts, and outside any dashboard", async () => {
        // Superset refuses B's stock chart asked for as if drawn on C.
        const stockChart = (await s.lp_admin.send("GET", `/api/v1/dashboard/${stack.fixtures.dashboards.b}/charts`)).json.result[0].id as number;
        const qc = JSON.parse((await s.lp_admin.send("GET", `/api/v1/chart/${stockChart}`)).json.result.query_context);
        const onC = chartRows(await s.lp_rbac.send("POST", "/api/v1/chart/data", { body: { ...qc, form_data: { ...qc.form_data, dashboardId: stack.fixtures.dashboards.c, slice_id: stockChart } } }));
        expect(onC).toEqual({ refused: 403 });
        // Lenspack: stock on C, visits on B.
        for (const [board, measure] of [[C, "stock_total"], [B, "visit_total"]] as const) {
          const out = toolOutput(await chat("lp_rbac", board, "query", BREAKDOWN(measure)));
          expect([board, measure, out.ok, out.error]).toEqual([board, measure, false, expect.stringMatching(NO_ACCESS)]);
        }
        expect((await s.lp_rbac.lp("GET", `api/${PACK}/${C}`)).json.catalogue.measures.map((m: { key: string }) => m.key).sort()).toEqual(["visit_count", "visit_total"]);
        // Outside a dashboard: the catalogue and a compiled query read nothing.
        expect((await s.lp_rbac.lp("GET", `api/${PACK}`)).json.catalogue.measures).toEqual([]);
        expect((await s.lp_rbac.lp("GET", `api/${PACK}/explain?${explainQuery("stock_total")}`)).json).toMatchObject({ ok: false, code: "ACCESS_HIDDEN" });
        // A dashboard they may not open stays shut.
        expect((await s.lp_rbac.lp("GET", `api/${PACK}/${A}/data`)).status).toBe(403);
      });

      it("never serves a saved answer made under a dashboard role on another board, or to another user", async () => {
        const cache = (body: object) => s.lp_admin.lp("PUT", "_superset/settings/cache", body);
        expect((await cache({ router: "off", freshMinutes: 10 })).status).toBe(200);
        try {
          // Stock rows by region: one per region, so each count says which regions were read.
          const ask = (who: User, board: string) => chat(who, board, "query", BREAKDOWN("stock_count"));
          const ALL = { North: 1, South: 1, East: 1, West: 1 };
          const first = await ask("lp_rbac", B);
          expect(byGroup(toolOutput(first).rows)).toEqual({ North: 1, South: 1 });
          const again = await ask("lp_rbac", B);
          expect(again.reuse?.tier).toBe("t1");
          expect(byGroup(toolOutput(again).rows)).toEqual({ North: 1, South: 1 });
          const entry = again.reuse!.entry;
          // An admin on B asks the same: their own answer (all regions), never lp_rbac's.
          const admin = await ask("lp_admin", B);
          expect(admin.reuse?.entry).not.toBe(entry);
          expect(byGroup(toolOutput(admin).rows)).toEqual(ALL);
          // lp_rbac on C: refused, not served from B.
          const onC = await ask("lp_rbac", C);
          expect(onC.reuse?.entry).not.toBe(entry);
          expect(toolOutput(onC).error).toMatch(NO_ACCESS);
          // A user with full access on A: their own answer.
          const viewer = await ask("lp_viewer", A);
          expect(viewer.reuse?.entry).not.toBe(entry);
          expect(byGroup(toolOutput(viewer).rows)).toEqual(ALL);
          // And lp_rbac on B again: still their own.
          expect((await ask("lp_rbac", B)).reuse?.entry).toBe(entry);
        } finally {
          await cache({ router: null, freshMinutes: null });
        }
      });

      it("is refused when DASHBOARD_RBAC is off, even on a request signed as able to view the dashboard", async () => {
        // lp_rbac_off has lp_rbac's roles and has not been asked about before, so Lenspack asks Superset afresh.
        stack.dashboardRbac(false);
        try {
          const roles = ["Gamma", "lp_board_b", "lp_board_c"];
          // Superset: B no longer opens for them, and its chart's data is refused.
          expect((await s.lp_rbac_off.lp("GET", `api/${PACK}/${B}`)).status).toBe(403);
          expect(await supersetRows("lp_rbac_off", stack.fixtures.dashboards.b, "stock_b")).toEqual({ refused: 403 });
          // Lenspack, even when told the user may view B: nothing of B's data.
          const forB = viewing("lp_rbac_off", stack.fixtures.dashboards.b, roles);
          const d = (await direct("GET", `/api/${PACK}/${B}/data`, forB)).json;
          expect([d.stock_b.rows, d.stock_b.error]).toEqual([[], expect.stringMatching(/is not available to you/)]);
          const r = readChat(await direct("POST", `/api/${PACK}/${B}/chat?review=off`, forB, { messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: `TOOL query ${JSON.stringify(BREAKDOWN("stock_total"))}` }] }] }));
          expect([r.status, r.error]).toEqual([403, expect.stringMatching(NO_ACCESS)]);
          expect(stack.log()).toMatch(/dashboard roles \(DASHBOARD_RBAC\) are off/);
        } finally {
          stack.dashboardRbac(true);
        }
      });

      it("a personal copy of B does not carry B's dashboard-role access: stock is refused on it", async () => {
        const made = await s.lp_rbac.lp("POST", `_superset/my/dashboards?dashboard=${stack.fixtures.dashboards.b}`, { copy: true });
        expect(made.status, made.text).toBe(200);
        const copy = made.json.dashboard as number;
        const board = `superset-${copy}`;
        try {
          // A private draft of theirs: no dashboard roles, not published.
          const meta = (await s.lp_admin.send("GET", `/api/v1/dashboard/${copy}`)).json.result;
          expect([meta.roles, meta.published]).toEqual([[], false]);
          // It is theirs, but nothing on it reads stock for them, in Superset or in Lenspack.
          expect(await mine("lp_rbac")).toContain(copy);
          // Superset refuses the copy's stock chart to them, as the copy asks for it.
          const copyChart = (await s.lp_admin.send("GET", `/api/v1/dashboard/${copy}/charts`)).json.result[0].id as number;
          const bChart = (await s.lp_admin.send("GET", `/api/v1/dashboard/${stack.fixtures.dashboards.b}/charts`)).json.result[0].id as number;
          const savedQc = async (chart: number) => (await s.lp_admin.send("GET", `/api/v1/chart/${chart}`)).json.result.query_context as string | null;
          const qc = JSON.parse((await savedQc(copyChart)) ?? (await savedQc(bChart))!);
          expect(chartRows(await s.lp_rbac.send("POST", "/api/v1/chart/data", { body: { ...qc, form_data: { ...qc.form_data, dashboardId: copy, slice_id: copyChart } } }))).toEqual({ refused: 403 });
          // Opened, it shows no stock (or, with nothing at all to show, it is refused up front); asked, stock is refused.
          const opened = await s.lp_rbac.lp("GET", `api/${PACK}/${board}`);
          if (opened.status === 200) expect(opened.json.catalogue.measures.map((m: { key: string }) => m.key)).not.toContain("stock_total");
          else expect([opened.status, opened.json.error]).toEqual([403, expect.stringMatching(NO_ACCESS)]);
          const asked = await chat("lp_rbac", board, "query", BREAKDOWN("stock_total"));
          expect(asked.status === 200 ? toolOutput(asked).error : asked.error).toMatch(NO_ACCESS);
          // B itself still reads for them.
          expect(byGroup(toolOutput(await chat("lp_rbac", B, "query", BREAKDOWN("stock_total"))).rows)).toEqual(B_STOCK);
        } finally {
          expect((await s.lp_rbac.lp("POST", "_superset/my/dashboards/delete", { dashboard: copy })).status).toBe(200);
        }
      });
    });

    describe("personal dashboards and saved configurations", () => {
      const NOT_OWN = /only dashboards of your own/;
      const NOBODY = /only dashboards of one.s own, and those are turned off/;
      const make = async (who: User, title: string) => {
        const r = await s[who].lp("POST", "_superset/my/dashboards", { title });
        expect(r.status, r.text).toBe(200);
        return r.json.dashboard as number;
      };
      const copyOf = async (who: User, dashboard: number) => s[who].lp("POST", `_superset/my/dashboards?dashboard=${dashboard}`, { copy: true });
      const rename = (title: string) => ({ ops: [{ op: "set_title", title }] });
      /** lp_viewer's copy of A, made in the first case and used by the rest. */
      let viewerCopy = 0;

      it("a viewer may create a personal dashboard (and copy one they can open)", async () => {
        const blank = await make("lp_viewer", "Viewer blank");
        const me = (await s.lp_viewer.send("GET", "/api/v1/me/")).json.result.id as number;
        const meta = (await s.lp_admin.send("GET", `/api/v1/dashboard/${blank}`)).json.result;
        expect([meta.owners.map((o: { id: number }) => o.id), meta.published, meta.roles]).toEqual([[me], false, []]);
        // A layout Superset can draw from the start (ROOT → GRID): the first change finds nothing to repair.
        const startLayout = JSON.parse(meta.position_json);
        expect([startLayout.ROOT_ID?.children, startLayout.GRID_ID?.parents]).toEqual([["GRID_ID"], ["ROOT_ID"]]);
        const first = await s.lp_viewer.lp("POST", `api/${PACK}/superset-${blank}/ops`, widgetOps([["visits_blank", "Visits by region", "visit_total"]]));
        expect(first.status, first.text).toBe(200);
        expect(stack.log()).not.toMatch(new RegExp(`superset-${blank}: layout already had a problem`));
        const copied = await copyOf("lp_viewer", stack.fixtures.dashboards.a);
        expect(copied.status, copied.text).toBe(200);
        viewerCopy = copied.json.dashboard;
        expect(copied.json.from).toBe(stack.fixtures.dashboards.a);
        expect(sorted((await mine("lp_viewer")).map(String))).toEqual(sorted([String(blank), String(viewerCopy)]));
        // The copy is theirs: it opens, with A's charts, and they may change it (A they may only view).
        const onCopy = (await s.lp_viewer.lp("GET", `api/${PACK}/superset-${viewerCopy}`)).json;
        expect(Object.keys(onCopy.board.config.widgets)).toHaveLength(Object.keys((await s.lp_admin.lp("GET", `api/${PACK}/${A}`)).json.board.config.widgets).length);
        const r = await s.lp_viewer.lp("POST", `api/${PACK}/superset-${viewerCopy}/ops`, rename("Viewer copy"));
        expect(r.status, r.text).toBe(200);
        expect(await dashboardTitle(viewerCopy)).toBe("Viewer copy");
        // B they can't open, so they can't copy it.
        expect((await copyOf("lp_viewer", stack.fixtures.dashboards.b)).status).toBe(403);
        expect((await s.lp_viewer.lp("POST", "_superset/my/dashboards/delete", { dashboard: blank })).status).toBe(200);
      });

      it("a user may delete only their own personal dashboard", async () => {
        const one = await make("lp_viewer", "Viewer one");
        const two = await make("lp_viewer", "Viewer two");
        // Not someone else's, even for a user who may edit shared dashboards.
        const refused = await s.lp_owner.lp("POST", "_superset/my/dashboards/delete", { dashboard: one });
        expect([refused.status, refused.json.code]).toEqual([403, "not-yours"]);
        // Nor a shared dashboard they don't own in Superset (A is lp_owner's).
        expect((await s.lp_viewer.lp("POST", "_superset/my/dashboards/delete", { dashboard: stack.fixtures.dashboards.a })).status).toBe(403);
        expect((await s.lp_admin.send("GET", `/api/v1/dashboard/${stack.fixtures.dashboards.a}`)).status).toBe(200);
        expect((await s.lp_admin.send("GET", `/api/v1/dashboard/${one}`)).status).toBe(200);
        // An admin deletes only personal dashboards: A was not made through Lenspack, so it is its owner's to delete, in Superset.
        const notPersonal = await s.lp_admin.lp("POST", "_superset/my/dashboards/delete", { dashboard: stack.fixtures.dashboards.a });
        expect([notPersonal.status, notPersonal.json.code]).toEqual([403, "not-yours"]);
        expect((await s.lp_admin.send("GET", `/api/v1/dashboard/${stack.fixtures.dashboards.a}`)).status).toBe(200);
        // Their owner may; so may an admin.
        expect((await s.lp_viewer.lp("POST", "_superset/my/dashboards/delete", { dashboard: one })).status).toBe(200);
        expect((await s.lp_admin.lp("POST", "_superset/my/dashboards/delete", { dashboard: two })).status).toBe(200);
        for (const d of [one, two]) expect((await s.lp_admin.send("GET", `/api/v1/dashboard/${d}`)).status).toBe(404);
        expect(await mine("lp_viewer")).toEqual([viewerCopy]);
      });

      it("a saved configuration applies only to dashboards the user controls", async () => {
        const saved = await s.lp_viewer.lp("POST", `_superset/my/layouts?dashboard=${stack.fixtures.dashboards.a}`, { name: "Viewer layout" });
        expect(saved.status, saved.text).toBe(200);
        const layout = saved.json.id as string;
        const apply = (who: User, dashboard: number) => s[who].lp("POST", `_superset/my/layouts/${layout}/apply?dashboard=${dashboard}`, {});
        try {
          // Not on A, which they may only view.
          const onA = await apply("lp_viewer", stack.fixtures.dashboards.a);
          expect([onA.status, onA.json.code]).toEqual([403, "no-edit"]);
          // On their own copy, yes.
          const onCopy = await apply("lp_viewer", viewerCopy);
          expect(onCopy.status, onCopy.text).toBe(200);
          // Another user can't use it at all, even where they may edit.
          expect((await apply("lp_owner", stack.fixtures.dashboards.a)).status).toBe(404);
        } finally {
          expect((await s.lp_viewer.lp("POST", `_superset/my/layouts/${layout}/delete`, {})).status).toBe(200);
        }
      });

      it("another user's personal dashboard is neither listed nor opened nor edited", async () => {
        const board = `superset-${viewerCopy}`;
        expect(await mine("lp_owner")).not.toContain(viewerCopy);
        expect(((await s.lp_owner.lp("GET", `api/${PACK}`)).json.boards as { id: string }[]).map((b) => b.id)).not.toContain(board);
        expect(((await s.lp_owner.lp("GET", "_superset/dashboards")).json as { id: number }[]).map((d) => d.id)).not.toContain(viewerCopy);
        // Not found, as for any board they may not open (its existence isn't confirmed).
        expect((await s.lp_owner.lp("GET", `api/${PACK}/${board}`)).status).toBe(404);
        expect([403, 404]).toContain((await s.lp_owner.lp("POST", `api/${PACK}/${board}/ops`, rename("Not yours"))).status);
        // Superset lets anyone open a draft with no roles by its address; Lenspack keeps it to its owner, so it isn't copied either.
        expect((await copyOf("lp_owner", viewerCopy)).status).toBe(403);
        expect(await dashboardTitle(viewerCopy)).toBe("Viewer copy");
        // Everyone's list is the admins' only.
        expect((await s.lp_owner.lp("GET", "_superset/personal")).status).toBe(403);
        const all = (await s.lp_admin.lp("GET", "_superset/personal")).json;
        expect(JSON.stringify(all)).toContain(String(viewerCopy));
      });

      it("with editScope own, the chat changes only people's own dashboards; admins are exempt unless told otherwise", async () => {
        const scope = (body: object) => s.lp_admin.lp("PUT", "_superset/settings/edit-scope", body);
        // A user who isn't an admin may not change it.
        expect((await s.lp_owner.lp("PUT", "_superset/settings/edit-scope", { scope: "own" })).status).toBe(403);
        expect((await scope({ scope: "own" })).status).toBe(200);
        const copied = await copyOf("lp_owner", stack.fixtures.dashboards.a);
        expect(copied.status, copied.text).toBe(200);
        const ownerCopy = `superset-${copied.json.dashboard}`;
        try {
          // lp_owner owns A in Superset, yet the chat and the board API leave it alone, and the chat offers a copy.
          const r = await s.lp_owner.lp("POST", `api/${PACK}/${A}/ops`, rename("Access A (owner, own scope)"));
          expect([r.status, r.json.error]).toEqual([403, expect.stringMatching(NOT_OWN)]);
          const out = JSON.stringify(toolOutput(await chat("lp_owner", A, "rename_board", { title: "own scope chat" })));
          expect(out).toMatch(NOT_OWN);
          expect(out).toMatch(/copy/i);
          expect(await dashboardTitle(stack.fixtures.dashboards.a)).toBe("Access A");
          // Their own copy they may change, through both.
          expect((await s.lp_owner.lp("POST", `api/${PACK}/${ownerCopy}/ops`, rename("Owner copy"))).status).toBe(200);
          expect(toolOutput(await chat("lp_owner", ownerCopy, "rename_board", { title: "Owner copy (chat)" }))).toMatchObject({ applied: true });
          // An admin is exempt, and not once adminsExempt is false (from the next request, no restart).
          expect((await s.lp_admin.lp("POST", `api/${PACK}/${A}/ops`, rename("Access A"))).status).toBe(200);
          expect((await scope({ adminsExempt: false })).status).toBe(200);
          const admin = await s.lp_admin.lp("POST", `api/${PACK}/${A}/ops`, rename("Access A (admin, not exempt)"));
          expect([admin.status, admin.json.error]).toEqual([403, expect.stringMatching(NOT_OWN)]);
          expect(await dashboardTitle(stack.fixtures.dashboards.a)).toBe("Access A");
          // With personal dashboards off, nobody edits (not even on their own copy), and admins are warned.
          expect((await scope({ adminsExempt: null })).status).toBe(200);
          expect((await s.lp_admin.lp("PUT", "_superset/settings/features", { personalDashboards: false })).status).toBe(200);
          try {
            expect((await s.lp_admin.lp("GET", "_superset/settings")).json.editScope.warning).toMatch(/nobody but admins/);
            const off = await s.lp_owner.lp("POST", `api/${PACK}/${ownerCopy}/ops`, rename("Owner copy (off)"));
            expect([off.status, off.json.error]).toEqual([403, expect.stringMatching(NOBODY)]);
          } finally {
            expect((await s.lp_admin.lp("PUT", "_superset/settings/features", { personalDashboards: null })).status).toBe(200);
          }
        } finally {
          expect((await scope({ scope: null, adminsExempt: null })).status).toBe(200);
          await s.lp_owner.lp("POST", "_superset/my/dashboards/delete", { dashboard: copied.json.dashboard });
        }
        // Back to the default: lp_owner edits A again.
        expect((await s.lp_owner.lp("POST", `api/${PACK}/${A}/ops`, rename("Access A"))).status).toBe(200);
      });

      it("undo after applying a layout takes back a chart of Superset's own that came back, in Superset too", async () => {
        const copied = await copyOf("lp_viewer", stack.fixtures.dashboards.a);
        expect(copied.status, copied.text).toBe(200);
        const copy = copied.json.dashboard as number;
        const board = `superset-${copy}`;
        const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const charts = async () => ((await s.lp_admin.send("GET", `/api/v1/dashboard/${copy}/charts`)).json.result as { id: number }[]).map((c) => c.id).sort((x, y) => x - y);
        const layout = async () => JSON.parse((await s.lp_admin.send("GET", `/api/v1/dashboard/${copy}`)).json.result.position_json) as Record<string, any>;
        // Superset's own API, as its admin, with the CSRF token its pages send.
        const csrf = (await s.lp_admin.send("GET", "/api/v1/security/csrf_token/")).json.result as string;
        const write = (method: string, path: string, body: object) => s.lp_admin.send(method, path, { headers: { "x-csrftoken": csrf }, body });
        const putLayout = (pos: Record<string, any>) => write("PUT", `/api/v1/dashboard/${copy}`, { position_json: JSON.stringify(pos), json_metadata: JSON.stringify({ positions: pos }) });
        const drawn = (pos: Record<string, any>) => Object.values(pos).filter((c: any) => c?.type === "CHART" || c?.type === "MARKDOWN").map((c: any) => c.meta?.chartId ?? c.id);
        try {
          // A chart made in Superset that Lenspack can't redraw (kept as Superset's), added to the copy in Superset.
          const made = await write("POST", "/api/v1/chart/", { slice_name: "Word cloud", viz_type: "word_cloud", datasource_id: stack.fixtures.datasets.visits, datasource_type: "table", params: JSON.stringify({ viz_type: "word_cloud", series: "region", metric: "count" }), dashboards: [copy] });
          expect(made.status, made.text).toBe(201);
          const cloud = made.json.id as number;
          const pos = await layout();
          const row = Object.values(pos).find((c: any) => c?.type === "ROW") as any;
          pos[`CHART-cloud`] = { id: "CHART-cloud", type: "CHART", children: [], parents: [...row.parents, row.id], meta: { chartId: cloud, width: 4, height: 50 } };
          row.children.push("CHART-cloud");
          expect((await putLayout(pos)).status).toBe(200);
          await wait(3500);
          const before = (await s.lp_viewer.lp("GET", `api/${PACK}/${board}`)).json.board;
          expect(Object.keys(before.config.widgets)).toHaveLength(3);
          expect((await s.lp_viewer.lp("POST", `_superset/my/layouts?dashboard=${copy}`, { name: "With cloud" })).status).toBe(200);
          const withCloud = await charts();
          expect(withCloud).toContain(cloud);
          // Removed in Superset itself.
          const out = await layout();
          delete out["CHART-cloud"];
          for (const c of Object.values(out) as any[]) if (Array.isArray(c?.children)) c.children = c.children.filter((k: string) => k !== "CHART-cloud");
          expect((await putLayout(out)).status).toBe(200);
          const removed = await charts();
          expect(removed).not.toContain(cloud);
          const shown = drawn(await layout()).sort();
          // Applied straight away, then undone.
          const layouts = (await s.lp_viewer.lp("GET", "_superset/my")).json.layouts as { id: string; name: string }[];
          const id = layouts.find((l) => l.name === "With cloud")!.id;
          const applied = await s.lp_viewer.lp("POST", `_superset/my/layouts/${id}/apply?dashboard=${copy}`, {});
          expect(applied.status, applied.text).toBe(200);
          const undo = await s.lp_viewer.lp("POST", `api/${PACK}/${board}/revert`, { version: applied.json.previous });
          expect(undo.status, undo.text).toBe(200);
          // Whatever the layout brought back is gone again, from the layout and from the dashboard's charts.
          expect(await charts()).toEqual(removed);
          expect(drawn(await layout()).sort()).toEqual(shown);
          await s.lp_viewer.lp("POST", `_superset/my/layouts/${id}/delete`, {});
        } finally {
          await s.lp_viewer.lp("POST", "_superset/my/dashboards/delete", { dashboard: copy });
        }
      });

      it("needs Superset's right to write dashboards: a viewer role makes, copies and applies nothing; Alpha may", async () => {
        const NO_WRITE = /view dashboards but not make or change them/;
        const A_ID = stack.fixtures.dashboards.a;
        // A role without can_write on Dashboard: the menu offers nothing to make, and every route says why.
        const view = (await s.lp_reader.lp("GET", `_superset/my?dashboard=${A_ID}`)).json;
        expect(view).toMatchObject({ canWrite: false, canCreate: false, here: { canCopy: false, edit: false } });
        const made = await s.lp_reader.lp("POST", "_superset/my/dashboards", { title: "Reader's" });
        expect([made.status, made.json.code, made.json.error]).toEqual([403, "no-write", expect.stringMatching(NO_WRITE)]);
        const copied = await copyOf("lp_reader", A_ID);
        expect([copied.status, copied.json.code]).toEqual([403, "no-write"]);
        expect(JSON.stringify(toolOutput(await chat("lp_reader", A, "create_dashboard", { title: "Reader's (chat)" })))).toMatch(NO_WRITE);
        // A saved layout writes nothing to Superset, so it may save one, but not apply it.
        const saved = await s.lp_reader.lp("POST", `_superset/my/layouts?dashboard=${A_ID}`, { name: "Reader view" });
        expect(saved.status, saved.text).toBe(200);
        const applied = await s.lp_reader.lp("POST", `_superset/my/layouts/${saved.json.id}/apply?dashboard=${A_ID}`, {});
        expect([applied.status, applied.json.code]).toEqual([403, "no-write"]);
        await s.lp_reader.lp("POST", `_superset/my/layouts/${saved.json.id}/delete`, {});
        expect(await mine("lp_reader")).toEqual([]);
        // Alpha writes dashboards in Superset: it makes, copies and deletes its own.
        expect((await s.lp_alpha.lp("GET", `_superset/my?dashboard=${A_ID}`)).json).toMatchObject({ canWrite: true, canCreate: true, here: { canCopy: true } });
        const blank = await make("lp_alpha", "Alpha blank");
        const copy = await copyOf("lp_alpha", A_ID);
        expect(copy.status, copy.text).toBe(200);
        expect(sorted((await mine("lp_alpha")).map(String))).toEqual(sorted([blank, copy.json.dashboard].map(String)));
        for (const d of [blank, copy.json.dashboard]) expect((await s.lp_alpha.lp("POST", "_superset/my/dashboards/delete", { dashboard: d })).status).toBe(200);
        expect(await mine("lp_alpha")).toEqual([]);
      });

      it("leaves no personal dashboards behind", async () => {
        expect((await s.lp_viewer.lp("POST", "_superset/my/dashboards/delete", { dashboard: viewerCopy })).status).toBe(200);
        expect(await mine("lp_viewer")).toEqual([]);
      });
    });

    // Last, as it restarts Lenspack: the deployment names its own admin role (auth.admins in superset.yaml).
    describe("Lenspack's own admins rule (auth.admins: [\"Lenspack admin\"])", () => {
      const ADMIN_GETS = ["_superset/settings", "_superset/audit?limit=5", "_superset/turns?limit=5", "api/_usage", "_superset/admin/", "_superset/admin/api/packs", "_superset/telemetry/superset-actions", "_superset/personal"];
      const catalogue = async (who: User) => sorted(((await s[who].lp("GET", `api/${PACK}`)).json.catalogue.measures as { key: string }[]).map((m) => m.key));

      beforeAll(async () => {
        await stack.restartLenspack(['auth: { admins: ["Lenspack admin"] }']);
        expect(stack.log()).toMatch(/admins: Superset role Lenspack admin/);
      }, 300_000);

      it("refuses a Superset Admin without the role the panel, the settings, the audit log and every admin route", async () => {
        for (const path of ADMIN_GETS) expect([path, (await s.lp_admin.lp("GET", path)).status]).toEqual([path, 403]);
        const refused = await s.lp_admin.lp("GET", "_superset/settings");
        expect(refused.json.error).toMatch(/only assistant admins/);
        for (const [path, body] of [["_superset/settings/features", { boardEdits: false }], ["_superset/settings/edit-scope", { scope: "own" }], ["_superset/settings/personal", { maxDashboardsPerUser: 1 }]] as const)
          expect([path, (await s.lp_admin.lp("PUT", path, body)).status]).toEqual([path, 403]);
        // Superset's own Settings → AI assistant page follows Lenspack's answer.
        expect((await s.lp_admin.send("GET", "/ai-assistant/")).status).toBe(403);
        // Still a Superset Admin everywhere else: their dashboards and data are Superset's to give, and unchanged.
        expect(await catalogue("lp_admin")).toEqual(ALL_MEASURES);
        expect(byGroup(toolOutput(await chat("lp_admin", B, "query", BREAKDOWN("stock_total"))).rows)).toEqual(STOCK);
      });

      it("gives a Gamma user with the role the panel and the admin routes", async () => {
        for (const path of ADMIN_GETS) expect([path, (await s.lp_lensadmin.lp("GET", path)).status]).toEqual([path, 200]);
        const page = await s.lp_lensadmin.lp("GET", "_superset/admin/");
        expect(page.headers["content-type"]).toMatch(/text\/html/);
        expect((await s.lp_lensadmin.lp("PUT", "_superset/settings/edit-scope", { scope: "own" })).status).toBe(200);
        expect((await s.lp_lensadmin.lp("GET", "_superset/settings")).json.editScope.scope).toBe("own");
        expect((await s.lp_lensadmin.lp("PUT", "_superset/settings/edit-scope", { scope: null })).status).toBe(200);
        // Superset's own settings page lists Superset's databases: it stays a Superset Admin's page.
        expect((await s.lp_lensadmin.send("GET", "/ai-assistant/")).status).toBe(403);
      });

      it("but only their own data access: the admin role widens no dataset, row, dashboard or edit right", async () => {
        // The same as lp_partial (Gamma + visits, no admin role) in every answer.
        expect(await catalogue("lp_lensadmin")).toEqual(await catalogue("lp_partial"));
        expect(await catalogue("lp_lensadmin")).toEqual(["visit_count", "visit_total"]);
        const stock = toolOutput(await chat("lp_lensadmin", A, "query", BREAKDOWN("stock_total")));
        expect([stock.ok, stock.error]).toEqual([false, expect.stringMatching(NO_ACCESS)]);
        expect(byGroup(toolOutput(await chat("lp_lensadmin", A, "query", BREAKDOWN("visit_total"))).rows)).toEqual(VISITS);
        const boards = async (who: User) => sorted(((await s[who].lp("GET", `api/${PACK}`)).json.boards as { id: string }[]).map((b) => b.id));
        expect(await boards("lp_lensadmin")).toEqual(await boards("lp_partial"));
        expect((await s.lp_lensadmin.lp("GET", `api/${PACK}/${B}`)).status).toBe(403);
        // Not an owner of A: they ask, they don't edit.
        const edit = await s.lp_lensadmin.lp("POST", `api/${PACK}/${A}/ops`, { ops: [{ op: "set_title", title: "Not theirs" }] });
        expect([edit.status, edit.json.error]).toEqual([403, expect.stringMatching(READ_ONLY)]);
        expect(await dashboardTitle(stack.fixtures.dashboards.a)).toBe("Access A");
        // Nor delete a dashboard that isn't a personal one.
        expect((await s.lp_lensadmin.lp("POST", "_superset/my/dashboards/delete", { dashboard: stack.fixtures.dashboards.a })).status).toBe(403);
        expect((await s.lp_admin.send("GET", `/api/v1/dashboard/${stack.fixtures.dashboards.a}`)).status).toBe(200);
      });
    });

    // Last, as it restarts Lenspack again: the assistant switched on per person (auth.users in superset.yaml).
    describe("Lenspack switched on per person (auth.users: [\"Lenspack user\"])", () => {
      const NOT_ON = /isn't turned on for your account/;
      /** The overlay script every Superset page loads through /lenspack: the real one draws the button. */
      const overlay = async (who: User) => (await s[who].lp("GET", "overlay.js")).text;
      let real = "";

      beforeAll(async () => {
        real = await overlay("lp_viewer");
        expect(real.length).toBeGreaterThan(1000);
        await stack.restartLenspack(['auth: { users: ["Lenspack user"] }']);
        expect(stack.log()).toMatch(/users: Superset role Lenspack user and admins/);
      }, 300_000);

      it("gives a user without the role no button and no chat, and refuses the chat and data routes plainly", async () => {
        const script = await overlay("lp_viewer");
        expect(script).not.toBe(real);
        expect(script.length).toBeLessThan(200);
        const r = await s.lp_viewer.lp("POST", `api/${PACK}/${A}/chat?review=off`, { messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: `TOOL query ${JSON.stringify(BREAKDOWN("visit_total"))}` }] }] });
        expect([r.status, r.json.code, r.json.error]).toEqual([403, "not-turned-on", expect.stringMatching(NOT_ON)]);
        for (const path of [`api/${PACK}`, `api/${PACK}/${A}`, `api/${PACK}/${A}/data`, `api/${PACK}/${A}/options?field=region`, "_superset/my", "_superset/dashboards", `_superset/bind?dashboard=${stack.fixtures.dashboards.a}`]) {
          const refused = await s.lp_viewer.lp("GET", path);
          expect([path, refused.status, refused.json?.code]).toEqual([path, 403, "not-turned-on"]);
        }
      });

      it("works as before for a user with the role", async () => {
        expect(await overlay("lp_lensuser")).toBe(real);
        expect((await s.lp_lensuser.lp("GET", `api/${PACK}/${A}`)).status).toBe(200);
        expect(byGroup(toolOutput(await chat("lp_lensuser", A, "query", BREAKDOWN("visit_total"))).rows)).toEqual(VISITS);
        // Still only what Superset lets them do: a viewer of A, not an editor.
        expect((await s.lp_lensuser.lp("POST", `api/${PACK}/${A}/ops`, { ops: [{ op: "set_title", title: "Not theirs" }] })).status).toBe(403);
      });

      it("lets an admin without the role in, chat and admin pages alike", async () => {
        expect(await overlay("lp_admin")).toBe(real);
        expect(byGroup(toolOutput(await chat("lp_admin", B, "query", BREAKDOWN("stock_total"))).rows)).toEqual(STOCK);
        expect((await s.lp_admin.lp("GET", "_superset/settings")).status).toBe(200);
      });
    });

    // Last, as it restarts Lenspack once more: a deployment set up in superset.yaml alone, with no change to Superset's
    // datasets: measures from columns, columns left out, and every answer pinned (here, to every region but South).
    describe("set up in superset.yaml alone (overlay measures, exclusions, a pinned scope)", () => {
      const PINNED = { North: 3, East: 8, West: 16 };
      beforeAll(async () => {
        await stack.restartLenspack([
          "scope: [{ dimension: region, op: in, value: [North, East, West] }]",
          `overlay: { pack: ${PACK}, exclude: { columns: [team, district] }, notDimensions: [visits, qty], measures: [{ dataset: visits, name: visits_summed, agg: sum, column: visits, label: { en: Visits added up, fr: Visites additionnées } }, { dataset: visits, name: north_rows, agg: count, where: [{ column: region, op: eq, value: North }] }] }`,
        ]);
        expect(stack.log()).toMatch(/pack scope: region in \["North","East","West"\]/);
      }, 300_000);

      it("leaves the excluded and non-dimension columns out of what each person is shown", async () => {
        const got = (await s.lp_viewer.lp("GET", `api/${PACK}/${A}`)).json.catalogue;
        const dims = got.dimensions.map((d: { key: string }) => d.key).sort();
        expect(dims).toEqual(["item", "region"]);
        expect(got.measures.map((m: { key: string }) => m.key)).toEqual(expect.arrayContaining(["visits_summed", "north_rows", "visit_total"]));
        expect(JSON.stringify(got)).not.toMatch(/"team"|"district"/);
        const rows = toolOutput(await chat("lp_viewer", A, "query", { query_kind: "rows", entity: "visits", dimension: "region,team" }));
        expect(rows.ok).toBe(false);
      });

      it("computes an overlay measure in Superset, under the pinned scope, the same as the saved metric", async () => {
        expect(byGroup(toolOutput(await chat("lp_viewer", A, "query", BREAKDOWN("visits_summed"))).rows)).toEqual(PINNED);
        expect(byGroup(toolOutput(await chat("lp_viewer", A, "query", BREAKDOWN("visit_total"))).rows)).toEqual(PINNED);
        const north = toolOutput(await chat("lp_viewer", A, "query", { query_kind: "value", measure: "north_rows" }));
        expect(north.rows[0].value).toBe(2);
      });

      it("applies each person's row-level security to an overlay measure", async () => {
        expect(byGroup(toolOutput(await chat("lp_north", A, "query", BREAKDOWN("visits_summed"))).rows)).toEqual({ North: 3 });
        expect(byGroup(toolOutput(await chat("lp_inlist", A, "query", BREAKDOWN("visits_summed"))).rows)).toEqual({ North: 3, East: 8 });
        expect(toolOutput(await chat("lp_north", A, "query", { query_kind: "value", measure: "north_rows" })).rows[0].value).toBe(2);
        // The templated rule filters on team, which the pack now leaves out: Lenspack can't apply it, so visits is kept from them.
        const templ = toolOutput(await chat("lp_templ", A, "query", BREAKDOWN("visits_summed")));
        expect([templ.ok, templ.error]).toEqual([false, expect.stringMatching(NO_ACCESS)]);
      });

      it("can't be widened by a filter: asking for the pinned-out region gets nothing, on every path", async () => {
        const south = toolOutput(await chat("lp_viewer", A, "query", { ...BREAKDOWN("visits_summed"), filters: "region = South" }));
        expect(byGroup(south.rows)).toEqual({});
        expect(byGroup((await s.lp_viewer.lp("GET", `api/${PACK}/${A}/data`)).json.visits_by_region.rows)).toEqual(PINNED);
        expect(sorted(((await s.lp_viewer.lp("GET", `api/${PACK}/${A}/options?field=region`)).json as { value: string }[]).map((v) => v.value))).toEqual(["East", "North", "West"]);
        const explained = await s.lp_viewer.lp("GET", `api/${PACK}/explain?${explainQuery("visits_summed")}`);
        expect(explained.json.ok).toBe(true);
        expect(JSON.parse(explained.json.native).queries[0].filters).toContainEqual({ col: "region", op: "IN", val: ["North", "East", "West"] });
      });

      it("saves a chart of an overlay measure in Superset and reads it back as that measure", async () => {
        const r = await s.lp_admin.lp("POST", `api/${PACK}/${A}/ops`, widgetOps([["summed_c", "Visits added up", "visits_summed"]]));
        expect(r.status, r.text).toBe(200);
        const listed = await s.lp_admin.lp("GET", `api/${PACK}/${A}?include=data`);
        expect(listed.json.board.config.widgets.summed_c.query.measure).toBe("visits_summed");
        expect(byGroup(listed.json.data.summed_c.rows)).toEqual(PINNED);
        expect(listed.json.board.config.widgets.summed_c.kind).toBe("chart");
      });
    });
  });
}
