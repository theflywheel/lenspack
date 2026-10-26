import { existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";

import { type ToolSet, type UIMessage, convertToModelMessages, createUIMessageStream, createUIMessageStreamResponse, stepCountIs, streamText } from "ai";

import { type BoardConfig, type BoardOp, type BoardStore, type Catalogue, type Ownership, applyOps, boardConfigSchema, emptyBoard, opSchema, querySchema, summarise } from "@lenspack/core";
import { type Connector, type Ctx, ResolveError, checkOps, dimensionValues, explain, resolveBoard } from "@lenspack/engine";
import { type ProposalStore, boardTools, toVercelAI } from "@lenspack/mcp";
import { type Pack, catalogueFrom } from "@lenspack/spec";

import type { Access, Audit, Principal } from "./auth";
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
  /**
   * Who a request is. Absent, the API is open: anyone who reaches it may read
   * and edit every board. With it, an unknown caller gets 401, a caller
   * without edit rights cannot change boards, and each caller's tenant and
   * row scope narrow every query they run.
   */
  access?: Access;
  /** Told of every change, refused change and denied request, with the user. */
  audit?: Audit;
  /** The UI's sign-out link (auth.proxy signOutUrl). */
  signOutUrl?: string;
  /** How the UI presents itself (lenspack.yaml `ui:`), written into the page it is served in. */
  page?: { mode: "demo" | "app"; title?: string; home?: string };
};

const OPEN: Principal = { user: "anonymous", edit: true, maintain: true };

// The pack's own boards (no owner) are everyone's to read and a maintainer's
// to change. A board someone made is theirs to change, and everyone's to read
// once they share it: everyone in their tenant, as one user name may sign in
// under two tenants.
const sameTenant = (b: Ownership, who: Principal) => (b.tenant ?? "") === (who.tenant ?? "");
const visible = (b: Ownership, who: Principal) => !b.owner || (sameTenant(b, who) && (!!b.shared || b.owner === who.user));
const writable = (b: Ownership, who: Principal) => (b.owner ? b.owner === who.user && sameTenant(b, who) && !!(who.edit || who.maintain) : !!who.maintain);
const randomId = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

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

/**
 * Puts a pack's board files in its store. A file that changed since it was
 * last put there lands as a new version; what was changed in the app stays
 * in the board's history.
 */
export async function seedBoards(host: Host) {
  for (const b of host.boards) {
    const config = buildBoard(host.pack, b);
    if (!(await host.store.get(b.id))) {
      await host.store.create({ id: b.id, pack: host.pack, title: b.title, config });
      continue;
    }
    // Compared as the file wrote it: a new pack version alone is not a changed file.
    const asFile = (c?: BoardConfig) => c && JSON.stringify({ ...c, packVersion: 0 });
    const fromFile = (await host.store.versions(b.id)).find((v) => v.source === "create" || v.source === "file");
    if (asFile(fromFile?.config) !== asFile(config)) await host.store.replaceConfig({ id: b.id, config, source: "file", summary: "changed in its board file" });
  }
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

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

function serveStatic(root: string, pathname: string, res: ServerResponse, page?: AppOptions["page"]) {
  const safe = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(root, safe);
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) file = join(root, "index.html");
  if (!existsSync(file)) return json(res, 404, { error: "not found" });
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  if (!page || !file.endsWith("index.html")) return res.end(readFileSync(file));
  // The page reads window.__lenspackUi before anything else runs; "<" is escaped so no value can end the script.
  let html = readFileSync(file, "utf8").replace("<head>", `<head><script>window.__lenspackUi=${JSON.stringify(page).replace(/</g, "\\u003c")}</script>`);
  if (page.title) html = html.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(page.title)}</title>`);
  res.end(html);
}

export function createApp(hosts: Host[], opts: AppOptions = {}) {
  const byName = new Map(hosts.map((h) => [h.name, { ...h, catalogue: h.catalogue ?? catalogueFrom(h.pack) }]));
  const providers = opts.providers ?? [];
  const defaultProvider = () => providers.find((p) => p.available) ?? providers.find((p) => p.available === null) ?? null;
  const provider = (name: string | null | undefined) => (name ? providers.find((p) => p.name === name && p.available !== false) : undefined);

  const audit = (e: Omit<Parameters<Audit>[0], "at">) => {
    try {
      opts.audit?.({ at: new Date().toISOString(), ...e });
    } catch (err) {
      opts.log?.(`audit failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://x");
    const [, api, packName, boardId, action] = url.pathname.split("/");
    try {
      if (api !== "api") return opts.ui ? serveStatic(opts.ui, url.pathname, res, opts.page) : json(res, 404, { error: "not found" });
      const who = opts.access ? await opts.access(req) : OPEN;
      if (!who) return json(res, 401, { error: "sign in to use this API" });
      const mayOpen = (name: string) => !who.packs || who.packs.includes(name);
      // The pack's own boards first, in board-file order; then people's, latest first.
      const boardsOf = async (h: Host) => {
        const order = (b: Ownership & { id: string }) => (b.owner ? h.boards.length : Math.max(0, h.boards.findIndex((f) => f.id === b.id)));
        const listed = (await h.store.list()).filter((b) => visible(b, who));
        return listed.map((b, i) => ({ b, i })).sort((x, y) => order(x.b) - order(y.b) || x.i - y.i).map(({ b }) => ({ ...b, writable: writable(b, who) }));
      };
      if (!packName) {
        const list = await Promise.all(
          [...byName.values()].filter((h) => mayOpen(h.name)).map(async (h) => ({ example: h.name, source: h.connector.kind, description: h.pack.description, boards: await boardsOf(h) })),
        );
        // Absent on an open server: there is no one to name.
        const me = opts.access ? { user: who.user, edit: !!(who.edit || who.maintain), maintain: !!who.maintain, ...(opts.signOutUrl ? { signOut: opts.signOutUrl } : {}) } : undefined;
        return json(res, 200, { examples: list, chat: providers.length > 0, models: providers.map(publicView), ...(me ? { me } : {}) });
      }
      const h = byName.get(packName);
      // A pack the caller may not open looks the same as one that is not there.
      if (!h || !mayOpen(packName)) return json(res, 404, { error: "no such pack" });
      const catalogue = h.catalogue;
      // The caller's tenant may narrow a pack, never move a pinned one elsewhere.
      if (who.tenant && h.ctx.tenant && who.tenant !== h.ctx.tenant) {
        audit({ user: who.user, pack: packName, action: "open", outcome: "denied", detail: "tenant" });
        return json(res, 403, { error: "this pack belongs to another tenant" });
      }
      const ctx = { ...h.ctx, ...(who.tenant ? { tenant: who.tenant } : {}), ...(who.scope?.length ? { scope: [...(h.ctx.scope ?? []), ...who.scope] } : {}) };
      const run = { pack: h.pack, connector: h.connector, ctx };
      // Everything but reading changes a board: those need the edit right.
      const writes = req.method !== "GET" && req.method !== "HEAD";
      if (writes && !who.edit && !who.maintain) {
        audit({ user: who.user, pack: packName, board: boardId, action: `${req.method} ${action ?? boardId ?? ""}`.trim(), outcome: "denied" });
        return json(res, 403, { error: "you may view these boards but not change them" });
      }
      if (!boardId) return json(res, 200, { example: h.name, pack: h.pack.pack, source: h.connector.kind, description: h.pack.description, boards: await boardsOf(h), catalogue });
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
      // A new board, the caller's: empty, or from a config. Temporary ones are
      // for previews and evals, deleted after.
      if (boardId === "boards" && req.method === "POST") {
        const body = (await read(req)) as { config?: unknown; title?: string; temporary?: boolean };
        const config = body.config === undefined ? emptyBoard(h.pack, body.title ?? "Untitled board") : boardConfigSchema.parse(body.config);
        const board = await h.store.create({ id: randomId(body.temporary ? "tmp" : "b"), pack: h.pack, title: body.title ?? config.title, config, owner: who.user, tenant: who.tenant });
        audit({ user: who.user, pack: packName, board: board.id, action: "create", outcome: "ok" });
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
      // A board the caller may not see looks the same as one that is not there.
      if (!board || !visible(board, who)) return json(res, 404, { error: "no such board" });
      // Anything the caller can see, they can make their own.
      if (req.method === "POST" && action === "copy") {
        const body = (await read(req)) as { title?: string };
        // Checked like any board, so a long or odd title cannot store one that will not load.
        const config = boardConfigSchema.parse({ ...board.config, title: body.title ?? `${board.config.title.slice(0, 150)} (copy)` });
        const copy = await h.store.create({ id: randomId("b"), pack: h.pack, title: config.title, config, owner: who.user, tenant: who.tenant });
        audit({ user: who.user, pack: packName, board: copy.id, action: "copy", outcome: "ok", detail: `from ${boardId}` });
        return json(res, 200, { id: copy.id, version: copy.version });
      }
      if (writes && !writable(board, who)) {
        audit({ user: who.user, pack: packName, board: boardId, action: `${req.method} ${action ?? ""}`.trim(), outcome: "denied", detail: board.owner ? "owner" : "pack board" });
        return json(res, 403, { error: board.owner ? `This board is ${board.owner}'s: save a copy to change it` : "This is the pack's own board: save a copy to change it" });
      }
      if (req.method === "DELETE" && !action) {
        if (!board.owner) return json(res, 403, { error: "The pack's own boards come from its board files and are not deleted here" });
        await h.store.delete(boardId);
        audit({ user: who.user, pack: packName, board: boardId, action: "delete", outcome: "ok" });
        return json(res, 200, { deleted: boardId });
      }
      switch (`${req.method} ${action ?? ""}`) {
        case "GET ": {
          // ?include=data,options: everything the first paint needs, in one
          // response, instead of a board request followed by two more.
          const include = new Set((url.searchParams.get("include") ?? "").split(",").filter(Boolean));
          const mine = writable(board, who);
          if (include.size === 0) return json(res, 200, { board, catalogue, writable: mine });
          const [data, options] = await Promise.all([
            include.has("data") ? resolveBoard(board.config, run) : undefined,
            include.has("options")
              ? Promise.all(board.config.filters.map(async (f) => [f.field, await dimensionValues(f.field, run)] as const)).then(Object.fromEntries)
              : undefined,
          ]);
          return json(res, 200, { board, catalogue, writable: mine, ...(data ? { data } : {}), ...(options ? { options } : {}) });
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
          const checked = checkOps(ops, h.pack, { ctx, capabilities: h.connector.capabilities });
          if (!checked.ok) {
            audit({ user: who.user, pack: packName, board: boardId, action: "ops", outcome: "refused", detail: checked.error });
            return json(res, 200, checked);
          }
          const patched = await h.store.patch({ id: boardId, ops, catalogue, source: "ops" });
          audit({ user: who.user, pack: packName, board: boardId, action: "ops", outcome: "ok", detail: ops.map((o) => o.op).join(",") });
          return json(res, 200, patched);
        }
        case "POST layout": {
          const body = (await read(req)) as { layout: BoardOp[] };
          const saved = await h.store.replaceConfig({ id: boardId, config: { ...board.config, layout: body.layout as never } });
          audit({ user: who.user, pack: packName, board: boardId, action: "layout", outcome: "ok" });
          return json(res, 200, saved);
        }
        case "POST share": {
          const body = (await read(req)) as { shared?: boolean };
          if (!board.owner) return json(res, 403, { error: "The pack's own boards are everyone's already" });
          const shared = await h.store.share(boardId, body.shared === true);
          audit({ user: who.user, pack: packName, board: boardId, action: body.shared === true ? "share" : "unshare", outcome: "ok" });
          return json(res, 200, shared);
        }
        case "POST revert": {
          const body = (await read(req)) as { version: number };
          const reverted = await h.store.revertTo(boardId, body.version);
          audit({ user: who.user, pack: packName, board: boardId, action: "revert", outcome: "ok", detail: `to v${body.version}` });
          return json(res, 200, reverted);
        }
        case "POST chat":
          audit({ user: who.user, pack: packName, board: boardId, action: "chat", outcome: "ok" });
          return chat(req, res, url, { ...h, ctx }, board.config, board.version, boardId, who.user);
      }
      return json(res, 404, { error: "not found" });
    } catch (e) {
      return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  };

  async function chat(req: IncomingMessage, res: ServerResponse, url: URL, h: Host & { catalogue: Catalogue }, config: BoardConfig, startVersion: number, boardId: string, user: string) {
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
    // At most 3: each round is a build and a review, both model calls.
    const maxRounds = Math.min(3, Math.max(1, Math.floor(Number(url.searchParams.get("rounds") ?? 1)) || 1));
    const body = (await read(req)) as { messages: UIMessage[] };
    const tools = toVercelAI(boardTools({ pack: h.pack, connector: h.connector, store: h.store, boardId, ctx: h.ctx, proposals: h.proposals }));
    const system = SYSTEM(h.pack, h.catalogue, config, h.ctx.now);
    const modelMessages = await convertToModelMessages(body.messages);
    const lastUser = [...body.messages].reverse().find((m) => m.role === "user");
    const instruction = (lastUser?.parts ?? []).map((p) => ("text" in p ? (p as { text: string }).text : "")).join(" ").trim();
    const before = summarise(config);

    // Build, then review, then heal — all in one response stream. The
    // reviewer's verdict is written as a data part the UI renders.
    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        let messages = modelMessages;
        // One line per turn for whoever improves the pack: what was asked, what the model did, what was refused, the verdict.
        const turn: { instruction: string; answer?: string; calls: unknown[]; refusals: string[]; review?: unknown } = { instruction: instruction.slice(0, 2000), calls: [], refusals: [] };
        for (let round = 1; round <= Math.max(1, maxRounds); round++) {
          const builder = round === 1 ? builderModel : escalate;
          writer.write({ type: "data-round", data: { round, builder: builder.name } });
          const result = streamText({ model: builder.languageModel, system, messages, tools: tools as ToolSet, stopWhen: [stepCountIs(12), stopOnRepeatedRefusals(3)] });
          writer.merge(result.toUIMessageStream({ sendStart: round === 1, sendFinish: false }));
          const steps = await result.steps;
          turn.answer = (await result.text).slice(0, 2000);
          turn.calls.push(...steps.flatMap((s) => s.toolCalls.map((c) => ({ tool: c.toolName, input: (c as { input?: unknown }).input }))));
          const refused = refusalsFrom(steps as never);
          turn.refusals.push(...refused);
          // Stopped by the refusal guard before the model said a word: say what was refused, so no turn is silent.
          if (!turn.answer.trim() && refused.length) {
            const id = `refused-${round}`;
            turn.answer = `I could not do that with the "${h.pack.pack}" pack. Refused: ${[...new Set(refused)].join("; ")}`;
            writer.write({ type: "text-start", id });
            writer.write({ type: "text-delta", id, delta: turn.answer });
            writer.write({ type: "text-end", id });
          }
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
          turn.review = { satisfied: review.satisfied, unavailable: review.unavailable, missing: review.missing, wrong: review.wrong, note: review.note };
          if (review.satisfied || review.unavailable || round === maxRounds) break;
          // Another round with the review as the instruction; the model keeps its own history.
          messages = [...messages, ...steps.flatMap((s) => s.response.messages), { role: "user", content: healingPrompt(review) }];
        }
        audit({ user, pack: h.name, board: boardId, action: "chat-turn", outcome: "ok", detail: JSON.stringify({ builder: builderModel.name, ...turn }) });
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
