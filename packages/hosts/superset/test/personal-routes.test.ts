// The panel's routes: who Superset signed, and for which dashboard, decides what each request may do.
import { type Server, createServer } from "node:http";

import { emptyBoard } from "@lenspack/core";
import { PERSONAL_DEFAULTS } from "@lenspack/policy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { IDENTITY_HEADER, type Identity, canEdit, identityOf, signIdentity } from "../src/identity";
import { personalRoutes } from "../src/personal-routes";
import type { PersonalDashboards } from "../src/personal";

const KEY = "k".repeat(64);
const now = () => Math.floor(Date.now() / 1000);

describe("/_superset/my", () => {
  let server: Server;
  let base = "";
  const calls: { fn: string; who: unknown; args: unknown[] }[] = [];
  const audited: { user: string; action: string; outcome: string; detail?: string }[] = [];
  let scopeOwn = false;
  // personal.ts itself is tested in personal.test.ts: here, what the routes hand it.
  const fake = new Proxy({}, { get: (_t, fn: string) => async (who: unknown, ...args: unknown[]) => (calls.push({ fn, who, args }), fn === "everyone" ? { ok: true, users: [] } : { ok: true, fn }) }) as unknown as PersonalDashboards;
  beforeAll(async () => {
    const handle = personalRoutes({
      personal: fake,
      identity: (req) => identityOf(req, () => KEY),
      rightsOn: async (id) => ({ view: id.v === true, ...(!canEdit(id, "superset") ? { edit: false } : scopeOwn && !id.a ? { edit: false, byScope: true } : { edit: true }) }),
      scope: async () => ({ ctx: {} }),
      bind: async (d) => `superset-${d}`,
      shownBoard: async () => ({ config: emptyBoard({ pack: "p", version: 1 }, "T"), title: "T" }),
      limits: () => PERSONAL_DEFAULTS,
      setLimits: () => ({ ok: true }),
      editScope: () => ({ scope: scopeOwn ? "own" : "superset" }),
      setEditScope: (b) => (b.scope === "own" || b.scope === "superset" ? ((scopeOwn = b.scope === "own"), { ok: true }) : { ok: false, error: "scope must be superset or own" }),
      audit: (e) => audited.push(e),
      base: () => "",
      reply: (res, status, body) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      },
    });
    server = createServer(async (req, res) => {
      if (!(await handle(req, res, new URL(req.url!, "http://x")))) res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => server.close());

  const as = (claims: Partial<Identity>) => ({ [IDENTITY_HEADER]: signIdentity({ u: "vee", a: false, t: now(), i: 6, ...claims }, KEY), "content-type": "application/json" });
  const post = (path: string, claims: Partial<Identity>, body: unknown = {}) => fetch(`${base}${path}`, { method: "POST", headers: as(claims), body: JSON.stringify(body) });

  it("refuses anyone Superset did not sign", async () => {
    expect((await fetch(`${base}/_superset/my`)).status).toBe(401);
    expect((await fetch(`${base}/_superset/my`, { headers: { [IDENTITY_HEADER]: signIdentity({ u: "x", a: true, t: now() }, "wrong".repeat(13)) } })).status).toBe(401);
  });

  it("copies, saves and applies only on the dashboard Superset signed rights for", async () => {
    calls.length = 0;
    // Signed for 3, asking about 4: refused before anything is done.
    for (const path of ["/_superset/my/dashboards?dashboard=4", "/_superset/my/layouts?dashboard=4", "/_superset/my/layouts/l_1/apply?dashboard=4"]) {
      const r = await post(path, { d: 3, v: true, e: true }, { copy: true, name: "x" });
      expect(r.status, path).toBe(403);
    }
    // An older plugin signs no dashboard for these routes.
    expect((await post("/_superset/my/dashboards?dashboard=3", {}, { copy: true })).status).toBe(403);
    expect(calls).toEqual([]);
    await post("/_superset/my/dashboards?dashboard=3", { d: 3, v: true, e: false }, { copy: true, title: "Mine" });
    expect(calls.at(-1)).toMatchObject({ fn: "copy", who: { user: "vee", userId: 6, roles: [] }, args: [{ dashboard: 3, view: true, edit: false }, "Mine", ""] });
    await post("/_superset/my/layouts/l_1/apply?dashboard=3", { d: 3, v: true, e: false });
    expect(calls.at(-1)).toMatchObject({ fn: "applyLayout", args: ["l_1", { board: "superset-3", edit: false }, ""] });
    await post("/_superset/my/layouts/l_1/apply?dashboard=3", { d: 3, v: true, e: true });
    expect(calls.at(-1)).toMatchObject({ fn: "applyLayout", args: ["l_1", { edit: true }, ""] });
  });

  it("makes, deletes, renames and lists for the signed person; the everyone view is the admin's", async () => {
    calls.length = 0;
    await post("/_superset/my/dashboards", {}, { title: "New" });
    await post("/_superset/my/dashboards/delete", {}, { dashboard: 12 });
    await post("/_superset/my/layouts/l_2/rename", {}, { name: "Daily" });
    await post("/_superset/my/layouts/l_2/delete", {});
    expect(calls.map((c) => [c.fn, c.args[0]])).toEqual([["create", "New"], ["remove", 12], ["renameLayout", "l_2"], ["deleteLayout", "l_2"]]);
    // personal.everyone asks policy (mayViewAllPersonal) with the signed admin flag.
    await fetch(`${base}/_superset/personal`, { headers: as({}) });
    expect(calls.at(-1)).toMatchObject({ fn: "everyone", who: { roles: [] } });
    await fetch(`${base}/_superset/personal`, { headers: as({ a: true }) });
    expect(calls.at(-1)).toMatchObject({ fn: "everyone", who: { roles: ["admin"] } });
    expect((await fetch(`${base}/_superset/settings/personal`, { method: "PUT", headers: as({}), body: "{}" })).status).toBe(403);
  });

  it("changes the edit scope for admins only, audits it, and the next request follows it", async () => {
    calls.length = 0;
    const editor = { d: 3, v: true, e: true };
    await post("/_superset/my/layouts/l_1/apply?dashboard=3", editor);
    expect(calls.at(-1)).toMatchObject({ fn: "applyLayout", args: ["l_1", { edit: true }, ""] });
    const put = (claims: Partial<Identity>, body: unknown) => fetch(`${base}/_superset/settings/edit-scope`, { method: "PUT", headers: as(claims), body: JSON.stringify(body) });
    expect((await put({}, { scope: "own" })).status).toBe(403);
    expect((await put({ a: true }, { scope: "nope" })).status).toBe(400);
    expect(await (await put({ a: true }, { scope: "own" })).json()).toMatchObject({ ok: true, editScope: { scope: "own" } });
    expect(audited.filter((a) => a.action.endsWith("edit-scope")).map((a) => [a.user, a.outcome])).toEqual([["vee", "denied"], ["vee", "refused"], ["vee", "ok"]]);
    // Superset lets them edit dashboard 3, but it isn't theirs: the apply is asked with edit false, and the menu says why.
    await post("/_superset/my/layouts/l_1/apply?dashboard=3", editor);
    expect(calls.at(-1)).toMatchObject({ fn: "applyLayout", args: ["l_1", { edit: false }, ""] });
    await fetch(`${base}/_superset/my?dashboard=3`, { headers: as(editor) });
    expect(calls.at(-1)).toMatchObject({ fn: "overview", args: [{ dashboard: 3, edit: false, byScope: true }, ""] });
    await put({ a: true }, { scope: "superset" });
  });
});
