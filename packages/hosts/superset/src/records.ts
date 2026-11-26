import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import type { RecordStore } from "@lenspack/core";

// A RecordStore in one JSON file in the state directory: { id: record }. Every call reads the file, so two
// copies of the server on one shared volume see each other's writes; a write is a whole new file renamed into
// place, so a reader never sees half of one. Writes from one process are queued; two processes writing at
// the same instant can still lose one write, which is why a deployment with replicas should use a database
// store behind the same interface (the interface is all the rest of the code knows).

export function fileRecords<T>(file: string, log: (line: string) => void = () => {}): RecordStore<T> {
  let queue: Promise<unknown> = Promise.resolve();
  const read = (): Record<string, T> => {
    if (!existsSync(file)) return {};
    try {
      const v = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, T>;
      throw new Error("not a JSON object");
    } catch (e) {
      // Set aside, never overwritten: someone can still read it back.
      const aside = `${file}.unreadable-${Date.now()}`;
      try {
        renameSync(file, aside);
      } catch {
        /* read-only: leave it */
      }
      log(`could not read ${file} (${e instanceof Error ? e.message : String(e)}); set aside as ${aside}`);
      return {};
    }
  };
  const write = (all: Record<string, T>) => {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
  };
  const change = <R>(f: (all: Record<string, T>) => R): Promise<R> => {
    const next = queue.then(() => {
      const all = read();
      const r = f(all);
      write(all);
      return r;
    });
    queue = next.catch(() => undefined);
    return next;
  };
  return {
    list: async () => Object.values(read()),
    get: async (id) => read()[id] ?? null,
    put: (id, value) => change((all) => void (all[id] = value)),
    delete: (id) =>
      change((all) => {
        const had = id in all;
        delete all[id];
        return had;
      }),
  };
}
