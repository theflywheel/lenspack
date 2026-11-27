// The pack's runtime layer as a store (@lenspack/policy pack-layer.ts says what it may hold): one JSON file in the state
// directory, pack-layer.json, owner-only (mode 600). Every change is a new version kept whole, with who made it, when,
// why and which parts it changed, so any version can be shown, compared or gone back to. The newest version is the
// layer in force; version 0 is the deploy config alone. Written like settings.json: a temporary file renamed into
// place, so a crash never leaves half a file, and a write the disk refuses changes nothing and throws
// SettingsSaveError. A file that can't be read is set aside (pack-layer.json.unreadable-<time>) and the server starts
// on the deploy config alone, saying so: a broken file never stops the server.

import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";

import { SettingsSaveError, writeWhole } from "./settings";

export type PackVersionAction = "edit" | "revert" | "reset";

export type PackVersion = {
  version: number;
  at: string;
  /** Who: a user name, `api:<name>` for an admin API key, `admin:<name>` for a named password. */
  by: string;
  action: PackVersionAction;
  /** In words: "labels, examples", "back to version 2", "labels back to the deploy config". */
  summary: string;
  /** The runtime fields whose value this version changed. */
  changed: string[];
  why?: string;
  /** revert: the version gone back to. */
  reverts?: number;
  /** The whole layer in force from this version on. */
  layer: Record<string, unknown>;
};

export type PackLayerStore = {
  path: string;
  /** The layer in force and its version (0 and {} for the deploy config alone). */
  current(): { version: number; layer: Record<string, unknown> };
  /** Every version kept, oldest first. */
  versions(): PackVersion[];
  /** One version; 0 is the deploy config alone. */
  get(version: number): PackVersion | undefined;
  /** Saves a new version, in force at once; throws SettingsSaveError (nothing changed) when the disk refuses. */
  append(v: Omit<PackVersion, "version" | "at"> & { at?: string }): PackVersion;
  /** Set when the file could not be read at start and was set aside: where it went. */
  setAside?: string;
};

/** How many versions are kept; the oldest go first (the one in force always stays). */
export const PACK_VERSIONS_KEPT = 200;

const CONFIG_ONLY: PackVersion = { version: 0, at: "", by: "the deploy config", action: "reset", summary: "the deploy config alone", changed: [], layer: {} };

export function packLayerStore(stateDir: string, o: { file?: string; log?: (line: string) => void; now?: () => Date } = {}): PackLayerStore {
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, o.file ?? "pack-layer.json");
  const now = o.now ?? (() => new Date());
  let versions: PackVersion[] = [];
  let setAside: string | undefined;
  if (existsSync(path)) {
    try {
      const doc = JSON.parse(readFileSync(path, "utf8")) as { versions?: unknown };
      if (!Array.isArray(doc.versions) || doc.versions.some((v) => !v || typeof v !== "object" || !Number.isInteger((v as PackVersion).version) || typeof (v as PackVersion).layer !== "object")) throw new Error("not a list of versions");
      versions = doc.versions as PackVersion[];
    } catch (e) {
      setAside = `${path}.unreadable-${now().toISOString().replace(/[:.]/g, "-")}`;
      try {
        renameSync(path, setAside);
      } catch {
        setAside = undefined;
      }
      o.log?.(`warning: the pack's runtime changes (${path}) could not be read (${e instanceof Error ? e.message : String(e)}); ${setAside ? `set aside as ${setAside}; ` : ""}starting with the deploy config's pack alone`);
    }
  }
  const last = () => versions.at(-1);
  return {
    path,
    ...(setAside ? { setAside } : {}),
    current: () => ({ version: last()?.version ?? 0, layer: last()?.layer ?? {} }),
    versions: () => versions.slice(),
    get: (version) => (version === 0 ? CONFIG_ONLY : versions.find((v) => v.version === version)),
    append(v) {
      const next: PackVersion = { ...v, version: (last()?.version ?? 0) + 1, at: v.at ?? now().toISOString() };
      const kept = [...versions, next].slice(-PACK_VERSIONS_KEPT);
      try {
        writeWhole(path, `${JSON.stringify({ versions: kept }, null, 2)}\n`, 0o600);
      } catch (e) {
        throw new SettingsSaveError(e);
      }
      // Only once it is on disk does the new version count.
      versions = kept;
      return next;
    },
  };
}
