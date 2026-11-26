// The rig a suite runs on: the same createApp the server runs, hosted in this
// process on a loopback port, so a turn gets the production system prompt,
// tools, step limit, refusal guard and metering. Boards live in a memory store:
// nothing is written to the deployment's own store (for Superset: no dashboard
// is touched; queries still go through /api/v1/chart/data).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { dirname, resolve } from "node:path";

import { type BoardConfig, memoryStore } from "@lenspack/core";
import { type Connector, type WidgetData, run } from "@lenspack/engine";
import { type Host, type Identity, type Provider, createApp, resolveSecrets, usageLedger } from "@lenspack/serve";
import type { Pack } from "@lenspack/pack";
import type { UIMessage, UIMessageChunk } from "ai";
import { readUIMessageStream } from "ai";
import YAML from "yaml";

import { overlaps, titleRe } from "./score";
import type { Question } from "./suite";

export type Rig = {
  host: Host;
  /** The board every question starts from (a copy is made per question). */
  seed: BoardConfig | null;
  /** Runs a truth query, when the rig owns its database (the in-repo examples). */
  sql?: (sql: string) => Promise<Record<string, unknown>[]>;
  /**
   * Who the turns run as, when the host applies Superset's access (hostPolicy: superset, or --as-user): the
   * user's Superset dataset access and row-level security narrow every turn, as the Superset host does it.
   */
  user?: { name: string; identity: () => Promise<Identity> };
  close: () => Promise<void>;
};

// ── Superset ─────────────────────────────────────────────────────────────

type SupersetConfig = {
  superset: { url: string; username: string; passwordEnv?: string; password?: string };
  hostPolicy?: string;
  datasets: (number | string)[];
  overlay?: Record<string, unknown>;
};

/**
 * A deployment's Superset config, read the way packages/hosts/superset/bin/serve.ts
 * reads it (same pack, catalogue and connector), with a memory store. The seed
 * board is read from a dashboard once and cached, so later runs start from the
 * same board even if the dashboard changes.
 */
export async function supersetRig(configPath: string, opts: { dashboard?: number; boardCache?: string; now?: Date; supersetUrl?: string; asUser?: string }): Promise<Rig> {
  const sup = await import("@lenspack/superset");
  const raw = YAML.parse(readFileSync(configPath, "utf8")) as SupersetConfig & { superset: { url: unknown } };
  // The deployment's url is usually a compose hostname; the runner may reach Superset elsewhere.
  if (opts.supersetUrl) raw.superset.url = opts.supersetUrl;
  const config = resolveSecrets(raw) as SupersetConfig;
  const password = config.superset.password ?? process.env[config.superset.passwordEnv ?? "LENSPACK_SUPERSET_PASSWORD"];
  if (!password) throw new Error("No Superset password: set the config's passwordEnv variable");
  const client = sup.supersetClient({ url: config.superset.url, username: config.superset.username, password });
  // fetchDatasets checks each dataset is the one asked for and retries a wrong or partial answer.
  const datasets = await sup.fetchDatasets(client, config.datasets, { log: (s) => console.error(`superset rig: ${s}`) });
  const { pack, packYaml, binding } = sup.packFromDatasets(datasets, config.overlay as never);
  const connector = sup.supersetConnector(client, binding);
  let seed: BoardConfig | null = null;
  if (opts.boardCache && existsSync(opts.boardCache)) seed = JSON.parse(readFileSync(opts.boardCache, "utf8")) as BoardConfig;
  else if (opts.dashboard !== undefined) {
    // Read-only: readDashboard GETs the dashboard and its charts.
    const read = await sup.readDashboard(client, opts.dashboard);
    const made = sup.dashboardToBoard(read, pack, binding);
    seed = made.config;
    if (opts.boardCache) writeFileSync(opts.boardCache, JSON.stringify(seed, null, 1));
    for (const n of made.notes) console.error(`seed board: ${n}`);
  }
  const host: Host = { name: pack.pack, pack, packYaml, connector, store: memoryStore(), ctx: opts.now ? { now: opts.now } : {}, boards: [] };
  // The deployment's host policy, read as the Superset host reads it (env first). --as-user implies it: the turns
  // run as that Superset user, asked through the service account, as the host asks for a signed-in user.
  const policy = opts.asUser ? "superset" : sup.hostPolicyFrom(process.env.LENSPACK_HOST_POLICY ?? config.hostPolicy);
  if (policy !== "superset") return { host, seed, close: async () => {} };
  const name = opts.asUser ?? config.superset.username;
  const lookup = sup.supersetPolicy({ client, binding, log: (s: string) => console.error(`host policy: ${s}`) });
  // Edits stay allowed: the suite tests edits, and the Superset host's edit policy is a separate setting.
  const identity = async (): Promise<Identity> => ({ user: name, edit: true, maintain: true, ...(await lookup(name, undefined)) });
  const first = await identity();
  const total = Object.keys(pack.entities).length;
  // A mistyped user (or one with no access at all) would score every question as a refusal: stop instead.
  if ((first.hiddenEntities?.length ?? 0) >= total) throw new Error(`host policy: ${name} may read none of the ${total} datasets (an unknown user, or no dataset access); nothing to evaluate`);
  if (first.hiddenEntities?.length || first.scope?.length) {
    console.error(`host policy: ${name} sees ${total - (first.hiddenEntities?.length ?? 0)} of ${total} datasets; ${first.scope?.length ?? 0} row filter(s)`);
  }
  return { host, seed, user: { name, identity }, close: async () => {} };
}

// ── In-repo examples on DuckDB ───────────────────────────────────────────

export async function exampleRig(name: string, opts: { board?: string; now?: Date }): Promise<Rig> {
  const { SMALL, contextFor, examples, buildBoard } = await import("../examples/index");
  const { sqlConnector } = await import("@lenspack/sql");
  const { openDuckdb } = await import("@lenspack/sql/duckdb");
  const ex = examples[name as keyof typeof examples];
  if (!ex) throw new Error(`no example ${name}`);
  const db = await openDuckdb();
  await ex.seed(db.writer, "duckdb", SMALL[name as keyof typeof SMALL] as never);
  const ctx = { ...contextFor[name as keyof typeof contextFor], ...(opts.now ? { now: opts.now } : {}) };
  const host: Host = { name: ex.pack.pack, pack: ex.pack, packYaml: ex.packYaml, connector: sqlConnector(db.executor) as Connector, store: memoryStore(), ctx, boards: [] };
  const seed = opts.board ? buildBoard(name as never, opts.board) : null;
  const sql = async (q: string) => (await db.executor.query(q, [])) as Record<string, unknown>[];
  return { host, seed, sql, close: () => db.close() };
}

// ── turns ────────────────────────────────────────────────────────────────

export type TurnRecord = {
  reply: string;
  steps: number;
  toolCalls: { tool: string; input: unknown; output?: unknown; error?: string }[];
  usage: { usd: number; inputTokens: number; outputTokens: number; cacheReadTokens?: number; calls: number; unpriced: number; byRole?: Record<string, number> } | null;
  latencyMs: number;
  /** Build rounds the turn ran (2 when the reviewer sent it back for a fix). */
  rounds?: number;
  /** The reviewer's verdicts, one per review it ran (none for a question it skipped). */
  reviews?: { round: number; satisfied: boolean; material: number; minor: number; unavailable?: boolean }[];
  error?: string;
};

export type Server2 = { base: string; close: () => Promise<void>; providers: Provider[] };

export async function serve(rig: Rig, providers: Provider[]): Promise<Server2> {
  const ledger = usageLedger();
  const user = rig.user;
  const server: Server = createServer(createApp([rig.host], { providers, ledger, ...(user ? { access: () => user.identity() } : {}) }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/${rig.host.name}`;
  return { base, providers, close: () => new Promise((r) => server.close(() => r())) };
}

/** A fresh board for one question: a copy of the seed (or empty), with the question's start layout if it has one. */
export async function freshBoard(rig: Rig, id: string, start?: Question["start_layout"]): Promise<BoardConfig> {
  const made = await rig.host.store.create({ id, pack: rig.host.pack, title: rig.seed?.title ?? "Eval" });
  if (!rig.seed) return made.config;
  const config = start ? withLayout(rig.seed, start) : structuredClone(rig.seed);
  const b = await rig.host.store.replaceConfig({ id, config, source: "eval", summary: "seed" });
  return b.config;
}

/** The seed with the named widgets placed as given (stored as is, not repacked). */
export function withLayout(seed: BoardConfig, start: NonNullable<Question["start_layout"]>): BoardConfig {
  const config = structuredClone(seed);
  for (const s of start) {
    const id = Object.keys(config.widgets).find((i) => titleRe(s.title).test(config.widgets[i]!.title ?? ""));
    const item = config.layout.find((l) => l.i === id);
    if (!item) throw new Error(`start_layout: no widget titled ${s.title} on the seed board`);
    Object.assign(item, { x: s.x, y: s.y, w: s.w, h: s.h });
  }
  const over = overlaps(config.layout);
  if (over.length) throw new Error(`start_layout overlaps: ${over.join(", ")}`);
  return config;
}

/** The SSE body of a chat response as UI message chunks. */
async function* chunks(body: ReadableStream<Uint8Array>): AsyncGenerator<UIMessageChunk> {
  const reader = body.pipeThrough(new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const event = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of event.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          yield JSON.parse(data) as UIMessageChunk;
        } catch {
          /* not JSON */
        }
      }
    }
  }
}

/** One chat turn, as the browser sends it: the conversation so far plus the new message. */
export async function chatTurn(srv: Server2, boardId: string, history: UIMessage[], text: string, opts: { model: string; effort?: string; timeoutMs?: number; review?: boolean; reviewer?: string; escalate?: string }): Promise<{ record: TurnRecord; messages: UIMessage[] }> {
  const user: UIMessage = { id: `u${history.length}`, role: "user", parts: [{ type: "text", text }] };
  const messages = [...history, user];
  const started = Date.now();
  // review: as production runs it (the deployment's reviewer, the builder model by default), or off.
  // reviewer / escalate: name the models for those roles (as a deployment's LENSPACK_LLM_ROLES would); the builder's otherwise.
  const params = new URLSearchParams({
    model: opts.model,
    ...(opts.review ? (opts.reviewer ? { review: opts.reviewer } : {}) : { review: "off" }),
    ...(opts.review && opts.escalate ? { escalate: opts.escalate } : {}),
    ...(opts.effort ? { effort: opts.effort } : {}),
  });
  const record: TurnRecord = { reply: "", steps: 0, toolCalls: [], usage: null, latencyMs: 0 };
  try {
    const res = await fetch(`${srv.base}/${boardId}/chat?${params}`, { method: "POST", body: JSON.stringify({ messages }), signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000) });
    if (!res.ok || !res.body) throw new Error(`chat ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const seen: UIMessageChunk[] = [];
    const stream = new ReadableStream<UIMessageChunk>({
      async start(c) {
        for await (const ch of chunks(res.body!)) {
          seen.push(ch);
          c.enqueue(ch);
        }
        c.close();
      },
    });
    let last: UIMessage | undefined;
    for await (const m of readUIMessageStream({ stream })) last = m;
    for (const ch of seen) {
      const c = ch as { type: string; [k: string]: unknown };
      if (c.type === "start-step") record.steps++;
      else if (c.type === "error") record.error = String(c.errorText ?? "error");
      else if (c.type === "data-usage") {
        const data = c.data as { total?: Record<string, number>; models?: { role: string; usd?: number }[] };
        const total = data.total ?? {};
        const byRole: Record<string, number> = {};
        for (const m of data.models ?? []) byRole[m.role] = (byRole[m.role] ?? 0) + (m.usd ?? 0);
        record.usage = { usd: total.usd ?? 0, inputTokens: total.inputTokens ?? 0, outputTokens: total.outputTokens ?? 0, cacheReadTokens: total.cachedInputTokens, calls: total.calls ?? 0, unpriced: total.unpriced ?? 0, byRole };
      } else if (c.type === "data-round") record.rounds = Math.max(record.rounds ?? 0, (c.data as { round?: number }).round ?? 0);
      else if (c.type === "data-review") {
        const v = c.data as { round?: number; satisfied?: boolean; unavailable?: boolean; findings?: { severity?: string }[] };
        const f = v.findings ?? [];
        (record.reviews ??= []).push({ round: v.round ?? 0, satisfied: !!v.satisfied, material: f.filter((x) => x.severity === "material").length, minor: f.filter((x) => x.severity !== "material").length, ...(v.unavailable ? { unavailable: true } : {}) });
      }
    }
    const byId = new Map<string, TurnRecord["toolCalls"][number]>();
    for (const ch of seen) {
      const c = ch as { type: string; toolCallId?: string; toolName?: string; input?: unknown; output?: unknown; errorText?: string };
      if (c.type === "tool-input-available" && c.toolCallId) {
        const t = { tool: c.toolName ?? "?", input: c.input };
        byId.set(c.toolCallId, t);
        record.toolCalls.push(t);
      } else if (c.type === "tool-output-available" && c.toolCallId) {
        const t = byId.get(c.toolCallId);
        if (t) t.output = c.output;
      } else if ((c.type === "tool-output-error" || c.type === "tool-input-error") && c.toolCallId) {
        const t = byId.get(c.toolCallId) ?? { tool: c.toolName ?? "?", input: c.input };
        t.error = c.errorText;
        if (!byId.has(c.toolCallId)) record.toolCalls.push(t);
      }
    }
    record.reply = (last?.parts ?? []).filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n").trim();
    record.latencyMs = Date.now() - started;
    return { record, messages: last ? [...messages, last] : messages };
  } catch (e) {
    record.error = e instanceof Error ? e.message : String(e);
    record.latencyMs = Date.now() - started;
    return { record, messages };
  }
}

/** The data a widget draws, run through the rig's connector (as the board would). */
export async function widgetData(rig: Rig, query: unknown): Promise<WidgetData | null> {
  try {
    return await run(query as never, { pack: rig.host.pack as Pack, connector: rig.host.connector, ctx: rig.host.ctx });
  } catch {
    return null;
  }
}

export const dirOf = (p: string) => dirname(resolve(p));
