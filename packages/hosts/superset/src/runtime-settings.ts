// The Superset host's own options that an admin changes on a running server (docs/hosts/superset/runtime.md): how
// the chat opens (overlay.panel) and where the admin pages are (admin.surface). Kept in settings.json beside the rest;
// the admin's value wins over superset.yaml and the environment, and null hands it back. Who may change them is
// policy's (adminRights); this file keeps the values and answers PUT <prefix>/settings/<area>.

import type { IncomingMessage, ServerResponse } from "node:http";

import { ADMIN_SURFACES, type AdminAccess, type AdminSurface, type Principal, adminRights } from "@lenspack/policy";
import { type AuditEvent, NO_STORE, type SettingsStore, SettingsSaveError, json, readJson } from "@lenspack/serve";

export const PANELS = ["float", "dock"] as const;
export type Panel = (typeof PANELS)[number];

type Outcome = { ok: true; detail: string } | { ok: false; error: string; status?: number };
export type Area = { name: string; view: (writable: boolean) => Record<string, unknown>; update: (b: Record<string, unknown>) => Outcome | Promise<Outcome> };

/** One setting held in a settings.json section, over the deployment's value: `value` reads it, `area` answers its route. */
function choice<T extends string>(settings: SettingsStore, o: { section: string; field: string; options: readonly T[]; deploy: T; from: string | null }) {
  const saved = () => settings.get<Record<string, T>>(o.section)?.[o.field];
  const value = (): T => saved() ?? o.deploy;
  const area: Area = {
    name: o.section,
    view: (writable) => ({ [o.field]: value(), default: o.deploy, from: o.from ?? "default", options: o.options, source: saved() ? "settings" : "default", writable }),
    update(b) {
      const extra = Object.keys(b).filter((k) => k !== o.field);
      if (extra.length || !(o.field in b)) return { ok: false, error: `send { "${o.field}": ${o.options.map((x) => `"${x}"`).join(" | ")} }, or null for the deployment's value` };
      const v = b[o.field];
      if (v === null) settings.set(o.section, undefined);
      else if (typeof v === "string" && (o.options as readonly string[]).includes(v)) settings.set(o.section, { [o.field]: v });
      else return { ok: false, error: `${o.field} must be ${o.options.map((x) => `"${x}"`).join(" or ")}, or null` };
      return { ok: true, detail: `${o.field} ${value()}${v === null ? " (the deployment's)" : ""}` };
    },
  };
  return { value, area };
}

/** How the chat opens beside a dashboard: floating (the default) or docked; the config's overlay.panel, unless an admin set one. */
export const panelSetting = (settings: SettingsStore, deploy: unknown) => choice<Panel>(settings, { section: "panel", field: "panel", options: PANELS, deploy: deploy === "dock" ? "dock" : "float", from: deploy === undefined ? null : "overlay.panel" });

/** Where the admin pages are: the config's (or LENSPACK_ADMIN_SURFACE's), unless an admin set one. */
export const surfaceSetting = (settings: SettingsStore, deploy: AdminSurface, from: string | null) => choice<AdminSurface>(settings, { section: "adminSurface", field: "surface", options: ADMIN_SURFACES, deploy, from });

/**
 * The routes PUT <prefix>/settings/<area> for these areas, for admins (adminRights under the access mode in force).
 * Answers by responding, true when it did; audited with who made the change (an admin API key as api:<name>).
 */
export function supersetSettingsRoutes(o: {
  areas: Record<string, Area>;
  access: () => AdminAccess;
  audit?: (e: AuditEvent) => void;
  log: (line: string) => void;
  writable: () => boolean;
  /** Runs a change as one writer of the settings store (asSettingsWriter): If-Match checked, a stale change refused with 409. */
  writer?: (req: IncomingMessage, res: ServerResponse, who: Principal, run: () => Promise<unknown>) => Promise<void>;
  /** Headers on every answer (the settings' revision, as an ETag). */
  headers?: () => Record<string, string>;
}) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL, who: Principal, prefix: string, adminName: string): Promise<boolean> => {
    const m = new RegExp(`^${prefix.replace(/[/]/g, "\\/")}/settings/([a-z-]+)$`).exec(url.pathname);
    const area = m ? o.areas[m[1]!] : undefined;
    if (!area) return false;
    const send = (status: number, body: unknown) => (json(res, status, body, { ...NO_STORE, ...o.headers?.() }), true);
    const audit = (outcome: AuditEvent["outcome"], detail: string) => {
      try {
        o.audit?.({ at: new Date().toISOString(), user: who.user, action: `settings ${m![1]}`, outcome, detail: detail.slice(0, 1000) });
      } catch {
        /* the audit log never takes a change down with it */
      }
    };
    if (!adminRights(who, o.access()).administer) {
      audit("denied", `not a ${adminName}`);
      return send(403, { error: `only ${adminName}s can do this` });
    }
    if (req.method === "GET") return send(200, area.view(o.writable()));
    if (req.method !== "PUT") return send(405, { error: "GET or PUT" });
    let b: unknown;
    try {
      b = await readJson(req, 20_000);
    } catch (e) {
      return send(400, { error: e instanceof Error ? e.message : String(e) });
    }
    if (!b || typeof b !== "object" || Array.isArray(b)) return send(400, { error: "the body is a JSON object" });
    const change = async () => {
      let r: Outcome;
      try {
        r = await area.update(b as Record<string, unknown>);
      } catch (e) {
        if (e instanceof SettingsSaveError) return send(503, { error: e.message });
        throw e;
      }
      if (!r.ok) {
        audit("refused", r.error);
        return send(r.status ?? 400, { error: r.error });
      }
      o.log(`${m![1]}: ${r.detail} (by ${who.user})`);
      audit("ok", r.detail);
      return send(200, area.view(o.writable()));
    };
    if (o.writer) await o.writer(req, res, who, change);
    else await change();
    return true;
  };
}
