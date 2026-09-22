import type { Executor, Row } from "./executor";

// Keyed on the exact statement and its parameters, which already include the
// tenant and the resolved time window; the pack version is in the prefix so a
// pack edit invalidates everything at once.

export interface Cache {
  get(key: string): Promise<Row[] | undefined>;
  set(key: string, rows: Row[], ttlMs: number): Promise<void>;
}

export function memoryCache(max = 500): Cache {
  const entries = new Map<string, { rows: Row[]; expires: number }>();
  return {
    async get(key) {
      const hit = entries.get(key);
      if (!hit) return undefined;
      if (hit.expires < Date.now()) {
        entries.delete(key);
        return undefined;
      }
      // Refresh recency.
      entries.delete(key);
      entries.set(key, hit);
      return hit.rows;
    },
    async set(key, rows, ttlMs) {
      entries.set(key, { rows, expires: Date.now() + ttlMs });
      while (entries.size > max) entries.delete(entries.keys().next().value!);
    },
  };
}

export function cachedExecutor(inner: Executor, opts: { cache?: Cache; ttlMs?: number; prefix?: string } = {}): Executor {
  const cache = opts.cache ?? memoryCache();
  const ttl = opts.ttlMs ?? 60_000;
  const prefix = opts.prefix ?? "";
  return {
    dialect: inner.dialect,
    async query(sql, params, o) {
      const key = `${prefix}|${sql}|${JSON.stringify(params)}`;
      const hit = await cache.get(key);
      if (hit) return hit;
      const rows = await inner.query(sql, params, o);
      await cache.set(key, rows, ttl);
      return rows;
    },
  };
}
