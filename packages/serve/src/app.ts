import { existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";

import { type ToolSet, type UIMessage, convertToModelMessages, createUIMessageStream, createUIMessageStreamResponse, stepCountIs, streamText } from "ai";

import { type BoardConfig, type BoardOp, type BoardStore, type Catalogue, applyOps, boardConfigSchema, emptyBoard, opSchema, querySchema, summarise } from "@lenspack/core";
import { type Connector, type Ctx, ResolveError, checkOps, dimensionValues, explain, resolveBoard } from "@lenspack/engine";
import { type ProposalStore, boardTools, toVercelAI } from "@lenspack/mcp";
import { type Pack, catalogueFrom } from "@lenspack/spec";

import { type Provider, publicView, stopOnRepeatedRefusals } from "./llm";
import { SYSTEM } from "./prompt";
import { healingPrompt, refusalsFrom, reviewTurn } from "./review";

// The board API that @lenspack/react's host callbacks talk to, for any number
// of packs, each bound to its own source. Nothing here knows which backend a
// pack runs on: it holds a Connector.

/**
 * A board as ops, and optionally the exact grid it was designed on: a
 * layout (coordinates per widget) and grid settings a migrated dashboard
 * must keep to match the original.
 */
export type BoardFile = { id: string; title: string; ops: unknown[]; layout?: { i: string; x: number; y: number; w: number; h: number }[]; grid?: { cols?: number; rowHeight?: number } };

export type Host = {
  name: string;
  pack: Pack;
  packYaml: string;
  connector: Connector;
  store: BoardStore;
  ctx: Ctx;
  boards: BoardFile[];
  proposals?: ProposalStore;
  catalogue?: Catalogue;
};

export type AppOptions = {
  /** A built client to serve for every non-API path (single-page fallback to index.html). */
  ui?: string;
  providers?: Provider[];
  /** `{ reviewer, escalate }` provider names. */
  roles?: { reviewer?: string; escalate?: string };
  log?: (line: string) => void;
};

/** Builds a board from a pack's ops file — the same path the model uses. */
export function buildBoard(pack: Pack, file: BoardFile): BoardConfig {
  const ops = file.ops.map((op) => opSchema.parse(op)) as BoardOp[];
  const result = applyOps(emptyBoard(pack, file.title), ops, catalogueFrom(pack));
  if (!result.ok) throw new Error(`Board ${pack.pack}/${file.id} op ${result.opIndex}: ${result.error}${result.hint ? ` (${result.hint})` : ""}`);
  const config = boardConfigSchema.parse({
    ...result.config,
    ...(file.grid ? { grid: { ...result.config.grid, ...file.grid } } : {}),
    ...(file.layout ? { layout: file.layout.filter((l) => result.config.widgets[l.i]) } : {}),
  });
  return config;
}

/** Creates each pack's boards in its store if they are not there yet. */
export async function seedBoards(host: Host) {
  for (const b of host.boards) if (!(await host.store.get(b.id))) await host.store.create({ id: b.id, pack: host.pack, title: b.title, config: buildBoard(host.pack, b) });
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const read = (req: IncomingMessage) =>
  new Promise<unknown>((resolve, reject) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch (e) {
        reject(e);
      }
    });
  });

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2" };

function serveStatic(root: string, pathname: string, res: ServerResponse) {
  const safe = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(root, safe);
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) file = join(root, "index.html");
  if (!existsSync(file)) return json(res, 404, { error: "not found" });
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}

export function createApp(hosts: Host[], opts: AppOptions = {}) {
  const byName = new Map(hosts.map((h) => [h.name, { ...h, catalogue: h.catalogue ?? catalogueFrom(h.pack) }]));
  const providers = opts.providers ?? [];
  const defaultProvider = () => providers.find((p) => p.available) ?? providers.find((p) => p.available === null) ?? null;
  const provider = (name: string | null | undefined) => (name ? providers.find((p) => p.name === name && p.available !== false) : undefined);

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://x");
    const [, api, packName, boardId, action] = url.pathname.split("/");
    try {
      if (api !== "api") return opts.ui ? serveStatic(opts.ui, url.pathname, res) : json(res, 404, { error: "not found" });
      if (!packName) {
        const list = await Promise.all(
          [...byName.values()].map(async (h) => ({ example: h.name, source: h.connector.kind, description: h.pack.description, boards: await h.store.list() })),
        );
        return json(res, 200, { examples: list, chat: providers.length > 0, models: providers.map(publicView) });
      }
      const h = byName.get(packName);
      if (!h) return json(res, 404, { error: "no such pack" });
      const catalogue = h.catalogue;
      const run = { pack: h.pack, connector: h.connector, ctx: h.ctx };
      if (!boardId) return json(res, 200, { example: h.name, pack: h.pack.pack, source: h.connector.kind, description: h.pack.description, boards: await h.store.list(), catalogue });
      if (boardId === "pack") return json(res, 200, { yaml: h.packYaml });
      // Compile one query without running it: the real native query, or the
      // real refusal.
      if (boardId === "explain" && req.method === "GET") {
        try {
          const query = querySchema.parse(JSON.parse(url.searchParams.get("q") ?? "{}"));
          const e = await explain(query, run);
          return json(res, 200, { ok: true, source: h.connector.kind, sql: e.text, native: e.text, entities: e.entities, approximate: e.approximate });
        } catch (e) {
          if (e instanceof ResolveError) return json(res, 200, { ok: false, code: e.code, error: e.message, nearest: e.nearest, key: e.key });
          return json(res, 200, { ok: false, code: "INVALID", error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
        }
      }
      // Temporary boards for previews and evals: created from a config, deleted after.
      if (boardId === "boards" && req.method === "POST") {
        const body = (await read(req)) as { config: unknown; title?: string; temporary?: boolean };
        const config = boardConfigSchema.parse(body.config);
        const id = `${body.temporary ? "tmp" : "b"}_${Math.random().toString(36).slice(2, 10)}`;
        const board = await h.store.create({ id, pack: h.pack, title: body.title ?? config.title, config });
        return json(res, 200, { id: board.id, version: board.version });
      }
      // The canonical board: built from the pack's own ops file, never the
      // shared, editable copy.
      if (action === "canonical" && req.method === "GET") {
        const file = h.boards.find((b) => b.id === boardId);
        if (!file) return json(res, 404, { error: "no such board file" });
        const config = buildBoard(h.pack, file);
        const data = await resolveBoard(config, run);
        return json(res, 200, { board: { id: boardId, pack: h.pack.pack, config, version: 0, updatedAt: new Date() }, catalogue, data });
      }
      const board = await h.store.get(boardId);
      if (!board) return json(res, 404, { error: "no such board" });
      if (req.method === "DELETE" && !action) {
        if (!boardId.startsWith("tmp_")) return json(res, 403, { error: "only temporary boards can be deleted here" });
        await h.store.delete(boardId);
        return json(res, 200, { deleted: boardId });
      }
      switch (`${req.method} ${action ?? ""}`) {
        case "GET ": {
          // ?include=data,options: everything the first paint needs, in one
          // response, instead of a board request followed by two more.
          const include = new Set((url.searchParams.get("include") ?? "").split(",").filter(Boolean));
          if (include.size === 0) return json(res, 200, { board, catalogue });
          const [data, options] = await Promise.all([
            include.has("data") ? resolveBoard(board.config, run) : undefined,
            include.has("options")
              ? Promise.all(board.config.filters.map(async (f) => [f.field, await dimensionValues(f.field, run)] as const)).then(Object.fromEntries)
              : undefined,
          ]);
          return json(res, 200, { board, catalogue, ...(data ? { data } : {}), ...(options ? { options } : {}) });
        }
        case "GET data": {
          const selections = Object.fromEntries([...url.searchParams].filter(([k]) => k.startsWith("f_")).map(([k, v]) => [k.slice(2), v]));
          return json(res, 200, await resolveBoard(board.config, run, selections));
        }
        case "GET options":
          return json(res, 200, await dimensionValues(url.searchParams.get("field") ?? "", run));
        case "GET versions":
          return json(res, 200, await h.store.versions(boardId));
        case "POST ops": {
          const body = (await read(req)) as { ops: unknown[] };
          const ops = body.ops.map((o) => opSchema.parse(o)) as BoardOp[];
          const checked = checkOps(ops, h.pack, { ctx: h.ctx, capabilities: h.connector.capabilities });
          if (!checked.ok) return json(res, 200, checked);
          return json(res, 200, await h.store.patch({ id: boardId, ops, catalogue, source: "ops" }));
        }
        case "POST layout": {
          const body = (await read(req)) as { layout: BoardOp[] };
          return json(res, 200, await h.store.replaceConfig({ id: boardId, config: { ...board.config, layout: body.layout as never } }));
        }
        case "POST revert": {
          const body = (await read(req)) as { version: number };
          return json(res, 200, await h.store.revertTo(boardId, body.version));
        }
        case "POST chat":
          return chat(req, res, url, h, board.config, board.version, boardId);
      }
      return json(res, 404, { error: "not found" });
    } catch (e) {
      return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  };

  async function chat(req: IncomingMessage, res: ServerResponse, url: URL, h: Host & { catalogue: Catalogue }, config: BoardConfig, startVersion: number, boardId: string) {
    const builderModel = provider(url.searchParams.get("model")) ?? defaultProvider();
    if (!builderModel) return json(res, 503, { error: "Chat is not configured on this server (LENSPACK_LLM_PROVIDERS)" });
    if (builderModel.available === false) return json(res, 503, { error: `${builderModel.name} is unavailable: ${builderModel.error}` });
    // Roles. The builder is small and fast by default; the reviewer and the
    // escalation model (used for the heal round) can be larger. ?review=off
    // disables review.
    const reviewWanted = url.searchParams.get("review");
    const reviewer = reviewWanted === "off" ? null : (provider(reviewWanted) ?? provider(opts.roles?.reviewer) ?? builderModel);
    const escalate = provider(url.searchParams.get("escalate")) ?? provider(opts.roles?.escalate) ?? builderModel;
    // Review informs; healing is opt-in (?rounds=2). A wrong "not satisfied"
    // from the reviewer must not be able to damage a correct board on its own.
    const maxRounds = Number(url.searchParams.get("rounds") ?? 1);
    const body = (await read(req)) as { messages: UIMessage[] };
    const tools = toVercelAI(boardTools({ pack: h.pack, connector: h.connector, store: h.store, boardId, ctx: h.ctx, proposals: h.proposals }));
    const system = SYSTEM(h.pack, h.catalogue, config);
    const modelMessages = await convertToModelMessages(body.messages);
    const lastUser = [...body.messages].reverse().find((m) => m.role === "user");
    const instruction = (lastUser?.parts ?? []).map((p) => ("text" in p ? (p as { text: string }).text : "")).join(" ").trim();
    const before = summarise(config);

    // Build, then review, then heal — all in one response stream. The
    // reviewer's verdict is written as a data part the UI renders.
    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        let messages = modelMessages;
        for (let round = 1; round <= Math.max(1, maxRounds); round++) {
          const builder = round === 1 ? builderModel : escalate;
          writer.write({ type: "data-round", data: { round, builder: builder.name } });
          const result = streamText({ model: builder.languageModel, system, messages, tools: tools as ToolSet, stopWhen: [stepCountIs(12), stopOnRepeatedRefusals(3)] });
          writer.merge(result.toUIMessageStream({ sendStart: round === 1, sendFinish: false }));
          const steps = await result.steps;
          if (!reviewer) break;
          const current = (await h.store.get(boardId))!;
          const versions = (await h.store.versions(boardId)).filter((v) => v.version > startVersion);
          const receipt = versions.map((v) => `v${v.version} ${v.summary}`).reverse().join("\n");
          // Questions get no review: there is nothing on the board to check.
          if (versions.length === 0 && !/\b(add|rename|remove|move|resize|make|put|show|plot|pack|compact|set)\b/i.test(instruction)) break;
          let review;
          const beat = setInterval(() => writer.write({ type: "data-status", data: { phase: "reviewing" }, transient: true }), 10_000);
          try {
            review = await reviewTurn(reviewer.languageModel, { instruction, before, after: summarise(current.config), receipt, refusals: refusalsFrom(steps as never) });
          } catch (e) {
            review = { satisfied: true, unavailable: true, missing: [], wrong: [], note: `review skipped: ${(e instanceof Error ? e.message : String(e)).slice(0, 80)}` };
          } finally {
            clearInterval(beat);
          }
          writer.write({ type: "data-review", data: { round, reviewer: reviewer.name, ...review, raw: undefined } });
          if (review.satisfied || review.unavailable || round === maxRounds) break;
          // Another round with the review as the instruction; the model keeps its own history.
          messages = [...messages, ...steps.flatMap((s) => s.response.messages), { role: "user", content: healingPrompt(review) }];
        }
        writer.write({ type: "finish" });
      },
      onError: (e) => (e instanceof Error ? e.message : String(e)),
    });
    const response = createUIMessageStreamResponse({ stream });
    // Unbuffered all the way: a proxy that holds the stream while the
    // reviewer thinks would cut it as idle.
    const headers: Record<string, string> = { "x-accel-buffering": "no" };
    response.headers.forEach((v, k) => (headers[k] = v));
    res.writeHead(response.status, headers);
    res.flushHeaders();
    res.socket?.setNoDelay(true);
    try {
      if (response.body) for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
    } catch {
      // The reader went away mid-turn; the edits are already committed.
    }
    return res.end();
  }
}
