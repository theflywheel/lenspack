// Settings an admin changes on a running server, from a host's settings page
// (Superset's Settings → AI assistant): one JSON file in the state directory, one section per
// concern (speech, language, chat), each section written whole. Writes go to a
// temporary file and are renamed into place, so a crash never leaves half a file. A write the disk refuses
// (full, read-only) changes nothing, in memory or on disk, and throws SettingsSaveError, which the server
// answers with 503.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type SettingsStore = {
  /** A section as last saved, or undefined (the deployment's default applies). */
  get<T>(section: string): T | undefined;
  /** Replaces a section; undefined removes it (back to the default). Saved at once. */
  set(section: string, value: unknown): void;
  /** Where the file is, for logs. */
  path: string;
};

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

/** Writes a file whole or not at all: a temporary file renamed into place, removed again if the write fails. mode: a private file's (0o600). */
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

export function settingsStore(stateDir: string, file = "settings.json"): SettingsStore {
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, file);
  const data: Record<string, unknown> = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : {};
  return {
    path,
    get: <T>(section: string) => data[section] as T | undefined,
    set(section, value) {
      const next = { ...data };
      if (value === undefined) delete next[section];
      else next[section] = value;
      try {
        writeWhole(path, JSON.stringify(next, null, 2));
      } catch (e) {
        throw new SettingsSaveError(e);
      }
      // Only once it is on disk does the new value count.
      if (value === undefined) delete data[section];
      else data[section] = value;
    },
  };
}
