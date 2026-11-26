import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

import { type Principal, adminRights } from "@lenspack/policy";

import { type BrandSettings, DEFAULT_BRAND_NAME, brandAuditDetail } from "../brand";
import type { Features } from "../features";
import { BodyTooLarge, NO_STORE, TYPES, escapeHtml, json, readJson } from "../http";
import { publicView } from "../llm";
import type { Provider } from "../llm";
import { SettingsSaveError } from "../settings";
import { OverlayError, overlaySize } from "./overlay";
import { QuestionError } from "./questions";
import { ReviewBusy, type ReviewSystem } from "./system";
import type { UsageBoard } from "./usage";

// The admin panel, served by Lenspack itself under a host's admin prefix (<prefix>/admin/), so
// it works the same in any host: Superset reaches it through its /lenspack/ route with the signed
// identity, the standalone server behind its own sign-in. The page and its script are plain files
// (web/admin/); everything it shows comes from <prefix>/admin/api/…, for admins only. The page
// calls only relative paths, so it works under any mount point.

/** web/admin, found from the source tree (src/review) or the built package (dist). */
function webDir(): string {
  for (const rel of ["../../web/admin/", "../web/admin/"]) {
    const p = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(`${p}index.html`)) return p;
  }
  throw new Error("lenspack: the admin panel's files (web/admin) are missing from this install");
}

export type PanelOptions = {
  /** The host's admin prefix: /_superset, /_admin. */
  prefix: string;
  system: ReviewSystem;
  features: Features;
  /** What the assistant is called (brand.ts): the panel's title, and the Settings tab's Name card. */
  brand?: BrandSettings;
  providers: () => Provider[];
  /** In the host's words, for the refusal: "Superset admin". Who that is, the host says by giving them the admin role; the policy decides (adminRights). */
  adminName: string;
  /** The host's name for the page title. */
  title?: string;
  log?: (line: string) => void;
  /** The usage pack and its board (review/usage.ts): the Overview tab, and the chat about usage. Absent, the tab shows plain counts. */
  usage?: UsageBoard | null | Promise<UsageBoard | null>;
};

// board.js and board.css are the board renderer (@lenspack/react) bundled for a page with no build: its build writes them here.
const ASSETS: Record<string, string> = { "panel.js": "panel.js", "checklist.js": "checklist.js", "panel.css": "panel.css", "board.js": "board.js", "board.css": "board.css" };

export function panelRoutes(o: PanelOptions) {
  const dir = webDir();
  const base = `${o.prefix}/admin`;
  const s = o.system;
  return async (req: IncomingMessage, res: ServerResponse, url: URL, who: Principal): Promise<boolean> => {
    if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return false;
    const send = (status: number, body: unknown) => (json(res, status, body, NO_STORE), true);
    const rights = adminRights(who);
    if (!rights.administer) {
      s.audit(who.user, `${req.method} ${url.pathname}`, `not a ${o.adminName}`, undefined, "denied");
      if (url.pathname.startsWith(`${base}/api/`)) return send(403, { error: `only ${o.adminName}s can use the admin panel` });
      res.writeHead(403, { "content-type": TYPES[".html"]!, ...NO_STORE });
      const name = escapeHtml(o.brand?.get().name ?? DEFAULT_BRAND_NAME);
      res.end(`<!doctype html><meta charset="utf-8"><title>${name} admin</title><p style="font:15px system-ui;margin:40px">Only ${o.adminName}s can open the ${name} admin panel.</p>`);
      return true;
    }
    // The page's own address ends in a slash, so its relative calls (api/…, panel.js, ../cache) land under the prefix.
    if (url.pathname === base) {
      res.writeHead(302, { location: "admin/", ...NO_STORE });
      res.end();
      return true;
    }
    const rest = url.pathname.slice(base.length + 1);
    if (rest === "" || rest === "index.html") {
      const brand = o.brand?.get();
      const name = escapeHtml(brand?.name ?? DEFAULT_BRAND_NAME);
      let html = readFileSync(`${dir}index.html`, "utf8").replace("__TITLE__", o.title ? o.title.replace(/[<>&"]/g, "") : name).replaceAll("__NAME__", name);
      // The deployment's icon in the header's mark, as an image's address (checked in brand.ts, escaped here).
      if (brand?.icon) html = html.replace('<span class="mark" aria-hidden="true"></span>', `<span class="mark icon" aria-hidden="true"><img src="${escapeHtml(brand.icon)}" alt=""></span>`);
      res.writeHead(200, { "content-type": TYPES[".html"]!, ...NO_STORE });
      res.end(html);
      return true;
    }
    if (ASSETS[rest]) {
      if (!existsSync(`${dir}${ASSETS[rest]}`)) return send(404, { error: `${rest} is not built in this install` });
      res.writeHead(200, { "content-type": TYPES[rest.slice(rest.lastIndexOf("."))]!, ...NO_STORE });
      res.end(readFileSync(`${dir}${ASSETS[rest]}`, "utf8"));
      return true;
    }
    if (!rest.startsWith("api/")) return send(404, { error: "not found" });
    // The usage pack's board API (GET the board, its data, POST ops and chat), as the admin.
    if (rest === "api/usage" || rest.startsWith("api/usage/")) {
      const usage = await o.usage;
      if (!usage) return send(404, { error: "the usage board is off on this server (it needs DuckDB and a state directory)" });
      await usage.handle(req, res, rest.slice("api/usage/".length), url.search, who);
      return true;
    }
    const path = rest.slice(4).split("/").filter(Boolean);
    const packName = url.searchParams.get("pack") ?? s.packs()[0]?.name ?? "";
    const by = who.user;
    let body: Record<string, unknown> = {};
    if (req.method === "POST" || req.method === "PUT") {
      try {
        const b = await readJson(req, 50_000);
        body = b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
      } catch (e) {
        return send(e instanceof BodyTooLarge ? 413 : 400, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    const why = typeof body.why === "string" ? body.why : "";
    const post = req.method === "POST" || req.method === "PUT";
    try {
      const [a, id, action] = path;
      switch (a) {
        case "packs": {
          const usage = await o.usage;
          return send(200, { me: { user: who.user }, usage: usage ? { board: "overview", source: usage.source() } : null, packs: await Promise.all(s.packs().map(async (p) => ({ ...p, definitionsVersion: await s.definitionsVersion(p.name) }))) });
        }
        case "overview":
          return send(200, await s.overview(Math.max(1, Math.min(Number(url.searchParams.get("days")) || 14, 90))));
        case "definitions": {
          const ov = s.overlay(packName);
          const h = s.host(packName);
          if (!id && !post) {
            const doc = await ov.doc();
            return send(200, { pack: packName, entries: doc.entries, history: [...doc.history].reverse().map(({ before: _b, after, ...c }) => ({ ...c, entries: after.length })), size: overlaySize(doc.entries), budget: ov.budget, version: doc.version, definitionsVersion: await s.definitionsVersion(packName), packInstructions: h.pack.instructions ?? "", keys: [...h.pack.measures.map((m) => ({ key: m.key, kind: "measure", label: m.label ?? m.key })), ...h.pack.dimensions.map((d) => ({ key: d.key, kind: "dimension", label: d.label ?? d.key }))] });
          }
          if (!post) break;
          if (!id) {
            const r = await ov.add({ kind: body.kind as never, key: body.key as never, text: body.text as never, words: body.words as never, when: body.when as never, source: "admin" }, by, why);
            s.audit(by, "definitions add", r.change.summary, packName);
            return send(200, r);
          }
          if (id === "undo") {
            const c = await ov.undo(by, why);
            s.audit(by, "definitions undo", c.summary, packName);
            return send(200, { change: c });
          }
          if (id === "restore") {
            const c = await ov.restore(Number(body.version), by, why);
            s.audit(by, "definitions restore", c.summary, packName);
            return send(200, { change: c });
          }
          if (action === "edit") {
            const r = await ov.edit(id, { key: body.key as never, text: body.text as never, words: body.words as never, when: body.when as never }, by, why);
            s.audit(by, "definitions edit", r.change.summary, packName);
            return send(200, r);
          }
          if (action === "remove") {
            const c = await ov.remove(id, by, why);
            s.audit(by, "definitions remove", c.summary, packName);
            return send(200, { change: c });
          }
          break;
        }
        case "questions": {
          if (!id && !post) {
            const status = url.searchParams.get("status");
            return send(200, { pack: packName, questions: await s.questions(packName).list(status === "open" || status === "answered" || status === "dismissed" ? status : undefined) });
          }
          if (!post) return id ? send(200, await s.questions(packName).get(id)) : send(404, { error: "not found" });
          if (!id) return send(200, await s.addQuestion(packName, body, by));
          if (action === "answer") return send(200, await s.answer(packName, id, String(body.reading ?? ""), by, why));
          if (action === "dismiss") return send(200, await s.dismiss(packName, id, by, why));
          if (action === "reopen") return send(200, await s.reopen(packName, id, by));
          if (action === "edit") return send(200, await s.editQuestion(packName, id, body, by));
          if (action === "compare") return send(200, await s.compare(packName, id));
          break;
        }
        case "proposals": {
          if (!id && !post) {
            const status = url.searchParams.get("status");
            return send(200, { proposals: await s.proposals(status === "pending" || status === "accepted" || status === "rejected" ? status : undefined) });
          }
          if (action === "accept") return send(200, await s.acceptProposal(id!, by, (body.edit && typeof body.edit === "object" ? body.edit : {}) as never, why));
          if (action === "reject") return send(200, await s.rejectProposal(id!, by, why));
          break;
        }
        case "runs":
          if (!id) return send(200, { runs: (await s.runs()).map(({ packs, ...r }) => ({ ...r, packs: packs.map((p) => ({ pack: p.pack, turns: p.turns, status: p.status, reason: p.reason, usd: p.usd, findings: p.report?.findings.length ?? 0, proposals: p.proposals?.length ?? 0, questions: p.questions?.length ?? 0 })) })) });
          {
            const run = await s.run(id);
            if (!run) return send(404, { error: `no run ${id}` });
            // Who asked what is shown only to those who may see usernames.
            return send(200, rights.users ? run : { ...run, packs: run.packs.map(({ users: _u, turnIndex, ...p }) => ({ ...p, turnIndex: turnIndex?.map(({ user: _x, ...t }) => t) })) });
          }
        case "review": {
          if (id === "settings") {
            if (!post) return send(200, { ...(await s.settingsView()), models: o.providers().map(publicView) });
            const r = s.updateSettings(body, by);
            return r.ok ? send(200, { ...(await s.settingsView()), models: o.providers().map(publicView) }) : send(400, { error: r.error });
          }
          if (id === "estimate") return send(200, await s.estimate());
          if (id === "run" && post) {
            if (body.confirm !== true) return send(400, { error: "ask for the estimate first, then send { confirm: true }" });
            if (s.running()) return send(409, { error: "a review is already running" });
            const done = s.runNow(by);
            done.catch((e) => o.log?.(`review run: ${e instanceof Error ? e.message : String(e)}`));
            return send(202, { started: true, run: (await s.runs())[0]?.id ?? null });
          }
          break;
        }
        case "settings": {
          if (!post) return send(200, { features: o.features.view(true), review: await s.settingsView(), ...(o.brand ? { brand: o.brand.view(true) } : {}) });
          // The assistant's name and button (the same change as PUT <prefix>/settings/brand on a host's settings routes).
          if (id === "brand" && o.brand) {
            const r = o.brand.update(body);
            if (!r.ok) return send(400, { error: r.error });
            s.audit(by, "settings brand", brandAuditDetail(body));
            o.log?.(`brand: ${r.brand.name} ("${r.brand.buttonLabel}")`);
            return send(200, { brand: o.brand.view(true) });
          }
          if (id === "features") {
            const wasDaily = o.features.on("review.daily");
            const r = o.features.update(body);
            if (!r.ok) return send(400, { error: r.error });
            s.audit(by, "settings features", JSON.stringify(r.changed));
            if (!wasDaily && o.features.on("review.daily")) await s.switchedOn();
            else s.reschedule();
            return send(200, { features: o.features.view(true), review: await s.settingsView() });
          }
          break;
        }
      }
      return send(404, { error: "not found" });
    } catch (e) {
      if (e instanceof OverlayError || e instanceof QuestionError) return send(400, { error: e.message });
      if (e instanceof ReviewBusy) return send(409, { error: e.message });
      if (e instanceof SettingsSaveError) return send(503, { error: e.message });
      throw e;
    }
  };
}
