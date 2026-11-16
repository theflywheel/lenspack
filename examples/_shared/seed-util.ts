import type { Writer } from "@lenspack/sql";

export type Dialect = "postgres" | "duckdb" | "mysql" | "sqlite" | "clickhouse";

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

// A JS integer beyond 32 bits (epoch milliseconds, for instance) must be bound
// as a BigInt: DuckDB's binding otherwise narrows it to INTEGER and it wraps.
const bind = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && Math.abs(v) > 2_147_483_647 ? BigInt(v) : v);

/** Multi-row parameterised inserts, batched under Postgres's parameter cap, or the writer's own bulk path. */
export async function insertRows(writer: Writer, table: string, columns: string[], rows: unknown[][]) {
  if (rows.length === 0) return;
  if (writer.insert) return writer.insert(table, columns, rows);
  const perBatch = Math.max(1, Math.floor(30_000 / columns.length));
  for (let i = 0; i < rows.length; i += perBatch) {
    const batch = rows.slice(i, i + perBatch);
    const values: unknown[] = [];
    const tuples = batch.map((row) => `(${row.map((v) => (values.push(bind(v)), `$${values.length}`)).join(", ")})`);
    await writer.exec(`INSERT INTO ${table} (${columns.join(", ")}) VALUES ${tuples.join(", ")}`, values);
  }
}

/** Runs DDL written once, in the portable subset below, translated for the dialect. */
export async function execAll(writer: Writer, statements: string[], dialect?: Dialect) {
  for (const s of statements) await writer.exec(dialect ? ddl(s, dialect) : s);
}

export const json = (dialect: Dialect) => (dialect === "postgres" ? "JSONB" : "JSON");

// The seeds write CREATE TABLE once with INTEGER, BIGINT, DOUBLE PRECISION,
// VARCHAR, BOOLEAN, TIMESTAMP, DATE and JSON. Postgres, DuckDB and SQLite
// take that as written; MySQL wants string lengths and a fractional-second
// DATETIME; ClickHouse wants its own type names, Nullable columns and an engine.
const CLICKHOUSE: Record<string, string> = {
  INTEGER: "Int32",
  BIGINT: "Int64",
  "DOUBLE PRECISION": "Float64",
  VARCHAR: "String",
  BOOLEAN: "Bool",
  TIMESTAMP: "DateTime64(3, 'UTC')",
  DATE: "Date32",
  JSON: "String",
  JSONB: "String",
};

export function ddl(statement: string, dialect: Dialect): string {
  const create = /^\s*CREATE TABLE (\S+) \(([\s\S]*)\)\s*$/i.exec(statement);
  if (!create || dialect === "postgres" || dialect === "duckdb" || dialect === "sqlite") return statement;
  const [, table, body] = create;
  const columns = body!.split(/,(?![^(]*\))/).map((c) => c.trim());
  if (dialect === "mysql")
    return `CREATE TABLE ${table} (${columns.map((c) => c.replace(/\bVARCHAR\b(?!\s*\()/i, "VARCHAR(255)").replace(/\bTIMESTAMP\b/i, "DATETIME(3)")).join(", ")})`;
  const typed = columns.map((c) => {
    const m = /^("[^"]+"|\S+)\s+(DOUBLE PRECISION|\w+)(\s+PRIMARY KEY)?$/i.exec(c);
    if (!m) throw new Error(`ddl: cannot translate column "${c}"`);
    const type = CLICKHOUSE[m[2]!.toUpperCase()];
    if (!type) throw new Error(`ddl: no ClickHouse type for ${m[2]}`);
    return `${m[1]} ${m[3] ? type : `Nullable(${type})`}`;
  });
  return `CREATE TABLE ${table} (${typed.join(", ")}) ENGINE = MergeTree ORDER BY tuple()`;
}
