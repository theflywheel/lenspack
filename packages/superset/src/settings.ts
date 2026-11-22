// Settings an admin changes on a running server, from Superset's Settings →
// AI assistant page: one JSON file in the state directory, one section per
// concern (speech, language, chat), each section written whole. Writes go to a
// temporary file and are renamed into place, so a crash never leaves half a file.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";

export type SettingsStore = {
  /** A section as last saved, or undefined (the deployment's default applies). */
  get<T>(section: string): T | undefined;
  /** Replaces a section; undefined removes it (back to the default). Saved at once. */
  set(section: string, value: unknown): void;
  /** Where the file is, for logs. */
  path: string;
};

export function settingsStore(stateDir: string, file = "settings.json"): SettingsStore {
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, file);
  const data: Record<string, unknown> = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : {};
  return {
    path,
    get: <T>(section: string) => data[section] as T | undefined,
    set(section, value) {
      if (value === undefined) delete data[section];
      else data[section] = value;
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(data, null, 2));
      renameSync(tmp, path);
    },
  };
}

/**
 * The guard on settings writes. Every path of this server is also reachable by
 * any signed-in Superset user through /lenspack/*; only the admin-only settings
 * page, which calls this server directly, holds the token. Without
 * LENSPACK_SETTINGS_TOKEN, settings are read-only.
 */
export function settingsToken(token = process.env.LENSPACK_SETTINGS_TOKEN ?? "") {
  return {
    writable: token !== "",
    /** null when the request may write; else why not. */
    check(req: IncomingMessage): string | null {
      if (!token) return "settings are read-only: LENSPACK_SETTINGS_TOKEN is not set";
      const got = Buffer.from(String(req.headers["x-lenspack-settings-token"] ?? ""));
      const want = Buffer.from(token);
      return got.length === want.length && timingSafeEqual(got, want) ? null : "wrong settings token";
    },
  };
}

/** A small JSON request body (a settings form), refusing anything over max bytes. */
export function readJson(req: IncomingMessage, max = 10_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > max) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        const v = JSON.parse(body || "{}") as unknown;
        if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("body must be a JSON object");
        resolve(v as Record<string, unknown>);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    req.on("error", reject);
  });
}
