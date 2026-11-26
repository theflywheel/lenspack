import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { type BoardStore, memoryStore } from "@lenspack/core";
import { elasticsearchConnector } from "@lenspack/elasticsearch";
import { type Connector, check } from "@lenspack/engine";
import { fileProposals } from "@lenspack/agent";
import { parsePackText } from "@lenspack/pack";
import { type Executor, type Writer, driverFor, filePath, openSource, sqlStore } from "@lenspack/sql";
import YAML from "yaml";
import { z } from "zod";

import type { BoardFile, Host } from "./app";
import { deploymentContextSchema } from "@lenspack/policy";

import { authSchema, hiddenKeys, packRuleSchema } from "./auth";

// lenspack.yaml: which sources exist, which pack reads which source, and where
// boards are kept. Secrets are never written here — only `env:NAME`, read from
// the environment when the server starts.
//
//   sources:
//     shop:   { url: env:DATABASE_URL }            # postgres://, mysql://, clickhouse://, …
//     local:  { url: "duckdb:./data/shop.duckdb" }  # relative to this file
//     search: { kind: elasticsearch, url: env:ES_URL, apiKey: env:ES_API_KEY }
//   packs:
//     - { pack: ./packs/campaign/pack.yaml, source: search, boards: ./packs/campaign/boards }
//   store: { kind: duckdb, path: ./data/boards.duckdb }
//
// A SQL source is a connection URL and its scheme picks the driver; `kind:`
// may still be written, and must then agree. Elasticsearch stays a connector
// of its own: its SQL API cannot join, and the native one is proven in CI.

const secret = z.string().min(1);
// optional: a file database that is not there is skipped, with every pack on it, instead of stopping the server.
const limits = { timeoutMs: z.number().int().positive().optional(), maxRows: z.number().int().positive().optional(), cacheTtlMs: z.number().int().positive().optional(), optional: z.boolean().optional() };
const SEARCH = ["elasticsearch", "opensearch"];
const sourceSchema = z.union([
  z.object({ kind: z.literal("elasticsearch"), url: secret, apiKey: secret.optional(), username: secret.optional(), password: secret.optional(), timeoutMs: z.number().int().positive().optional() }),
  z.object({ kind: z.literal("opensearch"), url: secret, username: secret.optional(), password: secret.optional(), timeoutMs: z.number().int().positive().optional() }),
  z.object({ kind: z.string().refine((k) => !SEARCH.includes(k)).optional(), url: secret, ...limits }),
  // The form before URLs: a DuckDB or SQLite file by path.
  z.object({ kind: z.enum(["duckdb", "sqlite"]), path: z.string().min(1), ...limits }),
]);

/** `explain:` in lenspack.yaml or superset.yaml. */
export const explainSchema = z.union([z.boolean(), z.object({ sql: z.boolean().optional() }).strict()]);
export type ExplainConfig = z.infer<typeof explainSchema>;

/** The config's explain setting as the board API reads it: on unless false, the SQL shown unless sql is false. */
export const explainFrom = (c: ExplainConfig | undefined): { on: boolean; sql: boolean } => ({ on: c !== false, sql: !(typeof c === "object" && c.sql === false) });

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
        /** Who may open this pack and what of it they see, by role; first match wins. Absent: everyone signed in sees all of it. */
        access: z.array(packRuleSchema).min(1).optional(),
      }),
    )
    .min(1),
  store: z.union([z.object({ kind: z.literal("memory") }), z.object({ kind: z.literal("duckdb"), path: z.string().min(1) }), z.object({ kind: z.literal("postgres"), url: secret })]).default({ kind: "memory" }),
  /**
   * The bundled UI: its directory, or how it presents itself. home
   * ("pack/board") is the board "/" opens; title names the page; intro is the
   * deployment's own line under a board's title. mode is accepted and ignored:
   * the demo's landing page is gone, so every UI is the app.
   */
  ui: z
    .union([
      z.string(),
      z.object({
        dir: z.string().optional(),
        mode: z.enum(["demo", "app"]).optional(),
        title: z.string().max(80).optional(),
        home: z.string().regex(/^[a-z][a-z0-9_-]*\/[^/]+$/).optional(),
        intro: z.string().max(600).optional(),
      }),
    ])
    .optional(),
  port: z.number().int().positive().optional(),
  /**
   * How callers sign in. Absent: `password`, the built-in admin. `{ kind:
   * none }` is open, for a local demo; LENSPACK_AUTH overrides the kind.
   */
  auth: authSchema.optional(),
  /** Interface to listen on; defaults to 127.0.0.1 when open (none), 0.0.0.0 with a sign-in. */
  host: z.string().optional(),
  /** Append a JSON line per change, refusal and denial to this file. */
  audit: z.string().optional(),
  /** Usage telemetry (docs/telemetry.md): telemetry.jsonl in dir (relative to this file), kept retentionDays; questionText false keeps a hash of each question instead of its words. */
  telemetry: z
    .object({
      dir: z.string().min(1),
      retentionDays: z.number().int().min(1).max(3650).default(90),
      questionText: z.boolean().default(true),
    })
    .optional(),
  /** The deployment's context (@lenspack/policy): what a board, dataset or role:<name> belongs to (campaign, campaignType, country). */
  context: deploymentContextSchema.optional(),
  /** Append a JSON line per model call (tokens, US$, who, what for) to this file; today's totals are read back at startup. */
  usage: z.string().optional(),
  /** Daily caps (UTC) on priced model spend, in US$. Over one, chat answers 429 until midnight UTC. */
  budget: z.object({ usdPerDay: z.number().positive().optional(), usdPerUserPerDay: z.number().positive().optional() }).strict().optional(),
  /** How many of the latest user turns the chat model is sent (default 8). */
  historyTurns: z.number().int().positive().optional(),
  /**
   * Saved answers (docs/caching.md): `true`, or the store's file (default reuse.json beside this file) and its
   * settings. Absent, every question runs the full assistant.
   */
  cache: z
    .union([
      z.boolean(),
      z.object({ file: z.string().optional(), enabled: z.boolean().optional(), ttlHours: z.number().optional(), router: z.enum(["on", "off"]).optional(), maxEntries: z.number().int().optional(), freshMinutes: z.number().optional(), prewarm: z.record(z.unknown()).optional() }).strict(),
    ])
    .optional(),
  /** The turn queue (docs/caching.md): { maxConcurrent, maxWaiting, maxWaitSeconds }. Absent: 8 at a time, 50 waiting, 60 s. */
  queue: z.object({ maxConcurrent: z.number().int().optional(), maxWaiting: z.number().int().optional(), maxWaitSeconds: z.number().int().optional() }).strict().optional(),
  /** "How this was worked out" under each answer: false turns it off; `{ sql: false }` keeps the words and rows but not the SQL. */
  explain: explainSchema.optional(),
  /** Directory for each pack's <name>.proposals.json; defaults to this file's, which may be read-only (a mounted ConfigMap). */
  proposals: z.string().optional(),
  /**
   * A writable directory for the server's own state: its switches, the admins' definitions overlay, open questions and
   * the daily review. With it, the admin panel is served at /_lenspack/admin/ (maintainers only), and the audit log is kept there
   * by month unless audit: names a file.
   */
  state: z.string().optional(),
  /** Switches (see features.ts): on or off by name; the admin panel can change them while the server runs. */
  features: z.record(z.boolean()).optional(),
});
export type LenspackConfig = z.infer<typeof configSchema>;

/** `env:NAME` → the variable's value; a missing variable is an error, and so is an empty one unless allowEmpty. */
export function resolveSecrets<T>(value: T, env = process.env, o: { file?: string; allowEmpty?: boolean } = {}): T {
  if (typeof value === "string" && value.startsWith("env:")) {
    const name = value.slice(4);
    const v = env[name];
    if (v === undefined || (v === "" && !o.allowEmpty)) throw new Error(`${o.file ?? "lenspack.yaml"} refers to env:${name}, which is not set`);
    return v as T;
  }
  if (Array.isArray(value)) return value.map((v) => resolveSecrets(v, env, o)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveSecrets(v, env, o)])) as T;
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
export async function openConfig(config: LenspackConfig, dir: string, env = process.env): Promise<{ hosts: Host[]; sources: Map<string, Connector>; close(): Promise<void> }> {
  const at = (p: string) => (isAbsolute(p) ? p : join(dir, p));
  const closers: (() => Promise<void>)[] = [];
  const connectors = new Map<string, Connector>();
  const skipped = new Set<string>();
  for (const [name, raw] of Object.entries(config.sources)) {
    const src = resolveSecrets(raw, env);
    if (src.kind === "elasticsearch" || src.kind === "opensearch") {
      const es = src as { url: string; apiKey?: string; username?: string; password?: string; timeoutMs?: number };
      connectors.set(name, elasticsearchConnector({ url: es.url, apiKey: es.apiKey, username: es.username, password: es.password, defaultTimeoutMs: es.timeoutMs }));
      continue;
    }
    const url = "url" in src ? src.url : `${src.kind}:${at(src.path)}`;
    const driver = driverFor(url);
    if (src.kind && src.kind !== driver.name && !driver.schemes.includes(src.kind))
      throw new Error(`source "${name}" says kind: ${src.kind}, but its URL is a ${driver.name} URL`);
    const file = ["duckdb", "sqlite"].includes(driver.name) ? filePath(url, dir) : ":memory:";
    if ("optional" in src && src.optional && file !== ":memory:" && !existsSync(file)) {
      console.warn(`lenspack: source "${name}" has no ${file}, so it and its packs are skipped`);
      skipped.add(name);
      continue;
    }
    const { connector, connection } = await openSource(url, { base: dir, defaultTimeoutMs: src.timeoutMs, maxRows: "maxRows" in src ? src.maxRows : undefined, cacheTtlMs: "cacheTtlMs" in src ? src.cacheTtlMs : undefined });
    closers.push(connection.close);
    connectors.set(name, connector);
  }

  // Boards live apart from the data: a pack's source is read-only to lenspack.
  // Each pack gets its own store, or its own space in a shared database: a pack
  // lists only its boards, and two packs' boards with one id stay two boards.
  let store: (name: string) => BoardStore;
  if (config.store.kind === "memory") {
    store = () => memoryStore();
  } else {
    const s = resolveSecrets(config.store, env);
    const db = await openSql(s.kind, s.kind === "duckdb" ? at(s.path) : s.url);
    closers.push(() => db.close());
    await sqlStore(db).migrate();
    store = (name) => sqlStore(db, { space: name });
  }

  const hosts: Host[] = [];
  for (const p of config.packs) {
    const connector = connectors.get(p.source);
    if (!connector && skipped.has(p.source)) continue;
    if (!connector) throw new Error(`pack ${p.pack} names source "${p.source}", which lenspack.yaml does not define`);
    const packYaml = readFileSync(at(p.pack), "utf8");
    const pack = parsePackText(packYaml);
    // An example the source would refuse must not be shown to the model as
    // checked. Nothing runs, so a stand-in tenant serves an unpinned pack.
    for (const [i, ex] of pack.examples.entries()) {
      try {
        check(ex.query, pack, { ctx: { tenant: p.tenant ?? "_" }, capabilities: connector.capabilities });
      } catch (e) {
        throw new Error(`pack ${p.pack} examples[${i}] ("${ex.question}"): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // A rule naming a key the pack does not have stops the server here, not at the first request.
    for (const rule of p.access ?? []) hiddenKeys(pack, rule);
    const name = p.name ?? pack.pack;
    hosts.push({
      name,
      pack,
      packYaml,
      connector,
      store: store(name),
      ctx: { ...(p.tenant ? { tenant: p.tenant } : {}), ...(p.now ? { now: new Date(p.now) } : {}) },
      boards: p.boards ? readBoards(at(p.boards)) : [],
      proposals: fileProposals(at(join(config.proposals ?? ".", `${name}.proposals.json`))),
      ...(p.access ? { access: p.access } : {}),
    });
  }
  return { hosts, sources: connectors, close: async () => void (await Promise.all(closers.map((c) => c()))) };
}
