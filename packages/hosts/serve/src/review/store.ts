import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { SettingsSaveError, writeWhole } from "../settings";

// Where the review's state is kept: the definitions, the open questions, the proposals, the review runs
// and the scheduler's last slot. Each is a named JSON document behind this small interface, so the files
// a single server writes today can become rows in a database that two copies of the server share. Every
// read goes to the store (nothing is cached in the process), and every write says which revision it
// read, so a write based on a copy another server has since changed is refused and retried on the new one.

export class StaleWrite extends Error {}

export type StoredDoc = { text: string; rev: string };

export interface DocStore {
  get(name: string): Promise<StoredDoc | null>;
  /**
   * Writes a document and returns its new revision. ifRev: the revision the write is based on; null means
   * it must not exist yet; undefined writes whatever is there. A mismatch throws StaleWrite.
   */
  put(name: string, text: string, ifRev?: string | null): Promise<string>;
  /** The names that start with prefix, sorted. */
  list(prefix: string): Promise<string[]>;
  remove(name: string): Promise<void>;
}

const revOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
const safeName = (name: string) => {
  if (!/^[\w.-]+(\/[\w.-]+)?$/.test(name) || name.includes("..")) throw new Error(`bad document name ${name}`);
  return name;
};

/**
 * Documents as files in a directory (a name with one slash is a file in a subdirectory), each written whole.
 * The revision check reads the file just before writing it: enough for one server, or several on a shared
 * volume that rarely write the same document at once. A database store makes it a transaction.
 */
export function fileDocs(dir: string): DocStore {
  mkdirSync(dir, { recursive: true });
  const at = (name: string) => join(dir, safeName(name));
  const read = (name: string): StoredDoc | null => {
    const p = at(name);
    if (!existsSync(p)) return null;
    const text = readFileSync(p, "utf8");
    return { text, rev: revOf(text) };
  };
  return {
    get: async (name) => read(name),
    async put(name, text, ifRev) {
      if (ifRev !== undefined && (read(name)?.rev ?? null) !== ifRev) throw new StaleWrite(`${name} changed since it was read`);
      const p = at(name);
      try {
        mkdirSync(dirname(p), { recursive: true });
        writeWhole(p, text);
      } catch (e) {
        throw new SettingsSaveError(e);
      }
      return revOf(text);
    },
    async list(prefix) {
      const slash = prefix.lastIndexOf("/");
      const sub = slash >= 0 ? prefix.slice(0, slash) : "";
      const start = slash >= 0 ? prefix.slice(slash + 1) : prefix;
      const d = sub ? join(dir, safeName(sub)) : dir;
      if (!existsSync(d)) return [];
      return readdirSync(d)
        .filter((f) => f.startsWith(start) && !f.endsWith(".tmp"))
        .sort()
        .map((f) => (sub ? `${sub}/${f}` : f));
    },
    async remove(name) {
      rmSync(at(name), { force: true });
    },
  };
}

/** Documents in memory: for tests, and a server that keeps nothing. */
export function memoryDocs(): DocStore {
  const m = new Map<string, string>();
  return {
    get: async (name) => (m.has(name) ? { text: m.get(name)!, rev: revOf(m.get(name)!) } : null),
    async put(name, text, ifRev) {
      if (ifRev !== undefined && (m.has(name) ? revOf(m.get(name)!) : null) !== ifRev) throw new StaleWrite(`${name} changed since it was read`);
      m.set(name, text);
      return revOf(text);
    },
    list: async (prefix) => [...m.keys()].filter((k) => k.startsWith(prefix)).sort(),
    remove: async (name) => void m.delete(name),
  };
}

/** A JSON document, or the empty value when there is none. */
export async function readDoc<T>(docs: DocStore, name: string, empty: () => T, parse: (raw: unknown) => T = (raw) => raw as T): Promise<{ value: T; rev: string | null }> {
  const d = await docs.get(name);
  return d ? { value: parse(JSON.parse(d.text)), rev: d.rev } : { value: empty(), rev: null };
}

/**
 * Read, change and write one JSON document. fn works on the copy it is given and returns the next value and
 * a result; when another writer got there first, it runs again on the newer copy (a few times at most).
 */
export async function updateDoc<T, R>(docs: DocStore, name: string, empty: () => T, fn: (current: T) => { next: T; result: R }, parse?: (raw: unknown) => T): Promise<R> {
  for (let attempt = 0; ; attempt++) {
    const { value, rev } = await readDoc(docs, name, empty, parse);
    const { next, result } = fn(value);
    try {
      await docs.put(name, JSON.stringify(next, null, 2), rev);
      return result;
    } catch (e) {
      if (!(e instanceof StaleWrite) || attempt >= 4) throw e;
    }
  }
}
