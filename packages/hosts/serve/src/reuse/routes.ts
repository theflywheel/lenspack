// The answer store's admin API, under a host's admin prefix (/_superset), for admins only:
//   GET  <prefix>/cache                     stats and every entry
//   POST <prefix>/cache/<id>/pin | unpin | evict
//   GET  <prefix>/cache/suggestions?board=  the most-asked questions on a board (every scope)
//   GET  <prefix>/cache/chart-candidates    questions asked often that no chart on their board answers
//   GET  <prefix>/cache/boards              how often each board changes; settled boards
//   POST <prefix>/cache/prewarm             refresh the most-asked answers now
//   POST <prefix>/cache/data-changed        a dataset's data changed: refresh them shortly ({ "pack"?: name })
// The contract is in docs/caching.md.

import type { IncomingMessage, ServerResponse } from "node:http";

import { type Reuse, type TurnGate } from "@lenspack/agent";
import { mayAdminister } from "@lenspack/policy";

import type { AuditLog } from "../audit";
import type { Principal } from "../auth";
import { NO_STORE, json, readJson } from "../http";

export function cacheRoutes(o: { prefix: string; reuse: Reuse; queue?: TurnGate; audit?: Pick<AuditLog, "audit"> | null; adminName: string }) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL, who: Principal): Promise<void> => {
    const base = `${o.prefix}/cache`;
    if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return;
    const send = (status: number, body: unknown) => json(res, status, body, NO_STORE);
    if (!mayAdminister(who)) {
      o.audit?.audit({ at: new Date().toISOString(), user: who.user, action: `${req.method} ${url.pathname}`, outcome: "denied", detail: `not a ${o.adminName}` });
      return send(403, { error: `only ${o.adminName}s can do this` });
    }
    const rest = url.pathname.slice(base.length);
    if (req.method === "GET") {
      if (rest === "" || rest === "/") return send(200, { ...(await o.reuse.list()), ...(o.queue ? { queue: o.queue.stats() } : {}) });
      if (rest === "/suggestions") {
        const board = url.searchParams.get("board");
        if (!board) return send(400, { error: "name the board: ?board=<id>" });
        return send(200, { board, suggestions: await o.reuse.suggestions({ board, scope: null, lang: url.searchParams.get("lang"), limit: Number(url.searchParams.get("limit")) || 8 }) });
      }
      if (rest === "/chart-candidates") return send(200, { candidates: await o.reuse.chartCandidates({ minAsks: Number(url.searchParams.get("minAsks")) || undefined, days: Number(url.searchParams.get("days")) || undefined }) });
      if (rest === "/boards") return send(200, { boards: await o.reuse.boards() });
      return send(404, { error: "not found" });
    }
    if (req.method === "POST" && (rest === "/prewarm" || rest === "/data-changed")) {
      const body = rest === "/data-changed" ? ((await readJson(req).catch(() => ({}))) as { pack?: unknown }) : {};
      const pack = typeof body.pack === "string" ? body.pack : null;
      o.audit?.audit({ at: new Date().toISOString(), user: who.user, action: `cache ${rest.slice(1)}`, outcome: "ok", detail: pack ?? "" });
      // A refresh for changed data waits a few seconds (a load often touches several datasets) and runs on its own.
      if (rest === "/data-changed") return void o.reuse.dataChanged(pack).catch(() => undefined), send(202, { ok: true, scheduled: true });
      return send(200, { ok: true, run: await o.reuse.prewarm(pack) });
    }
    const m = /^\/([a-z0-9]+)\/(pin|unpin|evict)$/.exec(rest);
    if (req.method !== "POST" || !m) return send(404, { error: "not found" });
    const [, id, action] = m;
    const ok = action === "evict" ? await o.reuse.evict(id!) : await o.reuse.pin(id!, action === "pin");
    if (!ok) return send(404, { error: `no saved answer ${id}` });
    o.audit?.audit({ at: new Date().toISOString(), user: who.user, action: `cache ${action}`, outcome: "ok", detail: id });
    return send(200, { ok: true, id, action });
  };
}
