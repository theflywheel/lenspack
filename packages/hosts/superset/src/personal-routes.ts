// The panel's routes for people's own dashboards and saved layouts, under /_superset/my, and the admin's
// view of everyone's under /_superset/personal. Superset's /lenspack/ route signs the person (and, with
// ?dashboard=<id>, their rights on that dashboard) for every request; these routes only read that, ask
// @lenspack/policy (through personal.ts) and act. Bodies are JSON; every answer is JSON.

import type { IncomingMessage, ServerResponse } from "node:http";

import type { Capabilities, Ctx } from "@lenspack/engine";
import { type PersonalActor, type PersonalLimits, type Principal, type Rights, adminRights, principalOf } from "@lenspack/policy";

import { type Identity, rolesOf, supersetRights } from "./identity";
import type { PersonalDashboards, SignedRights } from "./personal";

export type PersonalRoutesOptions = {
  personal: PersonalDashboards;
  /** The deployment's rights by Superset role (supersetRights): who holds the admin role here. */
  rights?: Rights;
  /** In the deployment's words, for the refusal: "Superset admin", or "assistant admin" under a rule of its own. */
  adminName?: string;
  /** The signed identity of a request, or null. */
  identity: (req: IncomingMessage) => Identity | null;
  /**
   * What policy (boardRights) says that identity may do on the dashboard it was signed for: Superset's rights, the
   * edit policy and switch, narrowed by the edit scope; `byScope` when only the edit scope refuses the edit.
   */
  rightsOn: (id: Identity) => Promise<{ view: boolean; edit: boolean; byScope?: boolean }>;
  /** The engine context and capabilities the person's queries run with on that board (their hidden keys and datasets). */
  scope: (req: IncomingMessage, board: string) => Promise<{ ctx: Ctx; capabilities?: Capabilities } | null>;
  /** Binds a dashboard the person is on, so the board exists before a save or an apply. */
  bind: (dashboard: number) => Promise<string>;
  /** The board as this person is shown it, for a save. */
  shownBoard: (board: string, ctx: Ctx) => Promise<{ config: import("@lenspack/core").BoardConfig; title: string } | null>;
  limits: () => PersonalLimits;
  /** Admin: change the limits (settings.json "personal"). Throws when the settings can't be saved. */
  setLimits: (body: Record<string, unknown>) => { ok: true } | { ok: false; error: string };
  /** The edit scope as it stands, for the admin. */
  editScope: () => unknown;
  /** Admin: change the edit scope (settings.json "editScope"). Throws when the settings can't be saved. */
  setEditScope: (body: Record<string, unknown>) => { ok: true } | { ok: false; error: string };
  /** The audit log, for settings changes. */
  audit?: (e: { at: string; user: string; action: string; outcome: "ok" | "refused" | "denied"; detail?: string }) => void;
  /** Where browsers reach Superset, for links ("" when the panel runs on Superset's own pages). */
  base: (req: IncomingMessage) => string;
  reply: (res: ServerResponse, status: number, body: unknown) => void;
};

const MAX_BODY = 64 * 1024;

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw Object.assign(new Error("request too large"), { status: 413 });
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  const v = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * Superset says who this is, with the plugin's user id when it signs one. Their roles are settled by the deployment's
 * rights (principalOf), so an admin here is whoever the admins rule says, as on every other admin page.
 */
export const actorOf = (id: Identity, rights: Rights = supersetRights()): PersonalActor => ({
  user: id.u,
  userId: typeof id.i === "number" && Number.isSafeInteger(id.i) && id.i > 0 ? id.i : null,
  roles: principalOf({ user: id.u, roles: rolesOf(id), ...(typeof id.i === "number" ? { userId: id.i } : {}) }, rights).roles,
  // Superset's own right to write dashboards; a plugin too old to sign it: Superset admins only, who always have it.
  writes: typeof id.w === "boolean" ? id.w : id.a === true,
  hostRoles: id.r ?? [],
});

export function personalRoutes(o: PersonalRoutesOptions) {
  const { personal } = o;
  /** The rights Superset signed for ?dashboard=, or null when it signed none for that dashboard (an older plugin, another dashboard). */
  const signedFor = async (id: Identity, url: URL): Promise<(SignedRights & { dashboard: number; byScope?: boolean }) | null> => {
    const want = Number(url.searchParams.get("dashboard"));
    if (!Number.isSafeInteger(want) || want <= 0 || id.d !== want) return null;
    const rights = await o.rightsOn(id);
    return { dashboard: want, view: rights.view, edit: rights.view && rights.edit, ...(rights.byScope ? { byScope: true } : {}) };
  };
  const audited = (who: PersonalActor, action: string, outcome: "ok" | "refused" | "denied", detail: string) => o.audit?.({ at: new Date().toISOString(), user: who.user, action, outcome, detail: detail.slice(0, 300) });
  const unsigned = { error: "Superset did not check your access to this dashboard. Reload the page; if it keeps happening, lenspack_superset.py in Superset needs updating.", code: "unsigned" };
  const status = (r: { ok: boolean; code?: string }) => (r.ok ? 200 : r.code === "not-yours" || r.code === "no-view" || r.code === "no-edit" || r.code === "no-write" || r.code === "no-user-id" ? 403 : r.code === "missing" ? 404 : r.code === "limit" || r.code === "off" ? 409 : 400);

  const ADMIN_PATHS = ["/_superset/personal", "/_superset/settings/personal", "/_superset/settings/edit-scope"];
  /** The admin's routes (everyone's own dashboards, the limits, the edit scope) for a person already settled. */
  async function forAdmin(req: IncomingMessage, res: ServerResponse, url: URL, who: PersonalActor): Promise<boolean> {
    const path = url.pathname;
    const base = o.base(req);
    const send = (r: { ok: boolean; code?: string }) => o.reply(res, status(r), r);
    if (path === "/_superset/personal" && req.method === "GET") {
      const r = await personal.everyone(who, base);
      return send(r.ok ? r : { ...r, code: "not-yours" }), true;
    }
    if ((path === "/_superset/settings/personal" || path === "/_superset/settings/edit-scope") && req.method === "PUT") {
      const action = `PUT ${path}`;
      const admins = o.adminName ?? "Superset admin";
      if (!adminRights(who).administer) return audited(who, action, "denied", `not a ${admins}`), o.reply(res, 403, { error: `only ${admins}s can change this` }), true;
      const b = await body(req);
      const r = path === "/_superset/settings/personal" ? o.setLimits(b) : o.setEditScope(b);
      audited(who, action, r.ok ? "ok" : "refused", r.ok ? JSON.stringify(b) : r.error);
      if (!r.ok) return o.reply(res, 400, r), true;
      return o.reply(res, 200, path === "/_superset/settings/personal" ? { ok: true, limits: o.limits() } : { ok: true, editScope: o.editScope() }), true;
    }
    return false;
  }
  const failed = (res: ServerResponse, e: unknown) => {
    const s = (e as { status?: number }).status;
    return o.reply(res, s === 413 ? 413 : e instanceof SyntaxError ? 400 : 502, { error: e instanceof Error ? e.message.slice(0, 300) : String(e) }), true;
  };

  /** Handles the request when it is one of these routes; false otherwise. */
  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname;
    if (!ADMIN_PATHS.includes(path) && path !== "/_superset/my" && !path.startsWith("/_superset/my/")) return false;
    const id = o.identity(req);
    if (!id) return o.reply(res, 401, { error: "sign in to Superset first" }), true;
    const who = actorOf(id, o.rights);
    const base = o.base(req);
    const send = (r: { ok: boolean; code?: string }) => o.reply(res, status(r), r);
    try {
      if (await forAdmin(req, res, url, who)) return true;
      if (path === "/_superset/my" && req.method === "GET") {
        const here = url.searchParams.has("dashboard") ? await signedFor(id, url) : null;
        const view = await personal.overview(who, here, base);
        // byScope: Superset would let them edit here, but the deployment keeps the chat to their own dashboards.
        return o.reply(res, 200, view.here && here?.byScope ? { ...view, here: { ...view.here, byScope: true } } : view), true;
      }
      if (req.method !== "POST") return o.reply(res, 405, { error: "POST" }), true;
      const b = await body(req);
      const str = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : "");
      if (path === "/_superset/my/dashboards") {
        if (b.copy !== true) return send(await personal.create(who, str("title"), base)), true;
        const here = await signedFor(id, url);
        if (!here) return o.reply(res, 403, unsigned), true;
        return send(await personal.copy(who, here, str("title") || undefined, base)), true;
      }
      if (path === "/_superset/my/dashboards/delete") {
        const d = Number(b.dashboard ?? url.searchParams.get("dashboard"));
        if (!Number.isSafeInteger(d) || d <= 0) return o.reply(res, 400, { error: "say which dashboard" }), true;
        return send(await personal.remove(who, d)), true;
      }
      if (path === "/_superset/my/layouts") {
        const here = await signedFor(id, url);
        if (!here) return o.reply(res, 403, unsigned), true;
        const board = await o.bind(here.dashboard);
        const scope = await o.scope(req, board);
        const shown = scope && (await o.shownBoard(board, scope.ctx));
        if (!shown) return o.reply(res, 404, { error: "The assistant has not opened this dashboard yet.", code: "missing" }), true;
        return send(await personal.saveLayout(who, { ...here, board }, str("name"), shown.config, shown.title)), true;
      }
      const m = /^\/_superset\/my\/layouts\/([A-Za-z0-9_-]{1,40})\/(apply|rename|delete)$/.exec(path);
      if (m) {
        const [, layoutId, action] = m as unknown as [string, string, "apply" | "rename" | "delete"];
        if (action === "rename") return send(await personal.renameLayout(who, layoutId, str("name"))), true;
        if (action === "delete") return send(await personal.deleteLayout(who, layoutId)), true;
        const here = await signedFor(id, url);
        if (!here) return o.reply(res, 403, unsigned), true;
        const board = await o.bind(here.dashboard);
        const scope = await o.scope(req, board);
        if (!scope) return o.reply(res, 403, unsigned), true;
        return send(await personal.applyLayout(who, layoutId, { board, edit: here.edit, ...scope }, base)), true;
      }
      return o.reply(res, 404, { error: "not found" }), true;
    } catch (e) {
      return failed(res, e);
    }
  }
  /**
   * The admin's routes alone, for a caller settled without Superset's signature (an admin API key): false for any other
   * path, so nothing about a person's own dashboards is reached this way.
   */
  handle.admin = async (req: IncomingMessage, res: ServerResponse, url: URL, who: Pick<Principal, "user" | "roles">): Promise<boolean> => {
    if (!ADMIN_PATHS.includes(url.pathname)) return false;
    try {
      return (await forAdmin(req, res, url, { user: who.user, userId: null, roles: who.roles, writes: false, hostRoles: [] })) || (o.reply(res, 405, { error: "not a method this route takes" }), true);
    } catch (e) {
      return failed(res, e);
    }
  };
  return handle;
}
