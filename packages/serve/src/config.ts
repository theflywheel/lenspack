import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { type BoardStore, memoryStore } from "@lenspack/core";
import { elasticsearchConnector } from "@lenspack/elasticsearch";
import type { Connector } from "@lenspack/engine";
import { fileProposals } from "@lenspack/mcp";
import { parsePackText } from "@lenspack/spec";
import { type Executor, type Writer, sqlConnector, sqlStore } from "@lenspack/sql";
import YAML from "yaml";
import { z } from "zod";

import type { BoardFile, Host } from "./app";

// lenspack.yaml: which sources exist, which pack reads which source, and where
// boards are kept. Secrets are never written here — only `env:NAME`, read from
// the environment when the server starts.
//
//   sources:
//     search: { kind: elasticsearch, url: env:ES_URL, apiKey: env:ES_API_KEY }
//     local:  { kind: duckdb, path: ./data/shop.duckdb }
//   packs:
//     - { pack: ./packs/campaign/pack.yaml, source: search, boards: ./packs/campaign/boards }
//   store: { kind: duckdb, path: ./data/boards.duckdb }

const secret = z.string().min(1);
const sourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("elasticsearch"), url: secret, apiKey: secret.optional(), username: secret.optional(), password: secret.optional(), timeoutMs: z.number().int().positive().optional() }),
  z.object({ kind: z.literal("opensearch"), url: secret, username: secret.optional(), password: secret.optional(), timeoutMs: z.number().int().positive().optional() }),
  z.object({ kind: z.literal("postgres"), url: secret }),
  z.object({ kind: z.literal("duckdb"), path: z.string().min(1) }),
]);

export const configSchema = z.object({
  sources: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), sourceSchema),
  packs: z
    .array(
      z.object({
        pack: z.string().min(1),
        source: z.string(),
        name: z.string().regex(/^[a-z][a-z0-9_-]*$/).optional(),
        boards: z.string().optional(),
        tenant: z.string().optional(),
        /** Pin "now" (for fixed demo data); otherwise the clock. */
        now: z.string().datetime({ offset: true }).optional(),
      }),
    )
    .min(1),
  store: z.union([z.object({ kind: z.literal("memory") }), z.object({ kind: z.literal("duckdb"), path: z.string().min(1) }), z.object({ kind: z.literal("postgres"), url: secret })]).default({ kind: "memory" }),
  ui: z.string().optional(),
  port: z.number().int().positive().optional(),
});
export type LenspackConfig = z.infer<typeof configSchema>;

/** `env:NAME` → the variable's value; a missing variable is an error, not an empty string. */
export function resolveSecrets<T>(value: T, env = process.env): T {
  if (typeof value === "string" && value.startsWith("env:")) {
    const name = value.slice(4);
    const v = env[name];
    if (v === undefined || v === "") throw new Error(`lenspack.yaml refers to env:${name}, which is not set`);
    return v as T;
  }
  if (Array.isArray(value)) return value.map((v) => resolveSecrets(v, env)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveSecrets(v, env)])) as T;
  return value;
}

export function readConfig(path: string): { config: LenspackConfig; dir: string } {
  const parsed = configSchema.parse(YAML.parse(readFileSync(path, "utf8")));
  return { config: parsed, dir: dirname(resolve(path)) };
}

type Sql = { executor: Executor; writer: Writer; dialect: "postgres" | "duckdb"; close(): Promise<void> };

async function openSql(kind: "postgres" | "duckdb", target: string): Promise<Sql> {
  if (kind === "postgres") return (await import("@lenspack/sql/pg")).openPostgres(target);
  return (await import("@lenspack/sql/duckdb")).openDuckdb(target);
}

export function readBoards(dir: string): BoardFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({ id: f.replace(/\.json$/, ""), ...(JSON.parse(readFileSync(join(dir, f), "utf8")) as { title: string; ops: unknown[] }) }));
}

/** Opens every source and store a config names, and binds each pack to its source. */
export async function openConfig(config: LenspackConfig, dir: string, env = process.env): Promise<{ hosts: Host[]; close(): Promise<void> }> {
  const at = (p: string) => (isAbsolute(p) ? p : join(dir, p));
  const closers: (() => Promise<void>)[] = [];
  const connectors = new Map<string, Connector>();
  for (const [name, raw] of Object.entries(config.sources)) {
    const src = resolveSecrets(raw, env);
    if (src.kind === "elasticsearch" || src.kind === "opensearch") {
      connectors.set(name, elasticsearchConnector({ url: src.url, apiKey: "apiKey" in src ? src.apiKey : undefined, username: src.username, password: src.password, defaultTimeoutMs: src.timeoutMs }));
    } else {
      const db = await openSql(src.kind, src.kind === "duckdb" ? at(src.path) : src.url);
      closers.push(() => db.close());
      connectors.set(name, sqlConnector(db.executor));
    }
  }

  // Boards live apart from the data: a pack's source is read-only to lenspack.
  let store: () => BoardStore;
  if (config.store.kind === "memory") {
    const shared = memoryStore();
    store = () => shared;
  } else {
    const s = resolveSecrets(config.store, env);
    const db = await openSql(s.kind, s.kind === "duckdb" ? at(s.path) : s.url);
    closers.push(() => db.close());
    const shared = sqlStore(db);
    await shared.migrate();
    store = () => shared;
  }

  const hosts: Host[] = [];
  for (const p of config.packs) {
    const connector = connectors.get(p.source);
    if (!connector) throw new Error(`pack ${p.pack} names source "${p.source}", which lenspack.yaml does not define`);
    const packYaml = readFileSync(at(p.pack), "utf8");
    const pack = parsePackText(packYaml);
    const name = p.name ?? pack.pack;
    hosts.push({
      name,
      pack,
      packYaml,
      connector,
      store: store(),
      ctx: { ...(p.tenant ? { tenant: p.tenant } : {}), ...(p.now ? { now: new Date(p.now) } : {}) },
      boards: p.boards ? readBoards(at(p.boards)) : [],
      proposals: fileProposals(at(`${name}.proposals.json`)),
    });
  }
  return { hosts, close: async () => void (await Promise.all(closers.map((c) => c()))) };
}
