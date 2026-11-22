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
import { type Host, type Provider, createApp, usageLedger } from "@lenspack/serve";
import type { Pack } from "@lenspack/spec";
import type { UIMessage, UIMessageChunk } from "ai";
import { readUIMessageStream } from "ai";
import YAML from "yaml";

export type Rig = {
  host: Host;
  /** The board every question starts from (a copy is made per question). */
  seed: BoardConfig | null;
  /** Runs a truth query, when the rig owns its database (the in-repo examples). */
  sql?: (sql: string) => Promise<Record<string, unknown>[]>;
  close: () => Promise<void>;
};

// ── Superset ─────────────────────────────────────────────────────────────

type SupersetConfig = {
  superset: { url: string; username: string; passwordEnv?: string; password?: string };
  datasets: (number | string)[];
  overlay?: Record<string, unknown>;
};

const fromEnv = (v: unknown, file: string): unknown => {
  if (typeof v === "string" && v.startsWith("env:")) {
    const value = process.env[v.slice(4)];
    if (value === undefined) throw new Error(`${file}: environment variable ${v.slice(4)} is not set`);
    return value;
  }
  if (Array.isArray(v)) return v.map((x) => fromEnv(x, file));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fromEnv(x, file)]));
  return v;
};

/**
 * A deployment's Superset config, read the way packages/superset/bin/serve.ts
 * reads it (same pack, catalogue and connector), with a memory store. The seed
 * board is read from a dashboard once and cached, so later runs start from the
 * same board even if the dashboard changes.
 */
export async function supersetRig(configPath: string, opts: { dashboard?: number; boardCache?: string; now?: Date; supersetUrl?: string }): Promise<Rig> {
  const sup = await import("@lenspack/superset");
  const file = resolve(configPath);
  const raw = YAML.parse(readFileSync(file, "utf8")) as SupersetConfig & { superset: { url: unknown } };
  // The deployment's url is usually a compose hostname; the runner may reach Superset elsewhere.
  if (opts.supersetUrl) raw.superset.url = opts.supersetUrl;
  const config = fromEnv(raw, file) as SupersetConfig;
  const password = config.superset.password ?? process.env[config.superset.passwordEnv ?? "LENSPACK_SUPERSET_PASSWORD"];
  if (!password) throw new Error("No Superset password: set the config's passwordEnv variable");
  const client = sup.supersetClient({ url: config.superset.url, username: config.superset.username, password });
  // Under load the dataset lookup has returned the wrong dataset for a name (2026-11-22: ni_members came
  // back as ni_referrals, and the pack silently lost an entity). Check each one and retry the batch.
  const want = (ref: number | string) => (typeof ref === "number" || /^\d+$/.test(String(ref)) ? null : String(ref).split(".").at(-1)!);
  let datasets: Awaited<ReturnType<typeof sup.fetchDatasets>> = [];
  for (let attempt = 1; ; attempt++) {
    try {
      datasets = await sup.fetchDatasets(client, config.datasets);
      const wrong = config.datasets.map((ref, i) => [ref, datasets[i]?.table_name] as const).filter(([ref, got]) => want(ref) !== null && got !== want(ref));
      const ids = new Set(datasets.map((d) => d.id));
      if (wrong.length === 0 && ids.size === datasets.length) break;
      throw new Error(`datasets came back wrong: ${wrong.map(([r, g]) => `${r} -> ${g}`).join(", ") || "duplicate ids"}`);
    } catch (e) {
      if (attempt >= 5) throw e;
      console.error(`superset rig: ${(e as Error).message}; retrying (${attempt}/5)`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
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
  return { host, seed, close: async () => {} };
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
  usage: { usd: number; inputTokens: number; outputTokens: number; cacheReadTokens?: number; calls: number; unpriced: number } | null;
  latencyMs: number;
  error?: string;
};

export type Server2 = { base: string; close: () => Promise<void>; providers: Provider[] };

export async function serve(rig: Rig, providers: Provider[]): Promise<Server2> {
  const ledger = usageLedger();
  const server: Server = createServer(createApp([rig.host], { providers, ledger }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/${rig.host.name}`;
  return { base, providers, close: () => new Promise((r) => server.close(() => r())) };
}

/** A fresh board for one question: a copy of the seed (or empty). */
export async function freshBoard(rig: Rig, id: string): Promise<BoardConfig> {
  const made = await rig.host.store.create({ id, pack: rig.host.pack, title: rig.seed?.title ?? "Eval" });
  if (!rig.seed) return made.config;
  const b = await rig.host.store.replaceConfig({ id, config: structuredClone(rig.seed), source: "eval", summary: "seed" });
  return b.config;
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
export async function chatTurn(srv: Server2, boardId: string, history: UIMessage[], text: string, opts: { model: string; effort?: string; timeoutMs?: number }): Promise<{ record: TurnRecord; messages: UIMessage[] }> {
  const user: UIMessage = { id: `u${history.length}`, role: "user", parts: [{ type: "text", text }] };
  const messages = [...history, user];
  const started = Date.now();
  const params = new URLSearchParams({ model: opts.model, review: "off", ...(opts.effort ? { effort: opts.effort } : {}) });
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
        const total = (c.data as { total?: Record<string, number> }).total ?? {};
        record.usage = { usd: total.usd ?? 0, inputTokens: total.inputTokens ?? 0, outputTokens: total.outputTokens ?? 0, cacheReadTokens: total.cachedInputTokens, calls: total.calls ?? 0, unpriced: total.unpriced ?? 0 };
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
