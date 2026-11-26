// Answer and plan reuse: the chat answers a question it has answered before without the model.
//
// People ask the same few dozen questions every day, and settle on a dashboard after a few edits.
// So a turn the full assistant answered well is kept: the question, the calls that answered it
// (the queries with their results, or the edits) and the reply. A later question is matched,
// cheapest first:
//   T1  the same question, data read moments ago: the saved reply and results, no model, no query;
//   T2  the same question, older data: the saved queries run again, the reply's numbers swapped
//       for the fresh ones by template (or, when that is not safe, one small "rewrite with these
//       numbers" call), no agent. A suggested question whose query was checked when it was written
//       runs that query the same way, the first time too;
//   T3  the same question with another place or time (a slot): the plan with them swapped in, as T2;
//   T4  a different wording: one small router call picks a saved question, or none; a match runs as T2/T3.
// Only turns that ended well are kept (an answer with data, or edits the reviewer accepted), only
// for the same access scope, pack, definitions, prompt version, board filters, the viewer's filter
// selections and language rules.
//
// This module knows no host and no HTTP: a host hands it a turn (ReuseTurn), a small model to call
// (SmallModel) and a store (AnswerStore), and turns what it serves into its own stream. See
// docs/caching.md.

import { type BoardConfig, type BoardStore, type Query, stagedStore } from "@lenspack/core";
import type { Connector } from "@lenspack/engine";
import type { Pack } from "@lenspack/pack";

import type { ProposalStore } from "../proposals";
import { type BoardToolsOptions, boardTools, checkedQuery } from "../tools";
import type { TurnView } from "../view";
import { retemplate } from "./numbers";
import { PHRASE_PROMPT, REWRITE_PROMPT, ROUTER_PROMPT, parseRoute, phraseMessage, rewriteMessage, routerMessage, slotName } from "./router";
import { dueTimes } from "./schedule";
import type { CacheSettings } from "./settings";
import { type Call, type Slot, fill, slotInto, slotsOf, timePhrase } from "./slots";
import { type AnswerStore, type Entry, type KeptCtx, type Tier, accessOf, emptyTiers, fileAnswerStore } from "./store";
import { canonical, guessLanguage, normalise, shortHash, similarity, standalone } from "./text";

export { CACHE_DEFAULTS, type CacheSettings, type CacheSettingsStore, PREWARM_DEFAULTS, type PrewarmSettings, type SettingsLike, cacheSettings, cacheSettingsFrom, prewarmFrom } from "./settings";
export { type Access, type AnswerStore, type BoardInfo, type Entry, type KeptCtx, type Stats, type Tier, accessOf, ctxOf, emptyTiers, fileAnswerStore } from "./store";
export { numbersIn, retemplate, shapeOf } from "./numbers";
export { guessLanguage, normalise, similarity, standalone } from "./text";
export { type Call, type Slot, fill, slotInto, slotsOf, timePhrase } from "./slots";
export { CATCH_UP_MINUTES, dueTimes, localClock } from "./schedule";
export { PHRASE_PROMPT, REWRITE_PROMPT, ROUTER_PROMPT } from "./router";

/** Calls that read data: what a plan re-runs. */
const DATA_TOOLS = new Set(["query", "list_values"]);
/** Calls that only look at the pack: harmless in an answer, and not re-run. */
const PACK_TOOLS = new Set(["list_metrics", "explain"]);
/** A kept plan's results, at most this many characters, so the store stays small. */
const MAX_PLAN_CHARS = 200_000;
/** How many saved questions the router is shown. */
const ROUTER_CANDIDATES = 8;

/** The small model the router and the rewrite step call: one system prompt, one message, the text back. */
export type SmallModel = { name: string; complete(system: string, user: string, maxOutputTokens: number): Promise<string> };

/** One chat turn, as the store sees it: who asks what, where, and with what. */
export type ReuseTurn = {
  packName: string;
  pack: Pack;
  board: string;
  /** The board as the asker is shown it, at the start of the turn. */
  config: BoardConfig;
  /** The asker's engine context: tenant, row scope, hidden keys and datasets, and a board grant if one opened any. */
  ctx: KeptCtx;
  /** The pack's source, metered for this turn by the host if it meters. */
  connector: Connector;
  store: BoardStore;
  proposals?: ProposalStore;
  question: string;
  /** The question opens the conversation: a later one may lean on what came before. */
  firstTurn: boolean;
  /** The language picked in the chat ("auto" or a code), if any. */
  picked?: string;
  /** The deployment's language rules this turn runs under. */
  rules?: unknown;
  /** The viewer's filter selections on the dashboard: part of what an answer is an answer to. */
  selections?: Record<string, unknown>;
  /** Where the viewer is on the host's page (their open tab): part of what an edit is ("add a chart here"), not of what an answer is. */
  view?: TurnView;
  /** The host's assistant prompt version: a new one makes every saved answer stale. */
  promptVersion?: string;
  readOnly?: string;
  /** "Ask fresh": the full assistant answers, whatever is saved. */
  fresh?: boolean;
  /** The model the full assistant would have used: what a saved answer is said to save. */
  builder: string;
  /** The router and rewrite model; null: only what needs no model is served. */
  small?: SmallModel | null;
  /** What the turn has spent on models so far, US$. */
  spentUsd?: () => number;
  /** Suggested questions with the query each was checked with: answered by that query directly. */
  examples?: { question: string; query: Query }[];
  onEdit?: BoardToolsOptions["onEdit"];
  /** Hears every data call a replay makes (the host's answer card). */
  onData?: BoardToolsOptions["onData"];
};

/** What the full assistant did in a turn, for the store to keep (or not). */
export type TurnOutcome = {
  completed: boolean;
  reply: string;
  calls: { tool: string; input: unknown; output: unknown }[];
  /** Board versions the turn saved. */
  saved: string[];
  /** The reviewer ran on the turn's edits. */
  reviewed: boolean;
  /** The edits stood: the reviewer had no material finding, or did not run. */
  accepted: boolean;
  /** A fix round ran. */
  fixed: boolean;
  costUsd: number;
};

/** What a saved answer's reply line says (the host sends it as data with the reply). */
export type ServedNote = { tier: Tier; entry: string; kind: Entry["kind"]; dataAsOf: string; savedUsd: number; question: string; how?: string };

/** A turn served from the store: the calls it ran (with results), the reply, and the note for the reader and the audit. */
export type Served = { tier: Tier; entry: Entry; reply: string; calls: Call[]; note: ServedNote; savedUsd: number; dataAsOf: string; why?: string };

/** One refresh's outcome, shown on the admin page. */
export type PrewarmRun = { at: string; reason: "schedule" | "data" | "admin"; pack: string | null; entries: number; refreshed: number; rewritten: number; skipped: number; failed: number; spentUsd: number; modelCalls: number };

/** How a host builds the turn a saved answer is refreshed in (its pack, board and the access it was made under), and counts what it spent. */
export type TurnFor = (e: Entry) => Promise<{ turn: ReuseTurn; spent: () => { usd: number; calls: number } } | null>;

export type ReuseOptions = {
  /** Where entries live: an AnswerStore, or a file path for the file-backed one. */
  store: AnswerStore | string;
  /** The effective settings, read on every turn (the feature switch and the settings page). */
  settings: () => CacheSettings & { on: boolean };
  log?: (line: string) => void;
  now?: () => Date;
  /** false: no minute timer for the refresh schedule (tests call tick()). */
  timer?: boolean;
};

export type Reuse = ReturnType<typeof reuseLayer>;

// The access an entry is kept under. A board grant (entities read on one board only) is part of it, so an answer or
// edit made under one is never served on another board, or to a caller without the same grant. Without a grant the
// key is as it always was.
const scopeOf = (ctx: KeptCtx) =>
  shortHash(canonical({ tenant: ctx.tenant ?? null, scope: ctx.scope ?? [], hidden: [...(ctx.hidden ?? [])].sort(), entities: [...(ctx.hiddenEntities ?? [])].sort(), ...(ctx.onBoard ? { onBoard: { board: ctx.onBoard.board, entities: [...ctx.onBoard.entities].sort() } } : {}) }));
const packHashes = new WeakMap<Pack, string>();
const packHash = (p: Pack) => {
  let h = packHashes.get(p);
  if (!h) packHashes.set(p, (h = shortHash(canonical(p))));
  return h;
};
/** A board's content, without its title: two boards with the same widgets, layout and filters hash the same. */
export const boardHash = (c: BoardConfig) => shortHash(canonical({ ...c, title: "" }));
const isApplied = (o: unknown) => !!o && typeof o === "object" && (o as { applied?: unknown }).applied === true;
const failed = (o: unknown) => !o || typeof o !== "object" || (o as { ok?: unknown }).ok === false || (o as { applied?: unknown }).applied === false || "error" in (o as object);
const irOf = (c: Call) => (c.input as { ir?: Query }).ir;

/** A query's kind, measure and dimension: what a dashboard chart would have to show to answer it. */
function signatureOf(q: unknown): string | null {
  if (!q || typeof q !== "object") return null;
  const x = q as { kind?: string; measure?: string; dimension?: string };
  return x.kind ? `${x.kind}|${x.measure ?? ""}|${x.dimension ?? ""}` : null;
}

/** A reply in words from a query's result, when no model is at hand: the measure and its value, or the top groups. */
function plainReply(output: unknown): string {
  const o = output as { query?: { kind?: string; measure?: string; dimension?: string }; rows?: { group?: unknown; value?: unknown }[] };
  const rows = o.rows ?? [];
  const n = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-US", { maximumFractionDigits: 2 }) : String(v ?? "–"));
  if (o.query?.kind === "value" || rows.length === 1) return `${o.query?.measure ?? "Value"}: ${n(rows[0]?.value)}.`;
  return `${o.query?.measure ?? "Value"} by ${o.query?.dimension ?? "group"}: ${rows.slice(0, 8).map((r) => `${String(r.group ?? "–")} ${n(r.value)}`).join("; ")}.`;
}

export function reuseLayer(o: ReuseOptions) {
  const now = o.now ?? (() => new Date());
  const store: AnswerStore = typeof o.store === "string" ? fileAnswerStore(o.store, { maxEntries: () => o.settings().maxEntries, now, log: o.log }) : o.store;
  const on = () => {
    const s = o.settings();
    return s.on && s.enabled;
  };
  const warn = (what: string) => (err: unknown) => o.log?.(`reuse: ${what}: ${err instanceof Error ? err.message : String(err)}`);

  const keys = (t: ReuseTurn, kind: "answer" | "edit") => ({
    scope: scopeOf(t.ctx),
    // The board's filters and the viewer's selections are part of an answer's version; an edit's board is its content hash.
    version: shortHash(canonical({ pack: packHash(t.pack), prompt: t.promptVersion ?? null, rules: t.rules ?? null, ...(kind === "answer" ? { filters: t.config.filters, selections: t.selections ?? {} } : t.view?.tabs?.length ? { view: t.view.tabs } : {}) })),
    replyLang: t.picked ?? "auto",
  });
  const expired = (e: Entry) => !e.pinned && now().getTime() - Date.parse(e.createdAt) > o.settings().ttlHours * 3_600_000;
  const asked = (e: Entry) => {
    e.asked = [...e.asked, now().getTime()].slice(-60);
  };

  /** The entries a turn may be served from: same pack, scope and version. Expired ones are dropped on the way. */
  async function candidates(t: ReuseTurn): Promise<Entry[]> {
    const a = keys(t, "answer");
    const ed = keys(t, "edit");
    const before = boardHash(t.config);
    const out: Entry[] = [];
    for (const e of await store.entries()) {
      if (expired(e)) {
        await store.delete(e.id);
        continue;
      }
      if (e.pack !== t.packName) continue;
      if (e.kind === "answer" && e.board === t.board && e.scope === a.scope && e.version === a.version) out.push(e);
      if (e.kind === "edit" && !t.readOnly && e.boardBefore === before && e.scope === ed.scope && e.version === ed.version) out.push(e);
    }
    return out;
  }

  const tools = (t: ReuseTurn, boards?: BoardStore, held = false) =>
    new Map(boardTools({ pack: t.pack, connector: t.connector, store: boards ?? t.store, boardId: t.board, ctx: t.ctx, proposals: t.proposals, readOnly: t.readOnly, held, onEdit: t.onEdit, onData: t.onData, ...(t.view ? { view: t.view } : {}) }).map((x) => [x.name, x]));

  /** Runs a plan's data calls again under the asker's own access. Null when one fails: the full assistant answers instead. */
  async function rerun(t: ReuseTurn, plan: Call[]): Promise<Call[] | null> {
    const byName = tools(t);
    const out: Call[] = [];
    for (const c of plan) {
      if (!DATA_TOOLS.has(c.tool)) {
        out.push(c);
        continue;
      }
      const ir = irOf(c);
      let output: unknown;
      if (ir) output = await checkedQuery(ir, { pack: t.pack, connector: t.connector, ctx: t.ctx });
      else {
        const tool = byName.get(c.tool);
        const args = tool?.inputSchema.safeParse(c.input);
        if (!tool || !args?.success) return null;
        output = await tool.execute(args.data);
      }
      if (failed(output)) return null;
      out.push({ tool: c.tool, input: c.input, output });
    }
    return out;
  }

  /** The reply for fresh results: by template when safe, else one small rewrite call; null when neither works. */
  async function replyFor(t: ReuseTurn, e: Entry, fresh: Call[], opt: { swap?: [string, string][]; language?: string; noTemplate?: string; noModel?: boolean }): Promise<{ text: string; how: string } | null> {
    const before = e.plan.filter((c) => DATA_TOOLS.has(c.tool)).map((c) => c.output);
    const after = fresh.filter((c) => DATA_TOOLS.has(c.tool)).map((c) => c.output);
    let reply = e.reply;
    for (const [from, to] of opt.swap ?? []) reply = reply.replace(new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), to);
    let why = opt.noTemplate ?? (opt.language ? "another language" : undefined);
    if (!why) {
      const r = retemplate(reply, before, after, { question: t.question, lang: e.lang });
      if (r.ok) return { text: r.text, how: r.swapped ? `template (${r.swapped} numbers)` : "template (no number changed)" };
      why = r.why;
    }
    if (opt.noModel || !t.small) return null;
    try {
      const text = await t.small.complete(REWRITE_PROMPT, rewriteMessage({ question: t.question, reply, before, after, language: opt.language }), 1500);
      return text.trim() ? { text: text.trim(), how: `rewritten by ${t.small.name}: ${why}` } : null;
    } catch (err) {
      warn("rewrite failed")(err);
      return null;
    }
  }

  /** Keeps a turn's work as an entry (or refreshes the one it replaces). */
  async function keep(t: ReuseTurn, kind: "answer" | "edit", plan: Call[], reply: string, k2: { costUsd: number; model: string; dataAsOf?: string; from?: Entry }) {
    const k = keys(t, kind);
    const norm = normalise(t.question);
    const before = kind === "edit" ? boardHash(t.config) : undefined;
    const id = shortHash([kind, t.packName, k.scope, k.version, k.replyLang, norm, kind === "answer" ? t.board : before].join("\u0000"));
    const old = await store.get(id);
    const slotted = kind === "answer" ? slotsOf(t.question, plan) : null;
    const at = now().toISOString();
    const e: Entry = {
      id,
      kind,
      pack: t.packName,
      board: t.board,
      scope: k.scope,
      access: accessOf(t.ctx),
      version: k.version,
      lang: guessLanguage(t.question, t.picked),
      replyLang: k.replyLang,
      question: old?.question ?? t.question.trim().slice(0, 500),
      norm,
      variants: old?.variants ?? [],
      ...(slotted ? { pattern: slotted.pattern, slots: slotted.slots } : {}),
      plan,
      reply,
      dataAsOf: k2.dataAsOf ?? at,
      ...(before ? { boardBefore: before } : {}),
      costUsd: old?.costUsd ?? k2.costUsd,
      model: old?.model ?? k2.model,
      createdAt: old?.createdAt ?? at,
      lastHit: old?.lastHit ?? null,
      hits: old?.hits ?? 0,
      asked: old?.asked ?? [],
      tierCounts: old?.tierCounts ?? emptyTiers(),
      pinned: old?.pinned ?? false,
    };
    if (!k2.from) asked(e);
    await store.put(e);
    return e;
  }

  async function served(t: ReuseTurn, e: Entry, tier: Tier, calls: Call[], reply: string, dataAsOf: string, how?: string): Promise<Served> {
    e.hits++;
    e.tierCounts[tier]++;
    e.lastHit = now().toISOString();
    asked(e);
    const wording = t.question.trim().slice(0, 500);
    if (normalise(wording) !== normalise(e.question) && !e.variants.includes(wording)) e.variants = [...e.variants, wording].slice(-10);
    await store.put(e);
    const spent = t.spentUsd?.() ?? 0;
    const average = (await store.averageTurn(t.builder)) ?? e.costUsd;
    const savedUsd = Math.max(0, Math.round((average - spent) * 1e6) / 1e6);
    await store.count({ tier, savedUsd });
    const note: ServedNote = { tier, entry: e.id, kind: e.kind, dataAsOf, savedUsd, question: e.question, ...(how ? { how } : {}) };
    return { tier, entry: e, reply, calls, note, savedUsd, dataAsOf, ...(how ? { why: how } : {}) };
  }

  /** An answer entry served for this turn: as it is (fresh data), or with its plan run again. */
  async function answer(t: ReuseTurn, e: Entry, tier: Tier, opt: { plan?: Call[]; swap?: [string, string][]; language?: string; noTemplate?: string } = {}): Promise<Served | null> {
    const day = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: t.pack.timeZone ?? "UTC" }).format(d);
    const age = now().getTime() - Date.parse(e.dataAsOf);
    // The same question on data read moments ago (and the same day): the saved reply as it is.
    const sameData = !opt.plan && !opt.language && age < o.settings().freshMinutes * 60_000 && day(new Date(e.dataAsOf)) === day(now());
    if (sameData) return served(t, e, tier === "t2" ? "t1" : tier, e.plan, e.reply, e.dataAsOf);
    const fresh = await rerun(t, opt.plan ?? e.plan);
    if (!fresh) return null;
    const reply = await replyFor(t, e, fresh, opt);
    if (!reply) return null;
    const at = now().toISOString();
    // The fresh results and reply become the entry's (or, for another slot or language, a new entry's), so the next ask is T1.
    if (!opt.plan && !opt.language) {
      e.plan = fresh;
      e.reply = reply.text;
      e.dataAsOf = at;
      return served(t, e, tier, fresh, reply.text, at, reply.how);
    }
    const s = await served(t, e, tier, fresh, reply.text, at, reply.how);
    if (standalone(t.question, t.firstTurn)) await keep(t, "answer", fresh, reply.text, { costUsd: e.costUsd, model: e.model, dataAsOf: at, from: e });
    return s;
  }

  /** A suggested question with a checked query: the query runs, a small model (or a plain line) says the result, and it is kept. */
  async function example(t: ReuseTurn, ex: { question: string; query: Query }): Promise<Served | null> {
    const plan: Call[] = [{ tool: "query", input: { ir: ex.query } }];
    const fresh = await rerun(t, plan);
    if (!fresh) return null;
    const results = fresh.map((c) => c.output);
    let reply = "";
    let how = "a suggested question's checked query, said plainly";
    if (t.small) {
      try {
        reply = (await t.small.complete(PHRASE_PROMPT, phraseMessage({ question: t.question, results, language: t.picked && t.picked !== "auto" ? t.picked : undefined }), 600)).trim();
        how = `a suggested question's checked query, said by ${t.small.name}`;
      } catch (err) {
        warn("phrasing failed")(err);
      }
    }
    if (!reply) reply = plainReply(results[0]);
    const e = await keep(t, "answer", fresh, reply, { costUsd: 0, model: t.builder });
    return served(t, e, "t2", fresh, reply, e.dataAsOf, how);
  }

  /** An edit entry replayed: the same edits on a board with the same content, saved together, or not at all. */
  async function edit(t: ReuseTurn, e: Entry, tier: Tier): Promise<Served | null> {
    const staged = stagedStore(t.store, t.board);
    const byName = tools(t, staged, true);
    const out: Call[] = [];
    for (const c of e.plan) {
      const tool = byName.get(c.tool);
      const args = tool?.inputSchema.safeParse(c.input);
      const output = tool && args?.success ? await tool.execute(args.data) : null;
      if (!isApplied(output)) {
        staged.discard();
        return null;
      }
      out.push({ tool: c.tool, input: c.input, output });
    }
    try {
      await staged.commit({ asOne: false });
    } catch {
      return null;
    }
    return served(t, e, tier, out, e.reply, now().toISOString(), "replayed an accepted edit");
  }

  /** A slot's text in a new question, checked: a value the dimension has (as the data writes it), or a time phrase. */
  async function slotValue(t: ReuseTurn, s: Slot, text: string): Promise<Slot | null> {
    const norm = normalise(text);
    if (s.kind === "time") {
      const p = timePhrase(norm);
      return p && p.text === norm ? { kind: "time", text: norm, time: p.time } : null;
    }
    const lookup = tools(t).get("list_values");
    if (!lookup) return null;
    const r = (await lookup.execute({ dimension: s.dimension, q: text, limit: 50 })) as { ok?: boolean; values?: { value: string }[] };
    const hit = r?.ok ? r.values?.find((v) => normalise(String(v.value)) === norm) : undefined;
    return hit ? { kind: "value", dimension: s.dimension, text: norm, value: String(hit.value) } : null;
  }

  /** The plan and reply changes for new slot values; null when a value is not known. */
  async function reslot(t: ReuseTurn, e: Entry, texts: (string | undefined)[]) {
    const slots = e.slots ?? [];
    const next: Slot[] = [];
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i]!;
      const text = texts[i];
      const v = text === undefined || normalise(text) === s.text ? s : await slotValue(t, s, text);
      if (!v) return null;
      next.push(v);
    }
    const changed = next.some((n, i) => n.text !== slots[i]!.text);
    const swap = next.flatMap((n, i) => {
      const s = slots[i]!;
      return s.kind === "value" && n.kind === "value" && n.value !== s.value ? [[s.value, n.value] as [string, string]] : [];
    });
    const timeChanged = next.some((n, i) => n.kind === "time" && n.text !== slots[i]!.text);
    return { changed, plan: slotInto(e.plan, slots, next), swap, noTemplate: timeChanged ? "the time period changed, so dates in the reply would" : undefined };
  }

  /** T4: one small call to pair the question with a saved one, and the slot values it names. */
  async function route(t: ReuseTurn, pool: Entry[], norm: string): Promise<Served | null> {
    if (!t.small || o.settings().router !== "on") return null;
    // Saved questions that share words with this one; one in another language shares none, so it is a candidate anyway.
    const lang = guessLanguage(t.question, t.picked);
    const ranked = pool
      .map((e) => ({ e, s: Math.max(similarity(norm, e.norm), ...e.variants.map((v) => similarity(norm, normalise(v)))) }))
      .filter((x) => x.s >= 0.15 || x.e.lang !== lang)
      .sort((a, b) => b.s - a.s)
      .slice(0, ROUTER_CANDIDATES)
      .map((x) => x.e);
    if (!ranked.length) return null;
    let r: ReturnType<typeof parseRoute> = null;
    try {
      r = parseRoute(await t.small.complete(ROUTER_PROMPT, routerMessage(t.question, ranked), 400), ranked.map((e) => e.id));
    } catch (err) {
      warn("router failed")(err);
      return null;
    }
    const e = r?.match ? ranked.find((x) => x.id === r!.match) : undefined;
    if (!e) return null;
    if (e.kind === "edit") return lang === e.lang ? edit(t, e, "t4") : null;
    // A slot the router left out keeps its value only if the question still says it.
    const texts = (e.slots ?? []).map((s) => r!.slots[slotName(s)] ?? (` ${norm} `.includes(` ${s.text} `) ? s.text : "\u0000"));
    if (texts.includes("\u0000")) return null;
    const rs = await reslot(t, e, texts);
    if (!rs) return null;
    const language = lang !== e.lang || (t.picked ?? "auto") !== e.replyLang ? lang : undefined;
    return answer(t, e, "t4", { ...(rs.changed ? { plan: rs.plan, swap: rs.swap, noTemplate: rs.noTemplate } : {}), language });
  }

  // Pre-warming: the host says how to build a turn for an entry; a timer checks the schedule.
  let turnFor: TurnFor | null = null;
  let zone = "UTC";
  const ranOn = new Map<string, string>();
  let running: Promise<PrewarmRun | null> | null = null;
  let lastPrewarm: PrewarmRun | null = null;
  let dataTimer: Promise<PrewarmRun | null> | null = null;

  /** Refreshes the most-asked answers per board and access scope: queries again, reply by template or (within maxUsd) a small rewrite. */
  function prewarm(reason: PrewarmRun["reason"], pack?: string | null): Promise<PrewarmRun | null> {
    if (!turnFor || !on()) return Promise.resolve(null);
    if (running) return running;
    const make = turnFor;
    running = (async () => {
      const s = o.settings().prewarm;
      const run: PrewarmRun = { at: now().toISOString(), reason, pack: pack ?? null, entries: 0, refreshed: 0, rewritten: 0, skipped: 0, failed: 0, spentUsd: 0, modelCalls: 0 };
      const since = now().getTime() - 14 * 86_400_000;
      const groups = new Map<string, Entry[]>();
      for (const e of await store.entries()) {
        if (e.kind !== "answer" || expired(e) || (pack && e.pack !== pack)) continue;
        const k = [e.pack, e.board, e.scope].join("\u0000");
        groups.set(k, [...(groups.get(k) ?? []), e]);
      }
      const asks = (e: Entry) => e.asked.filter((x) => x >= since).length;
      for (const list of groups.values()) {
        const top = list.filter((e) => e.pinned || asks(e) > 0).sort((a, b) => Number(b.pinned) - Number(a.pinned) || asks(b) - asks(a)).slice(0, s.topN);
        for (const e of top) {
          run.entries++;
          let made: Awaited<ReturnType<TurnFor>> = null;
          try {
            made = await make(e);
            if (!made) {
              run.skipped++;
              continue;
            }
            const fresh = await rerun(made.turn, e.plan);
            // Past the cap, only replies that need no model are refreshed; the rest wait for their next ask.
            const reply = fresh && (await replyFor(made.turn, e, fresh, { noModel: run.spentUsd >= s.maxUsd }));
            if (!fresh || !reply) {
              if (fresh) run.skipped++;
              else run.failed++;
              continue;
            }
            e.plan = fresh;
            e.reply = reply.text;
            e.dataAsOf = now().toISOString();
            await store.put(e);
            if (reply.how.startsWith("rewritten")) run.rewritten++;
            else run.refreshed++;
          } catch (err) {
            run.failed++;
            warn(`refresh of ${e.id} failed`)(err);
          } finally {
            const spent = made?.spent();
            if (spent) {
              run.modelCalls += spent.calls;
              run.spentUsd = Math.round((run.spentUsd + spent.usd) * 1e6) / 1e6;
            }
          }
        }
      }
      lastPrewarm = run;
      o.log?.(`reuse: refresh (${reason}) updated ${run.refreshed + run.rewritten} of ${run.entries} saved answers (${run.rewritten} rewritten, $${run.spentUsd})`);
      return run;
    })().finally(() => {
      running = null;
    });
    return running;
  }

  /** The schedule: a refresh at each configured time, once a day. */
  function tick(): Promise<PrewarmRun | null> | null {
    const s = o.settings().prewarm;
    if (!s.enabled || !turnFor || !on()) return null;
    const tz = s.timeZone ?? zone;
    const due = dueTimes(s.times, now(), tz, ranOn);
    if (!due.length) return null;
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now());
    for (const t of due) ranOn.set(t, date);
    return prewarm("schedule");
  }

  return {
    store,
    /**
     * The host's way to build a turn for a saved answer, for refreshes, and the time zone the
     * schedule is read in when the settings name none. Starts the minute timer for the schedule.
     */
    attach(make: TurnFor, timeZone?: string) {
      turnFor = make;
      if (timeZone) zone = timeZone;
      if (o.timer === false) return;
      const every = setInterval(() => void tick(), 60_000);
      every.unref?.();
    },
    /** Checks the schedule now (the timer calls it every minute). */
    tick,
    /** Refreshes now (an admin's request); pack: only that pack's answers. */
    prewarm: (pack?: string | null) => prewarm("admin", pack),
    /** A dataset's data changed: a refresh a few seconds later (several changes at once make one refresh). */
    dataChanged(pack?: string | null, delayMs = 5000): Promise<PrewarmRun | null> {
      if (dataTimer) return dataTimer;
      dataTimer = new Promise<void>((r) => setTimeout(r, delayMs).unref?.()).then(() => {
        dataTimer = null;
        return prewarm("data", pack);
      });
      return dataTimer;
    },

    /** Before the agent: a saved answer for this turn, or null (the full assistant answers). Never throws. */
    async serve(t: ReuseTurn): Promise<Served | null> {
      if (!on() || t.fresh) return null;
      try {
        // What the board shows, for "a chart would answer this" (chart candidates).
        const info = await store.board(t.board);
        const widgets = [...new Set(Object.values(t.config.widgets ?? {}).map((w) => signatureOf((w as { query?: unknown }).query)).filter((s): s is string => !!s))];
        if (widgets.join(",") !== info.widgets.join(",")) await store.setBoard(t.board, { ...info, widgets });
        if (!standalone(t.question, t.firstTurn)) return null;
        const norm = normalise(t.question);
        const pool = await candidates(t);
        const replyLang = t.picked ?? "auto";
        const exact = pool.find((e) => e.norm === norm && e.replyLang === replyLang);
        if (exact) {
          const s = exact.kind === "edit" ? await edit(t, exact, "t1") : await answer(t, exact, "t2");
          if (s) return s;
        }
        // A suggested question asked for the first time: its checked query, no agent.
        const ex = t.examples?.find((x) => normalise(x.question) === norm);
        if (ex && !exact) {
          const s = await example(t, ex);
          if (s) return s;
        }
        if (!pool.length) return null;
        for (const e of pool) {
          if (e.kind !== "answer" || !e.pattern || e.replyLang !== replyLang) continue;
          const texts = fill(e.pattern, norm);
          if (!texts) continue;
          const r = await reslot(t, e, texts);
          if (!r?.changed) continue;
          const s = await answer(t, e, "t3", { plan: r.plan, swap: r.swap, noTemplate: r.noTemplate });
          if (s) return s;
        }
        return await route(t, pool, norm);
      } catch (e) {
        warn("not served; the assistant answers instead")(e);
        return null;
      }
    },

    /** After a full turn: keep it when it ended well and stands on its own. */
    async remember(t: ReuseTurn, r: TurnOutcome): Promise<void> {
      if (!on()) return;
      try {
        await store.count({});
        if (!r.completed) return;
        await store.turnCost(t.builder, r.costUsd);
        const reply = r.reply.trim();
        if (!reply || r.fixed || !standalone(t.question, t.firstTurn)) return;
        const calls = r.calls.map((c) => ({ tool: c.tool, input: (c.input ?? {}) as Record<string, unknown>, output: c.output }));
        if (r.saved.length) {
          if (!r.accepted) return;
          const edits = calls.filter((c) => isApplied(c.output)).map(({ tool, input }) => ({ tool, input }));
          if (edits.length) await keep(t, "edit", edits, reply, { costUsd: r.costUsd, model: t.builder });
          return;
        }
        // An answer: only calls that read data or the pack, and at least the data calls succeeded.
        if (calls.some((c) => !DATA_TOOLS.has(c.tool) && !PACK_TOOLS.has(c.tool))) return;
        const plan = calls.filter((c) => DATA_TOOLS.has(c.tool) && !failed(c.output));
        // Every data call failed (refused, an unknown key, the source down): the reply answers nothing, and replaying
        // it would repeat a refusal or an outage with no query run. Not kept.
        if (!plan.length && calls.some((c) => DATA_TOOLS.has(c.tool))) return;
        if (JSON.stringify(plan).length > MAX_PLAN_CHARS) return;
        await keep(t, "answer", plan, reply, { costUsd: r.costUsd, model: t.builder });
      } catch (e) {
        warn("could not keep the turn")(e);
      }
    },

    /** Whether a turn's edits replay an edit plan already accepted on a board with the same content: the reviewer need not look again. */
    async acceptedBefore(t: ReuseTurn, steps: { toolResults?: { toolName?: string; input?: unknown; output?: unknown }[] }[]): Promise<boolean> {
      if (!on()) return false;
      const edits = steps.flatMap((s) => (s.toolResults ?? []).filter((r) => isApplied(r.output)).map((r) => ({ tool: r.toolName ?? "", input: r.input ?? {} })));
      if (!edits.length) return false;
      const k = keys(t, "edit");
      const before = boardHash(t.config);
      const plan = canonical(edits);
      return (await store.entries()).some((e) => e.kind === "edit" && e.pack === t.packName && e.scope === k.scope && e.version === k.version && e.boardBefore === before && canonical(e.plan.map(({ tool, input }) => ({ tool, input }))) === plan);
    },

    /** Every audit event: a change to a board counts toward its edit frequency (settled boards). */
    noteEvent(e: { board?: string; action: string; outcome: string; detail?: string }) {
      if (!e.board || e.outcome !== "ok") return;
      const isEdit = ["ops", "layout", "revert", "chat-save"].includes(e.action) || (e.action === "chat-edit" && !String(e.detail ?? "").includes("draft"));
      if (!isEdit) return;
      const board = e.board;
      void (async () => {
        const info = await store.board(board);
        const cutoff = now().getTime() - 90 * 86_400_000;
        await store.setBoard(board, { ...info, edits: [...info.edits.filter((x) => x >= cutoff), now().getTime()].slice(-500) });
      })().catch(warn("could not count the edit"));
    },

    /** The most-asked questions on a board, for the chat's suggestion chips; scope null: every scope (admins). */
    async suggestions(q: { board: string; pack?: string; scope?: KeptCtx | null; lang?: string | null; limit?: number }): Promise<string[]> {
      const scope = q.scope ? scopeOf(q.scope) : null;
      const since = now().getTime() - 30 * 86_400_000;
      const lang = q.lang && q.lang !== "auto" ? q.lang.slice(0, 2) : null;
      const seen = new Set<string>();
      return (await store.entries())
        .filter((e) => e.kind === "answer" && e.board === q.board && (!q.pack || e.pack === q.pack) && (!scope || e.scope === scope) && (!lang || e.lang === lang) && !expired(e))
        .map((e) => ({ e, n: e.asked.filter((x) => x >= since).length }))
        .filter((x) => x.n >= 2 || x.e.pinned)
        .sort((a, b) => Number(b.e.pinned) - Number(a.e.pinned) || b.n - a.n || (b.e.lastHit ?? "").localeCompare(a.e.lastHit ?? ""))
        .map((x) => x.e.question)
        .filter((x) => !seen.has(normalise(x)) && seen.add(normalise(x)))
        .slice(0, q.limit ?? 5);
    },

    /** For the admin API: the stats, the last refresh, and every entry. */
    async list() {
      const week = now().getTime() - 7 * 86_400_000;
      return {
        stats: await store.stats(),
        prewarm: lastPrewarm,
        entries: (await store.entries())
          .sort((a, b) => (b.lastHit ?? b.createdAt).localeCompare(a.lastHit ?? a.createdAt))
          .map((e) => ({
            id: e.id,
            board: e.board,
            question: e.question,
            variants: e.variants,
            kind: e.kind,
            hits: e.hits,
            lastHit: e.lastHit,
            createdAt: e.createdAt,
            pinned: e.pinned,
            tierCounts: e.tierCounts,
            dataAsOf: e.dataAsOf,
            lang: e.lang,
            asks7d: e.asked.filter((x) => x >= week).length,
          })),
      };
    },
    async pin(id: string, pinned: boolean) {
      const e = await store.get(id);
      if (!e) return false;
      e.pinned = pinned;
      await store.put(e);
      return true;
    },
    evict: (id: string) => store.delete(id),

    /** Questions asked often that no chart on their board answers: candidates for a new chart. */
    async chartCandidates(q: { minAsks?: number; days?: number } = {}) {
      const since = now().getTime() - (q.days ?? 14) * 86_400_000;
      const min = q.minAsks ?? 3;
      const boards = await store.boards();
      const out: { id: string; board: string; question: string; variants: string[]; asks: number; query: unknown; lastHit: string | null }[] = [];
      for (const e of await store.entries()) {
        if (e.kind !== "answer") continue;
        const asks = e.asked.filter((x) => x >= since).length;
        const first = e.plan.find((c) => c.tool === "query");
        const query = first && (first.output as { query?: unknown } | undefined)?.query;
        const sig = signatureOf(query);
        if (asks < min || !sig || (boards[e.board]?.widgets ?? []).includes(sig)) continue;
        out.push({ id: e.id, board: e.board, question: e.question, variants: e.variants, asks, query, lastHit: e.lastHit });
      }
      return out.sort((a, b) => b.asks - a.asks);
    },

    /** How often each board was changed: a board with no change in a week is settled. */
    async boards() {
      const t = now().getTime();
      return Object.entries(await store.boards())
        .filter(([, b]) => b.edits.length)
        .map(([board, b]) => {
          const edits7d = b.edits.filter((x) => x >= t - 7 * 86_400_000).length;
          return { board, edits7d, edits30d: b.edits.filter((x) => x >= t - 30 * 86_400_000).length, edits90d: b.edits.length, lastEdit: new Date(Math.max(...b.edits)).toISOString(), settled: edits7d === 0 };
        })
        .sort((a, b) => a.board.localeCompare(b.board));
    },

    flush: () => store.flush(),
  };
}
