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
import { type ChatResult, PACK, type Session, type Stack, http, readChat, startStack } from "./stack";

const VISITS = { North: 3, South: 4, East: 8, West: 16 };
const STOCK = { North: 32, South: 64, East: 128, West: 256 };
const ALL_MEASURES = ["stock_count", "stock_total", "visit_count", "visit_total"];
const USERS = ["lp_admin", "lp_owner", "lp_viewer", "lp_partial", "lp_north", "lp_inlist", "lp_complex", "lp_templ", "lp_rbac", "lp_noroles", "lp_outage"] as const;
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
    const widgetOps = (widgets: [string, string, string][]) => ({
      ops: widgets.map(([id, title, measure]) => ({ op: "add_widget", id, widget: { title, kind: "chart", chart: "bar", query: { kind: "breakdown", dimension: "region", measure } }, placement: { place: "bottom", width: "half" } })),
    });

    beforeAll(async () => {
      stack = await startStack(version);
      A = `superset-${stack.fixtures.dashboards.a}`;
      B = `superset-${stack.fixtures.dashboards.b}`;
      for (const u of USERS) s[u] = await stack.as(u);
      // The dashboards start empty: the admin puts a chart of each dataset on A and a stock chart on B, through Lenspack.
      const a = await s.lp_admin.lp("POST", `api/${PACK}/${A}/ops`, widgetOps([["visits_by_region", "Visits by region", "visit_total"], ["stock_by_region", "Stock by region", "stock_total"]]));
      expect(a.status, a.text).toBe(200);
      const b = await s.lp_admin.lp("POST", `api/${PACK}/${B}/ops`, widgetOps([["stock_b", "Stock by region", "stock_total"]]));
      expect(b.status, b.text).toBe(200);
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
        expect(await boards("lp_admin")).toEqual(sorted([A, B]));
        expect(await boards("lp_viewer")).toEqual([A]);
        expect(await boards("lp_rbac")).toEqual([B]);
        expect(await boards("lp_noroles")).toEqual([]);
        // The dashboard with tabs is not bound to a board yet (its cases bind it), and has no charts a viewer could read.
        expect(await dashboards("lp_admin")).toEqual(sorted([A, B, `superset-${stack.fixtures.dashboards.t}`]));
        expect(await dashboards("lp_viewer")).toEqual([A]);
        expect(await dashboards("lp_rbac")).toEqual([B]);
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
        // Dashboard roles open a dashboard, not its datasets: Lenspack shows lp_rbac no stock (Superset itself would, on that dashboard).
        expect((await data("lp_rbac", B)).stock_b!.rows).toEqual([]);
      });

      it("says up front, before any model call, when every dataset is kept from the user", async () => {
        const notice = (await catalogue("lp_rbac")).accessNotice;
        expect(notice).toMatch(NO_ACCESS);
        expect((await s.lp_rbac.lp("GET", `api/${PACK}/${B}`)).json.accessNotice).toMatch(NO_ACCESS);
        expect((await catalogue("lp_noroles")).accessNotice).toMatch(NO_ACCESS);
        modelCallsBefore = stack.modelCalls();
        const r = await chat("lp_rbac", B, "query", BREAKDOWN("stock_total"));
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
          expect(c.accessNotice).toMatch(/could not check your Superset access/);
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
    });

    describe("admin surfaces", () => {
      it("shows settings, the audit log and usage to Superset admins only; a dashboard owner is refused", async () => {
        for (const path of ["_superset/settings", "_superset/audit?limit=5", "_superset/turns?limit=5", "api/_usage"]) {
          expect([path, (await s.lp_admin.lp("GET", path)).status]).toEqual([path, 200]);
          for (const who of ["lp_owner", "lp_viewer", "lp_noroles"] as const) expect([who, path, (await s[who].lp("GET", path)).status]).toEqual([who, path, 403]);
        }
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

    describe("personal dashboards and saved configurations (pending: built in a parallel PR)", () => {
      // TODO(personal dashboards PR): turn each into a case once personal dashboards and saved configurations land.
      it.todo("a viewer may create a personal dashboard (and copy one they can open)");
      it.todo("a user may delete only their own personal dashboard");
      it.todo("a saved configuration applies only to dashboards the user controls");
      it.todo("another user's personal dashboard is neither listed nor opened nor edited");
    });
  });
}
