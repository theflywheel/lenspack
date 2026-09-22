import type { Writer } from "@lenspack/sql";

export type Dialect = "postgres" | "duckdb";

/** Deterministic PRNG (mulberry32) so every seed produces the same rows. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
    weighted: <T>(items: readonly (readonly [T, number])[]): T => {
      const total = items.reduce((s, [, w]) => s + w, 0);
      let r = next() * total;
      for (const [item, w] of items) {
        r -= w;
        if (r <= 0) return item;
      }
      return items[items.length - 1]![0];
    },
    chance: (p: number) => next() < p,
  };
}

/** Naive UTC timestamp text both engines accept for a TIMESTAMP column. */
export function ts(d: Date) {
  return d.toISOString().replace("T", " ").replace("Z", "").slice(0, 19);
}

export function daysAgo(base: Date, days: number) {
  return new Date(base.getTime() - days * 86400e3);
}

/** Multi-row parameterised inserts, batched under Postgres's parameter cap. */
export async function insertRows(writer: Writer, table: string, columns: string[], rows: unknown[][]) {
  if (rows.length === 0) return;
  const perBatch = Math.max(1, Math.floor(30_000 / columns.length));
  for (let i = 0; i < rows.length; i += perBatch) {
    const batch = rows.slice(i, i + perBatch);
    const values: unknown[] = [];
    const tuples = batch.map((row) => `(${row.map((v) => (values.push(v), `$${values.length}`)).join(", ")})`);
    await writer.exec(`INSERT INTO ${table} (${columns.join(", ")}) VALUES ${tuples.join(", ")}`, values);
  }
}

export async function execAll(writer: Writer, statements: string[]) {
  for (const s of statements) await writer.exec(s);
}

export const json = (dialect: Dialect) => (dialect === "postgres" ? "JSONB" : "JSON");
