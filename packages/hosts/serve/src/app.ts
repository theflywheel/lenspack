import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { type ModelMessage, type ToolSet, type UIMessage, type UIMessageStreamWriter, convertToModelMessages, createUIMessageStream, createUIMessageStreamResponse, stepCountIs, streamText } from "ai";

import { type BoardConfig, type BoardOp, type BoardStore, type Catalogue, type Ownership, applyOps, boardConfigSchema, changesSince, describeChanges, emptyBoard, opSchema, querySchema, stagedStore, summarise } from "@lenspack/core";
import { type Connector, type Ctx, ResolveError, checkOps, dimensionValues, emptyQueryMeter, explain, meteredConnector, resolveBoard, widgetPage } from "@lenspack/engine";
import { type ProposalStore, boardTools, toVercelAI } from "@lenspack/agent";
import { type Principal, boardRights, decide, principalOf } from "@lenspack/policy";
import { type Pack, catalogueFrom } from "@lenspack/pack";

import type { Audit } from "./audit";
import { type Access, type AuthAdapter, NO_RIGHTS, type PackRule, type Rights, withRights } from "./auth";
import { BodyTooLarge, escapeHtml, json, readBody, readJson as read, scriptJson, serveStatic } from "./http";
import { type Provider, effortFor, publicView, shapeCall, stopOnRepeatedRefusals } from "./llm";
import { type Budget, type CallRecord, type UsageLedger, type UsageSink, budgetReport, overBudget, recordCall, turnCost, turnSummary, usageLedger, withMeter } from "./metering";
import { type LanguagePolicy, catalogueText, systemParts } from "./prompt";
import { keepReplyScripts, replyScripts, userTexts } from "./reply-script";
import { type Finding, ROLLBACK_PROMPT, type Review, fixPrompt, materialFindings, refusalsFrom, reviewTurn, rolledBackLine, unavailable } from "./review";
import { LANGUAGE, type SpeechOptions, SpeechError, fitsLanguages, scriptOf, speechRecord, transcribe } from "./speech";

/** Sent, tools off, when the step cap ends a tool loop before the model has said anything. */
export const CLOSING_PROMPT =
  "You have used all the steps for this turn, so no more tool calls. In one or two plain sentences, in the language the user wrote in, say what is now different on the board compared with the start of the turn (from the two boards below, not from the last tool result) and what is still not done.";

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
  /** Who may open the pack and what of it they see (lenspack.yaml packs[].access). */
  access?: PackRule[];
};

export type AppOptions = {
  /** A built client to serve for every non-API path (single-page fallback to index.html). */
  ui?: string;
  providers?: Provider[];
  /** `{ reviewer, escalate }` provider names. */
  roles?: { reviewer?: string; escalate?: string };
  /** False turns the reviewer off for every turn (a deployment's switch, read per turn). Absent means on. */
  review?: () => boolean;
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
  /** The UI's sign-out link, when the access hook has none of its own. */
  signOutUrl?: string;
  /**
   * How people sign in (lenspack.yaml auth:): who a request is, the adapter's
   * own /auth/ routes, and where a page without a session is sent. Takes the
   * place of access; rights are applied above it.
   */
  auth?: AuthAdapter;
  /** Rights by user and role (editors, maintainers, usage), for whoever the adapter names. */
  rights?: Rights;
  /** How the UI presents itself (lenspack.yaml `ui:`), written into the page it is served in. */
  page?: { title?: string; home?: string; intro?: string };
  /** How many of the latest user turns the chat model is sent, with the replies between them. Default 8. */
  historyTurns?: number;
  /** Where each chat turn's cost and each pack's queries are counted (GET /api/_usage), and the budget is checked. One is made if absent. */
  ledger?: UsageLedger;
  /** More sinks for the chat's model calls (the usage file). Process-wide sinks (addUsageSink) receive them anyway. */
  usageSinks?: UsageSink[];
  /** Daily caps on priced chat spend; over one, chat answers 429 before any model call. */
  budget?: Budget;
  /**
   * The chat model (a provider name) and effort to use when the client asks for none, read on
   * every turn so a settings page can change them on a running server. Unset, unknown or
   * unavailable: the first available provider and its default effort, as before.
   */
  chatDefault?: () => { model?: string; effort?: string } | undefined;
  /** Speech to text for the chat's mic (POST /api/_stt). Absent, or without a key, the mic is off. */
  speech?: SpeechOptions;
  /**
   * The deployment's language rules (settings, read per turn). With it, each
   * turn's prompt says which language to reply and title in; the request's
   * `language` ("auto", "fr", …) is the user's pick.
   */
  language?: () => Omit<LanguagePolicy, "reply">;
};

const OPEN = principalOf({ user: "anonymous", edit: true, maintain: true, usage: true });
const randomId = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

/**
 * The last n user turns and everything after them. A cut falls only before a
 * user message, and a UI message holds its tool calls with their results, so
 * no call is parted from its result.
 */
export function recentTurns(messages: UIMessage[], n: number): UIMessage[] {
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === "user" && ++seen === n) return messages.slice(i);
  return messages;
}

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

type ChatDefault = { model?: string; effort?: string } | undefined;
type Pickable = Pick<Provider, "name" | "available" | "efforts">;

/**
 * The model a chat turn runs on: the one the client asked for, else the configured default
 * (a settings page), else the first available provider, else the first not yet probed. Asked-for
 * and default models count only when they exist and are not known to be down.
 */
export function pickChatModel<P extends Pickable>(providers: P[], asked: string | null | undefined, fallback?: ChatDefault): P | null {
  return usable(providers, asked) ?? usable(providers, fallback?.model) ?? providers.find((p) => p.available) ?? providers.find((p) => p.available === null) ?? null;
}

/** The provider of that name, unless it is known to be down. */
const usable = <P extends Pickable>(providers: P[], name: string | null | undefined) => (name ? providers.find((p) => p.name === name && p.available !== false) : undefined);

/** The board's filter selections in a query string: ?f_<field>=<value>. */
const selectionsOf = (url: URL) => Object.fromEntries([...url.searchParams].filter(([k]) => k.startsWith("f_")).map(([k, v]) => [k.slice(2), v]));

/** A whole text part, for a reply the server writes itself. */
const writeText = (writer: UIMessageStreamWriter, id: string, text: string) => {
  writer.write({ type: "text-start", id });
  writer.write({ type: "text-delta", id, delta: text });
  writer.write({ type: "text-end", id });
};

/** A round's stream without its text, which is written later, once it is known to be true. */
const withoutText = <T extends { type: string }>() =>
  new TransformStream<T, T>({
    transform(chunk, out) {
      if (!chunk.type.startsWith("text-")) out.enqueue(chunk);
    },
  });

/** The effort to ask for: the client's, else the configured default when it is for this model and one it takes. */
export function pickEffort(p: Pickable, asked: string | null | undefined, fallback?: ChatDefault): string | null {
  if (asked) return asked;
  return fallback?.model === p.name && fallback.effort && p.efforts?.levels.includes(fallback.effort) ? fallback.effort : null;
}

/** Who a request is under these options, rights settled: the sign-in adapter with the rights above it, or the access hook. */
export function accessOf(opts: Pick<AppOptions, "auth" | "access" | "rights">): ((req: IncomingMessage) => Promise<Principal | null>) | undefined {
  if (opts.auth && opts.access) throw new Error("createApp takes auth or access, not both");
  if (opts.auth) return withRights(opts.auth, opts.rights ?? NO_RIGHTS);
  const hook = opts.access;
  return hook && (async (req) => {
    const id = await hook(req);
    return id && principalOf(id);
  });
}

export function createApp(hosts: Host[], opts: AppOptions = {}) {
  const access = accessOf(opts);
  const signOutUrl = opts.auth?.signOutUrl ?? opts.signOutUrl;
  const ledger = opts.ledger ?? usageLedger();
  // Every query a pack runs, from a board load or a chat tool, is counted against it.
  const byName = new Map(hosts.map((h) => [h.name, { ...h, connector: meteredConnector(h.connector, ledger.queriesOf(h.name)), catalogue: h.catalogue ?? catalogueFrom(h.pack) }]));
  const providers = opts.providers ?? [];
  // Transcriptions waiting for the turn they were spoken for: POST /_stt answers with a clip id, and
  // the chat request that sends the text names it, so the turn's cost includes the clip. The cost is
  // the server's own record, never a figure from the browser; a clip is claimed once, by its speaker.
  const clips = new Map<string, { user: string; records: CallRecord[]; at: number }>();
  const CLIP_TTL_MS = 60 * 60 * 1000;
  const keepClip = (user: string, records: CallRecord[]) => {
    const now = Date.now();
    for (const [id, c] of clips) if (now - c.at > CLIP_TTL_MS || clips.size > 1000) clips.delete(id);
    const id = randomUUID();
    clips.set(id, { user, records, at: now });
    return id;
  };
  const claimClips = (user: string, ids: unknown): CallRecord[] => {
    if (!Array.isArray(ids)) return [];
    const out: CallRecord[] = [];
    for (const id of ids.slice(0, 10)) {
      const c = typeof id === "string" ? clips.get(id) : undefined;
      if (!c || c.user !== user || Date.now() - c.at > CLIP_TTL_MS) continue;
      clips.delete(id as string);
      out.push(...c.records);
    }
    return out;
  };


  const audit = (e: Omit<Parameters<Audit>[0], "at">) => {
    try {
      opts.audit?.({ at: new Date().toISOString(), ...e });
    } catch (err) {
      opts.log?.(`audit failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // What the client needs to show the mic; null when speech is off.
  const speechInfo = () => (opts.speech?.apiKey ? { maxSeconds: opts.speech.maxSeconds ?? 60 } : null);

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://x");
    const [, api, packName, boardId, action] = url.pathname.split("/");
    try {
      if (opts.auth?.handle && (await opts.auth.handle(req, res, url))) return;
      if (api !== "api") {
        if (!opts.ui) return json(res, 404, { error: "not found" });
        // With lenspack's own sign-in, a page without a session goes to sign in first.
        if (opts.auth?.signInPath && access && !(await access(req))) {
          res.writeHead(302, { location: opts.auth.signInPath(url), "cache-control": "no-store" });
          return res.end();
        }
        const page = opts.page;
        // The page reads window.__lenspackUi before anything else runs.
        return serveStatic(opts.ui, url.pathname, res, page && ((html) => {
          html = html.replace("<head>", `<head><script>window.__lenspackUi=${scriptJson(page)}</script>`);
          return page.title ? html.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(page.title)}</title>`) : html;
        }));
      }
      const who = access ? await access(req) : OPEN;
      if (!who) return json(res, 401, { error: "sign in to use this API" });
      // What of a pack the caller may use; null: they may not open it. An open server has one local user, who sees everything.
      const decisionFor = (h: Host) => decide(who, h.pack, { name: h.name, rules: access ? h.access : undefined, host: h.ctx });
      // The pack's own boards first, in board-file order; then people's, latest first.
      const boardsOf = async (h: Host) => {
        const order = (b: Ownership & { id: string }) => (b.owner ? h.boards.length : Math.max(0, h.boards.findIndex((f) => f.id === b.id)));
        const listed = (await h.store.list()).filter((b) => boardRights(who, b).view);
        return listed.map((b, i) => ({ b, i })).sort((x, y) => order(x.b) - order(y.b) || x.i - y.i).map(({ b }) => ({ ...b, writable: boardRights(who, b).edit }));
      };
      if (!packName) {
        const list = await Promise.all(
          [...byName.values()].filter((h) => decisionFor(h)).map(async (h) => ({ example: h.name, source: h.connector.kind, description: h.pack.description, boards: await boardsOf(h) })),
        );
        // Absent on an open server: there is no one to name.
        const me = access ? { user: who.user, edit: who.edit, maintain: !!who.maintain, usage: who.usage, ...(signOutUrl ? { signOut: signOutUrl } : {}) } : undefined;
        return json(res, 200, { examples: list, chat: providers.length > 0, models: providers.map(publicView), speech: speechInfo(), ...(me ? { me } : {}) });
      }
      // What chat has cost since the server started: for those given the usage right (maintainers, unless said otherwise), as it names every user.
      if (packName === "_usage" && req.method === "GET") {
        if (!who.usage) return json(res, 403, { error: "usage is not shown to you" });
        // The caps go with it, so whoever watches spend sees how near they are.
        return json(res, 200, { ...ledger.report(), ...(opts.budget ? { budget: budgetReport(ledger, opts.budget) } : {}) });
      }
      // Speech to text for the mic: a raw audio body in, the text out, for the user to check before sending.
      if (packName === "_stt") {
        if (req.method !== "POST") return json(res, 405, { error: "POST a clip" });
        const speech = opts.speech;
        if (!speech?.apiKey) return json(res, 503, { error: "speech to text is not configured on this server" });
        const over = overBudget(ledger, opts.budget, who.user);
        if (over) return json(res, 429, { error: over });
        const language = url.searchParams.get("language") || undefined;
        const pack = url.searchParams.get("pack") || undefined;
        // Without a hint the model guesses the language, and a guess outside the reader's languages
        // (French heard as Persian) is useless: ?expected=en,fr,hi checks the script and retries once
        // with ?fallback; still wrong, 422 and no text.
        const expected = (url.searchParams.get("expected") ?? "").split(",").filter((l) => LANGUAGE.test(l));
        const fallback = url.searchParams.get("fallback") || undefined;
        if (fallback && !LANGUAGE.test(fallback)) return json(res, 400, { error: `bad fallback ${fallback}` });
        const sinks = [ledger, ...(opts.usageSinks ?? [])];
        let hint: string | undefined = language;
        try {
          const audio = await readBody(req, speech.maxBytes ?? 10_000_000).catch((e) => {
            throw e instanceof BodyTooLarge ? new SpeechError(413, "clip too long") : e;
          });
          let t = await transcribe(speech, audio, req.headers["content-type"], language);
          const spent: CallRecord[] = [speechRecord({ ...t, language: language ?? null, chars: t.text.length }, { user: who.user, pack })];
          recordCall(spent[0]!, sinks);
          let retried = false;
          // A hint is the reader's choice: words in another script (Persian for French) are a miss, not a transcript.
          if (language && !fitsLanguages(t.text, [language])) {
            opts.log?.(`stt: hinted ${language}, came back in ${scriptOf(t.text)} script`);
            return json(res, 422, { error: "wrong_script", language: language.split("-")[0], script: scriptOf(t.text) });
          }
          if (!language && expected.length && !fitsLanguages(t.text, expected)) {
            const first = scriptOf(t.text);
            opts.log?.(`stt: no hint, came back in ${first} script; ${fallback ? `retrying as ${fallback}` : "no fallback"}`);
            if (fallback) {
              hint = fallback;
              t = await transcribe(speech, audio, req.headers["content-type"], fallback);
              retried = true;
              spent.push(speechRecord({ ...t, language: fallback, chars: t.text.length, retried }, { user: who.user, pack }));
              recordCall(spent[spent.length - 1]!, sinks);
            }
            if (!fallback || !fitsLanguages(t.text, expected)) return json(res, 422, { error: "unsure_language", script: scriptOf(t.text), expected });
          }
          // The clip id: the chat request that sends this text names it, and the turn's cost includes the clip.
          return json(res, 200, { ...t, ...(retried ? { retried, hint } : {}), clip: keepClip(who.user, spent) });
        } catch (e) {
          if (!(e instanceof SpeechError)) throw e;
          if (e.status === 502) recordCall(speechRecord({ model: speech.model(), usd: null, ms: e.ms, ok: false, error: e.message.slice(0, 300), language: hint ?? null }, { user: who.user, pack }), sinks);
          opts.log?.(`stt: ${e.message}`);
          return json(res, e.status, { error: e.message });
        }
      }
      const h = byName.get(packName);
      const d = h ? decisionFor(h) : null;
      // A pack the caller may not open looks the same as one that is not there.
      if (!h || !d) return json(res, 404, { error: "no such pack" });
      // Everything the caller is shown of the pack's vocabulary leaves out what they may not use;
      // every board config they are sent keeps a hidden key's filter, not its value (d.board).
      const catalogue = d.catalogue(h.catalogue);
      const shown = d.board;
      // The caller's tenant may narrow a pack, never move a pinned one elsewhere.
      if (d.otherTenant) {
        audit({ user: who.user, pack: packName, action: "open", outcome: "denied", detail: "tenant" });
        return json(res, 403, { error: "this pack belongs to another tenant" });
      }
      // The decided scope narrows every query; hidden keys are refused in resolution, on every path.
      const ctx = d.ctx;
      const run = { pack: h.pack, connector: h.connector, ctx };
      // Everything but reading changes a board: those need the edit right.
      const writes = req.method !== "GET" && req.method !== "HEAD";
      // A read-only caller may still talk to the chat: its edit tools refuse with who.readOnly.
      const readOnlyChat = !!who.readOnly && req.method === "POST" && action === "chat";
      if (writes && !who.edit && !readOnlyChat) {
        audit({ user: who.user, pack: packName, board: boardId, action: `${req.method} ${action ?? boardId ?? ""}`.trim(), outcome: "denied" });
        return json(res, 403, { error: who.readOnly ?? "you may view these boards but not change them" });
      }
      if (!boardId) return json(res, 200, { example: h.name, pack: h.pack.pack, source: h.connector.kind, description: h.pack.description, instructions: h.pack.instructions, boards: await boardsOf(h), catalogue });
      // The pack file defines every key: not for a caller some are hidden from.
      if (boardId === "pack") return d.hidden.size ? json(res, 403, { error: "the pack file is not shown to you" }) : json(res, 200, { yaml: h.packYaml });
      // Compile one query without running it: the real native query, or the
      // real refusal.
      if (boardId === "explain" && req.method === "GET") {
        try {
          const query = querySchema.parse(JSON.parse(url.searchParams.get("q") ?? "{}"));
          const e = await explain(query, run);
          // The compiled statement reads like the pack file, which such a caller is not shown either.
          if (d.hidden.size) return json(res, 200, { ok: true, source: h.connector.kind, entities: e.entities, approximate: e.approximate });
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
      const board = await h.store.get(boardId);
      // A board the caller may not see looks the same as one that is not there.
      const rights = board ? boardRights(who, board) : { view: false, edit: false };
      if (!board || !rights.view) return json(res, 404, { error: "no such board" });
      // Anything the caller can see, they can make their own.
      if (req.method === "POST" && action === "copy") {
        const body = (await read(req)) as { title?: string };
        // Checked like any board, so a long or odd title cannot store one that will not load.
        const config = boardConfigSchema.parse({ ...board.config, title: body.title ?? `${board.config.title.slice(0, 150)} (copy)` });
        const copy = await h.store.create({ id: randomId("b"), pack: h.pack, title: config.title, config, owner: who.user, tenant: who.tenant });
        audit({ user: who.user, pack: packName, board: copy.id, action: "copy", outcome: "ok", detail: `from ${boardId}` });
        return json(res, 200, { id: copy.id, version: copy.version });
      }
      if (writes && !rights.edit && !readOnlyChat) {
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
          const mine = rights.edit;
          if (include.size === 0) return json(res, 200, { board: shown(board), catalogue, writable: mine });
          const [data, options] = await Promise.all([
            include.has("data") ? resolveBoard(board.config, run) : undefined,
            include.has("options")
              ? Promise.all(board.config.filters.filter((f) => f.type !== "host").map(async (f) => [f.field, await dimensionValues(f.field, run)] as const)).then(Object.fromEntries)
              : undefined,
          ]);
          return json(res, 200, { board: shown(board), catalogue, writable: mine, ...(data ? { data } : {}), ...(options ? { options } : {}) });
        }
        case "GET data":
          return json(res, 200, await resolveBoard(board.config, run, selectionsOf(url)));
        case "GET page": {
          // One page of one table of rows, under the same selections as the board.
          try {
            return json(res, 200, await widgetPage(board.config, url.searchParams.get("widget") ?? "", Number(url.searchParams.get("page") ?? 0), run, selectionsOf(url)));
          } catch (e) {
            if (e instanceof ResolveError) return json(res, 400, { error: e.message, code: e.code });
            throw e;
          }
        }
        case "GET options":
          return json(res, 200, await dimensionValues(url.searchParams.get("field") ?? "", run));
        case "GET versions":
          return json(res, 200, (await h.store.versions(boardId)).map(shown));
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
          return json(res, 200, patched.ok ? { ...patched, board: shown(patched.board) } : patched);
        }
        case "POST layout": {
          const body = (await read(req)) as { layout: BoardOp[]; summary?: unknown };
          const config = { ...board.config, layout: body.layout as never };
          // What the drag did, in the words its widget is known by: the client's
          // own line ("moved “X”"), else what the layouts differ by. One line, short.
          const said = typeof body.summary === "string" ? body.summary.replace(/\s+/g, " ").trim().slice(0, 200) : "";
          const summary = said || describeChanges(board.config, config).join(", ").slice(0, 200) || undefined;
          const saved = await h.store.replaceConfig({ id: boardId, config, ...(summary ? { summary } : {}) });
          audit({ user: who.user, pack: packName, board: boardId, action: "layout", outcome: "ok" });
          return json(res, 200, shown(saved));
        }
        case "POST share": {
          const body = (await read(req)) as { shared?: boolean };
          if (!board.owner) return json(res, 403, { error: "The pack's own boards are everyone's already" });
          const shared = await h.store.share(boardId, body.shared === true);
          audit({ user: who.user, pack: packName, board: boardId, action: body.shared === true ? "share" : "unshare", outcome: "ok" });
          return json(res, 200, shown(shared));
        }
        case "POST revert": {
          const body = (await read(req)) as { version: number };
          const reverted = await h.store.revertTo(boardId, body.version);
          audit({ user: who.user, pack: packName, board: boardId, action: "revert", outcome: "ok", detail: `to v${body.version}` });
          return json(res, 200, shown(reverted));
        }
        case "POST chat":
          audit({ user: who.user, pack: packName, board: boardId, action: "chat", outcome: "ok" });
          return chat(req, res, url, { ...h, pack: d.pack(), catalogue, ctx }, board.config, board.version, boardId, who.user, rights.edit ? undefined : who.readOnly);
      }
      return json(res, 404, { error: "not found" });
    } catch (e) {
      return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  };

  async function chat(req: IncomingMessage, res: ServerResponse, url: URL, h: Host & { catalogue: Catalogue }, config: BoardConfig, startVersion: number, boardId: string, user: string, readOnly?: string) {
    const fallback = opts.chatDefault?.();
    const builderModel = pickChatModel(providers, url.searchParams.get("model"), fallback);
    if (!builderModel) return json(res, 503, { error: "Chat is not configured on this server (LENSPACK_LLM_PROVIDERS)" });
    if (builderModel.available === false) return json(res, 503, { error: `${builderModel.name} is unavailable: ${builderModel.error}` });
    // ?effort= is for the chosen model; one without an effort setting ignores it.
    let effort: string | undefined;
    try {
      effort = effortFor(builderModel, pickEffort(builderModel, url.searchParams.get("effort"), fallback));
    } catch (e) {
      return json(res, 400, { error: (e as Error).message });
    }
    // Before any model call: a paid key behind a public demo stops at the cap, not at the invoice.
    const over = overBudget(ledger, opts.budget, user);
    if (over) {
      audit({ user, pack: h.name, board: boardId, action: "chat", outcome: "denied", detail: "budget" });
      return json(res, 429, { error: over });
    }
    // Roles. The builder is small and fast by default; the reviewer and the
    // escalation model (used for the fix round) can be larger. ?review=off
    // disables review.
    const reviewWanted = url.searchParams.get("review");
    const reviewer = reviewWanted === "off" || opts.review?.() === false ? null : (usable(providers, reviewWanted) ?? usable(providers, opts.roles?.reviewer) ?? builderModel);
    const escalate = usable(providers, url.searchParams.get("escalate")) ?? usable(providers, opts.roles?.escalate) ?? builderModel;
    // With a reviewer, the turn edits a staged copy of the board: its changes are saved when the
    // turn ends, and not at all if the reviewer still finds them misleading after one fix round.
    // Without one, every edit is saved as it is made.
    const staged = reviewer ? stagedStore(h.store, boardId) : null;
    const store = staged ?? h.store;
    // since: the board's version when this conversation's last turn ended, so
    // the model is told what the user changed by hand in between.
    const body = (await read(req)) as { messages: UIMessage[]; since?: unknown; language?: unknown; speech?: unknown };
    // What this turn costs: every model call made in its scope, the queries its tools run, and the
    // transcriptions the question was spoken through (already recorded when they ran; counted here, not again).
    const calls: CallRecord[] = claimClips(user, body.speech);
    const queries = emptyQueryMeter();
    const scope = { user, pack: h.name, board: boardId, turn: randomUUID(), sinks: [ledger, ...(opts.usageSinks ?? [])], collect: calls };
    const tools = toVercelAI(boardTools({ pack: h.pack, connector: meteredConnector(h.connector, queries), store, boardId, ctx: h.ctx, proposals: h.proposals, readOnly,
      onEdit: (e) => audit({ user, pack: h.name, board: boardId, action: "chat-edit", outcome: e.outcome, detail: `${e.ops.join(",") || "edit"}${e.version !== undefined ? ` → v${e.version}` : ""}${e.error ? `: ${e.error.slice(0, 200)}` : ""}` }) }));
    const since = typeof body.since === "number" && Number.isInteger(body.since) && body.since < startVersion ? body.since : null;
    const changes = since === null ? [] : changesSince(await h.store.versions(boardId), since);
    const picked = typeof body.language === "string" && (body.language === "auto" || LANGUAGE.test(body.language)) ? body.language : undefined;
    const language = opts.language || picked ? { ...opts.language?.(), reply: picked ?? null } : undefined;
    const system = systemParts(h.pack, h.catalogue, config, h.ctx.now, changes, language);
    const modelMessages = await convertToModelMessages(recentTurns(body.messages, opts.historyTurns ?? 8));
    const lastUser = [...body.messages].reverse().find((m) => m.role === "user");
    const instruction = (lastUser?.parts ?? []).map((p) => ("text" in p ? (p as { text: string }).text : "")).join(" ").trim();
    // No reply line in a script this user neither wrote in nor picked (Latin always passes): reply-script.ts.
    const replyGuard = keepReplyScripts(replyScripts(userTexts(body.messages), picked));
    const before = summarise(config);

    // One more call to a builder with tools off, for the words a turn ends with when its tool
    // loop could not supply them. Empty when the call fails or says nothing.
    const toolsOff = async (role: "build" | "escalate", builder: Provider, roundEffort: string | undefined, history: ModelMessage[], prompt: string) => {
      try {
        const r = withMeter({ role, effort: roundEffort }, () => {
          const call = shapeCall(builder, { system, messages: [...history, { role: "user", content: prompt }], tools: tools as ToolSet, effort: roundEffort });
          return streamText({ model: builder.languageModel, ...call, toolChoice: "none", stopWhen: stepCountIs(1), experimental_transform: replyGuard });
        });
        return (await r.text).trim();
      } catch {
        return "";
      }
    };

    // The summary a turn ends with when the step cap stopped its tool loop before the model
    // said anything. When the call fails or says nothing, a plain line from the board's
    // versions takes its place, so no edit ends in silence.
    const closingSummary = async (role: "build" | "escalate", builder: Provider, roundEffort: string | undefined, history: ModelMessage[], refused: string[]) => {
      const versions = (await store.versions(boardId)).filter((v) => v.version > startVersion).reverse();
      const now = summarise((await store.get(boardId))!.config);
      // The summary is grounded in the board itself, start of turn against now, so it cannot
      // mistake the last tool error for the outcome.
      const text = await toolsOff(role, builder, roundEffort, history, `${CLOSING_PROMPT}\n\nBoard at the start of this turn:\n${before}\n\nBoard now${versions.length ? "" : " (unchanged)"}:\n${now}`);
      if (text) return text;
      const left = refused.length ? ` Not done: ${[...new Set(refused)].join("; ")}.` : "";
      return versions.length
        ? `I ran out of steps before finishing. Changed so far: ${versions.map((v) => v.summary).join("; ")}.${left}`
        : `I ran out of steps before finishing, and the board is unchanged.${left}`;
    };

    const review = async (writer: UIMessageStreamWriter, reviewer: Provider, refusals: string[]): Promise<Review> => {
      const current = (await store.get(boardId))!;
      const receipt = (await store.versions(boardId)).filter((v) => v.version > startVersion).map((v) => `v${v.version} ${v.summary}`).reverse().join("\n");
      const beat = setInterval(() => writer.write({ type: "data-status", data: { phase: "reviewing" }, transient: true }), 10_000);
      try {
        // The reviewer keeps its own configuration, effort included.
        return await withMeter({ role: "review", effort: effortFor(reviewer) }, () => reviewTurn(reviewer, { catalogue: catalogueText(h.pack, h.catalogue), instructions: h.pack.instructions, instruction, before, after: summarise(current.config), receipt, refusals }));
      } catch (e) {
        return unavailable(`review skipped: ${(e instanceof Error ? e.message : String(e)).slice(0, 80)}`);
      } finally {
        clearInterval(beat);
      }
    };

    // Build, review, and when the reviewer finds a misleading change, one fix round and a
    // second review — all in one response stream. The reviewer's findings go out as a data part
    // for tools that want them; the person reads the outcome in the reply.
    const stream = createUIMessageStream({
      execute: ({ writer }) => withMeter(scope, async () => {
        let messages = modelMessages;
        // One line per turn for whoever improves the pack: what was asked, what the model did, what was refused, the verdicts.
        const turn: { instruction: string; answer?: string; calls: unknown[]; refusals: string[]; reviews: unknown[]; outcome?: string } = { instruction: instruction.slice(0, 2000), calls: [], refusals: [], reviews: [] };
        // The findings that would make the held edits mislead; while there are any, they are dropped rather than saved.
        let misleading: Finding[] = [];
        let toldUnchanged = false;
        // A fix round put a misleading change right: the turn is saved as one version, so the wrong one never reaches the board.
        let corrected = false;
        const say = (text: string) => {
          writeText(writer, `reply-${randomUUID()}`, text);
          turn.answer = text.slice(0, 2000);
        };
        try {
          // Round 1 builds. Round 2 runs only to fix a misleading change, and its words are held
          // back until the fix has been checked, so a fix that failed never claims to have worked.
          for (let round = 1; round <= 2; round++) {
            const fixing = round === 2;
            const builder = fixing ? escalate : builderModel;
            const role = fixing ? "escalate" : "build";
            // The asked-for effort goes with the chosen model; a different escalation model runs at its own default.
            const roundEffort = builder === builderModel ? effort : effortFor(builder);
            writer.write({ type: "data-round", data: { round, builder: builder.name, ...(roundEffort ? { effort: roundEffort } : {}) } });
            // Shaped per round: the escalation model may speak another API.
            const call = shapeCall(builder, { system, messages, tools: tools as ToolSet, loop: true, effort: roundEffort });
            // The stream is started and read inside the round's scope, so every step of its tool loop is attributed to it.
            const result = withMeter({ role, effort: roundEffort }, () => {
              const r = streamText({ model: builder.languageModel, ...call, stopWhen: [stepCountIs(12), stopOnRepeatedRefusals(3)], experimental_transform: replyGuard });
              // A rejected tool call shows its reason (a chart kind that does not exist, a missing title), not "An error occurred.".
              const ui = r.toUIMessageStream({ sendStart: round === 1, sendFinish: false, onError: (e) => (e instanceof Error ? e.message : String(e)).slice(0, 300) });
              writer.merge(fixing ? ui.pipeThrough(withoutText()) : ui);
              return r;
            });
            const steps = await result.steps;
            let answer = (await result.text).trim();
            turn.calls.push(...steps.flatMap((s) => s.toolCalls.map((c) => ({ tool: c.toolName, input: (c as { input?: unknown }).input }))));
            const refused = refusalsFrom(steps as never);
            turn.refusals.push(...refused);
            const history = [...messages, ...steps.flatMap((s) => s.response.messages)];
            const finish = await result.finishReason;
            if (!answer) {
              // A tool loop stopped before the model said a word (the step cap, or the guard on
              // repeated refusals). The board may have changed on the way, so the reply describes
              // the board as it now is against the start of the turn, never just the last refusal.
              if (finish === "tool-calls") answer = await closingSummary(role, builder, roundEffort, history, refused);
              // The provider's own safety check declined the turn, or the model stopped on refusals
              // without editing: say so, rather than end it in silence.
              else if (finish === "content-filter") answer = `${builder.name} declined to answer this request.`;
              else if (refused.length) answer = `I could not do that with the "${h.pack.pack}" pack. Refused: ${[...new Set(refused)].join("; ")}`;
              if (answer && !fixing) say(answer);
            }
            if (!fixing) turn.answer = answer.slice(0, 2000);
            if (!reviewer) break;
            // Questions get no review: there is nothing on the board to check.
            const gained = (await store.versions(boardId)).some((v) => v.version > startVersion);
            if (!fixing && !gained && !/\b(add|rename|remove|move|resize|make|put|show|plot|pack|compact|set)\b/i.test(instruction)) break;
            const verdict = await review(writer, reviewer, turn.refusals.slice(-8));
            writer.write({ type: "data-review", data: { round, reviewer: reviewer.name, ...verdict, raw: undefined } });
            turn.reviews.push({ round, satisfied: verdict.satisfied, unavailable: verdict.unavailable, findings: verdict.findings, note: verdict.note });
            const material = materialFindings(verdict);
            if (!fixing && material.length) {
              // The change would mislead: one round to correct it, with the findings as the instruction.
              misleading = material;
              messages = [...history, { role: "user", content: fixPrompt(material) }];
              continue;
            }
            if (fixing && material.length) {
              // Still misleading after its one fix: nothing from this turn is saved, and the reply says so.
              misleading = material;
              const why = material.map((f) => `- ${f.problem}`).join("\n");
              say((await toolsOff(role, builder, roundEffort, history, `${ROLLBACK_PROMPT}\n${why}`)) || rolledBackLine(material));
              toldUnchanged = true;
              break;
            }
            if (fixing) {
              say(answer || `I corrected my earlier change. ${misleading.map((f) => f.forUser).join(" ")}`.trim());
              corrected = true;
            }
            misleading = [];
            // Minor findings: the change stands, and the reply says what to know in one plain sentence.
            const minor = verdict.userNote || verdict.findings.map((f) => f.forUser).filter(Boolean).join(" ");
            if (minor) writeText(writer, `note-${randomUUID()}`, minor);
            break;
          }
        } finally {
          if (staged) {
            if (misleading.length) {
              staged.discard();
              turn.outcome = "left unchanged";
              // The fix round failed part-way: the board is still as it was, and the reply should say so.
              if (!toldUnchanged) say(rolledBackLine(misleading));
            } else {
              try {
                await staged.commit({ asOne: corrected });
              } catch (e) {
                turn.outcome = "not saved";
                say(`The change could not be saved: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
              }
            }
          }
          // Counted even when the turn failed part-way: the tokens were spent.
          const cost = turnCost(calls, queries);
          const summary = turnSummary(cost);
          ledger.turn({ user, pack: h.name }, cost);
          audit({ user, pack: h.name, board: boardId, action: "chat-turn", outcome: "ok", detail: JSON.stringify({ builder: builderModel.name, ...(effort ? { effort } : {}), ...turn, ...summary, cost }) });
          writer.write({ type: "data-usage", data: { ...cost, summary } });
        }
        writer.write({ type: "finish" });
      }),
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
      // The reader went away mid-turn. The turn runs on, and its edits are saved, or not, as if they were still there.
    }
    return res.end();
  }
}
