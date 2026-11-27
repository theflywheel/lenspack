// Settings an admin changes on a running server, from a host's settings page
// (Superset's Settings → AI assistant): one JSON file in the state directory, one section per
// concern (speech, language, chat), each section written whole. Writes go to a
// temporary file and are renamed into place, so a crash never leaves half a file. A write the disk refuses
// (full, read-only) changes nothing, in memory or on disk, and throws SettingsSaveError, which the server
// answers with 503.
//
// Every write of a setting bumps the store's revision, kept in the file with who made each section's last change. A
// writer that says which revision it read (HTTP If-Match, through `as`) is refused with SettingsConflictError when the
// section it writes changed after that revision, and nothing is written: an admin page holding an old copy can't
// silently undo a change made elsewhere. A writer that says nothing (a script without If-Match) writes as before, the
// last write to a section winning. Records kept beside the settings (the admins roster) are written without a revision.

import { AsyncLocalStorage } from "node:async_hooks";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

import { NO_STORE, json } from "./http";

/** A section's last change: the store's revision it made, who made it and when. */
export type SettingsChange = { section: string; revision: number; by?: string; at: string };

export type SettingsStore = {
  /** A section as last saved, or undefined (the deployment's default applies). */
  get<T>(section: string): T | undefined;
  /**
   * Replaces a section; undefined removes it (back to the default). Saved at once. Inside `as` with a revision, throws
   * SettingsConflictError (nothing written) when the section changed after it. `record`: a record kept beside the
   * settings (the admins roster), written without a revision or a check.
   */
  set(section: string, value: unknown, o?: { record?: boolean }): void;
  /** Where the file is, for logs. */
  path: string;
  /** The revision now: 0 before any setting was changed, then one more for each write. */
  revision(): number;
  /** The newest change, or null. */
  lastChange(): SettingsChange | null;
  /**
   * Runs `fn` as one writer: every write inside it (through awaits too) is attributed to `by`, and with `ifRevision`
   * (the revision the writer read) a write to a section changed after it throws SettingsConflictError. Null or
   * undefined: no check, the last write wins.
   */
  as<T>(writer: { by?: string; ifRevision?: number | null }, fn: () => T): T;
};

/** A write from a copy older than the section's last change: nothing was written. */
export class SettingsConflictError extends Error {
  constructor(
    readonly change: SettingsChange,
    readonly ifRevision: number,
  ) {
    const [what, unit] = change.section === "pack" ? ["the pack", "version"] : [`the ${change.section} settings`, "revision"];
    super(`${what} changed elsewhere${change.by ? ` by ${change.by}` : ""} since this copy was read (now ${unit} ${change.revision}; this change was made on ${unit} ${ifRevision}). Nothing was changed: read it again and make the change on that`);
  }
}

/** The ETag for a store's revision (`"settings-12"`); `kind` tells one store's revisions from another's (`"pack-3"`). */
export const revisionTag = (revision: number, kind = "settings") => `"${kind}-${revision}"`;

/**
 * The revision a request's If-Match names, for a store of this kind: null when there is none (or `*`), so the write
 * goes ahead unchecked; an Error when it is not one of this store's tags.
 */
export function ifMatchRevision(header: string | string[] | undefined, kind = "settings"): number | null | Error {
  const v = (Array.isArray(header) ? header[0] : header)?.trim();
  if (!v || v === "*") return null;
  const m = new RegExp(`^(?:W/)?"${kind}-(\\d{1,15})"$`).exec(v);
  return m ? Number(m[1]) : new Error(`If-Match must be the ETag a GET of these settings answered, like ${revisionTag(7, kind)}`);
}

/** Why the disk refused a write, in words for an admin. */
export function diskProblem(e: unknown): string {
  const code = (e as { code?: string })?.code;
  if (code === "ENOSPC") return "the disk is full";
  if (code === "EDQUOT") return "the disk quota is used up";
  if (code === "EROFS") return "the disk is read-only";
  if (code === "EACCES" || code === "EPERM") return "it has no permission to write there";
  return e instanceof Error ? e.message : String(e);
}

export class SettingsSaveError extends Error {
  constructor(readonly cause: unknown) {
    super(`The assistant's server can't save settings: ${diskProblem(cause)}. Nothing was changed.`);
  }
}

/** Writes a file whole or not at all: a temporary file renamed into place, removed again if the write fails. `mode` (0o600: the owner only) is set before the rename. */
export function writeWhole(path: string, text: string, mode?: number) {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, mode === undefined ? undefined : { mode });
    if (mode !== undefined) chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Where the revision and each section's last change are kept in the file: never a section's name. */
const REVISIONS = "_revisions";
type Revisions = { revision: number; sections: Record<string, SettingsChange> };

export function settingsStore(stateDir: string, file = "settings.json"): SettingsStore {
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, file);
  const data: Record<string, unknown> = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : {};
  const revs = (): Revisions => (data[REVISIONS] as Revisions | undefined) ?? { revision: 0, sections: {} };
  const writer = new AsyncLocalStorage<{ by?: string; ifRevision?: number | null }>();
  return {
    path,
    get: <T>(section: string) => (section === REVISIONS ? undefined : (data[section] as T | undefined)),
    set(section, value, o = {}) {
      const next = { ...data };
      if (value === undefined) delete next[section];
      else next[section] = value;
      if (!o.record) {
        const w = writer.getStore();
        const r = revs();
        const last = r.sections[section];
        // The conflict rule: a writer that read revision N may not write a section changed after N.
        if (w?.ifRevision !== undefined && w.ifRevision !== null && last && last.revision > w.ifRevision) throw new SettingsConflictError(last, w.ifRevision);
        const change: SettingsChange = { section, revision: r.revision + 1, ...(w?.by ? { by: w.by } : {}), at: new Date().toISOString() };
        next[REVISIONS] = { revision: change.revision, sections: { ...r.sections, [section]: change } } satisfies Revisions;
      }
      try {
        writeWhole(path, JSON.stringify(next, null, 2));
      } catch (e) {
        throw new SettingsSaveError(e);
      }
      // Only once it is on disk does the new value count.
      if (value === undefined) delete data[section];
      else data[section] = value;
      if (next[REVISIONS]) data[REVISIONS] = next[REVISIONS];
    },
    revision: () => revs().revision,
    lastChange: () => Object.values(revs().sections).reduce<SettingsChange | null>((a, c) => (!a || c.revision > a.revision ? c : a), null),
    as: (w, fn) => writer.run(w, fn),
  };
}

/**
 * A settings write refused because the settings changed after the copy it was made on (If-Match): 409, with who changed
 * what, and the settings as they are now. Shared by every host's settings routes.
 */
export function conflictAnswer(e: SettingsConflictError, current?: unknown) {
  return { error: e.message, code: "changed-elsewhere", section: e.change.section, by: e.change.by ?? null, at: e.change.at, revision: e.change.revision, ...(current !== undefined ? { current } : {}) };
}

/**
 * Runs a settings route as one writer of the settings store: a write (PUT or POST) with If-Match is checked against the
 * revision it names (the rule is the store's: settings.ts), every write is attributed to the caller, and a refused one
 * answers 409 with who changed what and `current()`. A bad If-Match answers 400. Used by every route that writes
 * settings.json: the settings routes, the admin panel's, and a host's own (Superset's personal-dashboard limits).
 */
export async function asSettingsWriter(store: SettingsStore, req: IncomingMessage, res: ServerResponse, who: { user: string }, run: () => Promise<unknown>, current?: () => unknown): Promise<void> {
  const writes = req.method === "PUT" || req.method === "POST";
  const ifRevision = writes ? ifMatchRevision(req.headers["if-match"]) : null;
  if (ifRevision instanceof Error) return json(res, 400, { error: ifRevision.message }, NO_STORE);
  try {
    await store.as({ by: who.user, ifRevision }, run);
  } catch (e) {
    if (!(e instanceof SettingsConflictError) || res.headersSent) throw e;
    json(res, 409, conflictAnswer(e, await current?.()), { ...NO_STORE, ETag: revisionTag(store.revision()) });
  }
}
