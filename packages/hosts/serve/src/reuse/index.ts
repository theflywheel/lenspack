// Answer and plan reuse: the chat answers a question it has answered before without the model.
//
// People ask the same few dozen questions every day, and settle on a dashboard after a few edits.
// So a turn the full assistant answered well is kept: the question, the calls that answered it
// (the queries with their results, or the edits) and the reply. A later question is matched,
// cheapest first:
//   T1  the same question, data read moments ago: the saved reply and results, no model, no query;
//   T2  the same question, older data: the saved queries run again, the reply's numbers swapped
//       for the fresh ones by template (or, when that is not safe, one small "rewrite with these
//       numbers" call), no agent;
//   T3  the same question with another place or time (a slot): the plan with them swapped in, as T2;
//   T4  a different wording: one small router call picks a saved question, or none; a match runs as T2/T3.
// Only turns that ended well are kept (an answer with data, or edits the reviewer accepted), only
// for the same access scope, pack, definitions, prompt version, board filters and language rules.
// See docs/caching.md.

import { type ModelMessage, type UIMessage, type UIMessageChunk, generateText } from "ai";

import { type BoardConfig, type BoardStore, stagedStore } from "@lenspack/core";
import type { Connector, Ctx } from "@lenspack/engine";
import { type BoardToolsOptions, type ProposalStore, boardTools } from "@lenspack/agent";
import type { Pack } from "@lenspack/pack";

import type { AuditEvent } from "../audit";
import { type Provider, effortFor, shapeCall } from "../llm";
import { type CallRecord, type MeterScope, withMeter } from "../metering";
import { PROMPT_VERSION } from "../prompt";
import { retemplate } from "./numbers";
import { REWRITE_PROMPT, ROUTER_PROMPT, parseRoute, rewriteMessage, routerMessage, slotName } from "./router";
import type { CacheSettings } from "./settings";
import { type Call, type Slot, fill, slotInto, slotsOf, timePhrase } from "./slots";
import { type Entry, type ReuseStore, type Tier, emptyTiers, reuseStore } from "./store";
import { canonical, guessLanguage, normalise, shortHash, similarity, standalone } from "./text";

export { CACHE_DEFAULTS, type CacheSettings, type CacheSettingsStore, cacheSettings, cacheSettingsFrom } from "./settings";
export { type Entry, type Stats, type Tier } from "./store";
export { retemplate } from "./numbers";
export { cacheRoutes } from "./routes";
export { normalise, similarity, standalone } from "./text";
export { fill, slotsOf, timePhrase } from "./slots";

/** Calls that read data: what a plan re-runs. */
const DATA_TOOLS = new Set(["query", "list_values"]);
/** Calls that only look at the pack: harmless in an answer, and not re-run. */
const PACK_TOOLS = new Set(["list_metrics", "explain"]);
/** A kept plan's results, at most this many characters, so the store stays small. */
const MAX_PLAN_CHARS = 200_000;
/** How many saved questions the router is shown. */
const ROUTER_CANDIDATES = 8;

/** One chat turn, as the store sees it: who asks what, where, and with what. */
export type ReuseTurn = {
  packName: string;
  pack: Pack;
  board: string;
  /** The board as the asker is shown it, at the start of the turn. */
  config: BoardConfig;
  /** The asker's engine context: tenant, row scope, hidden keys and datasets. */
  ctx: Ctx;
  /** The pack's source, metered for this turn. */
  connector: Connector;
  store: BoardStore;
  proposals?: ProposalStore;
  question: string;
  messages: UIMessage[];
  /** The language picked in the chat ("auto" or a code), if any. */
  picked?: string;
  /** The deployment's language rules this turn runs under. */
  rules?: unknown;
  readOnly?: string;
  /** "Ask fresh": the full assistant answers, whatever is saved. */
  fresh?: boolean;
  /** The model the full assistant would have used: what a saved answer is said to save. */
  builder: Pick<Provider, "name">;
  providers: Provider[];
  /** The provider named for the router role, if any. */
  routerName?: string;
  /** The turn's metering scope; the router and rewrite calls run in it. */
  meter: MeterScope;
  /** The turn's model calls so far (the scope collects them). */
  calls: CallRecord[];
  onEdit?: BoardToolsOptions["onEdit"];
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

/** A turn served from the store: the stream parts to send (usage and finish are the caller's), and what to audit. */
export type Served = { tier: Tier; entry: Entry; reply: string; chunks: UIMessageChunk[]; savedUsd: number; dataAsOf: string; why?: string };

export type ReuseOptions = {
  /** reuse.json, in the state directory. */
  file: string;
  /** The effective settings, read on every turn (the feature switch and the settings page). */
  settings: () => CacheSettings & { on: boolean };
  log?: (line: string) => void;
  now?: () => Date;
};

export type Reuse = ReturnType<typeof reuseLayer>;

const scopeOf = (ctx: Ctx) => shortHash(canonical({ tenant: ctx.tenant ?? null, scope: ctx.scope ?? [], hidden: [...(ctx.hidden ?? [])].sort(), entities: [...(ctx.hiddenEntities ?? [])].sort() }));
const packHashes = new WeakMap<Pack, string>();
const packHash = (p: Pack) => {
  let h = packHashes.get(p);
  if (!h) packHashes.set(p, (h = shortHash(canonical(p))));
  return h;
};
/** A board's content, without its title: two boards with the same widgets, layout and filters hash the same. */
export const boardHash = (c: BoardConfig) => shortHash(canonical({ ...c, title: "" }));
const firstTurn = (messages: UIMessage[]) => messages.filter((m) => m.role === "user").length <= 1;
const isApplied = (o: unknown) => !!o && typeof o === "object" && (o as { applied?: unknown }).applied === true;
const failed = (o: unknown) => !o || typeof o !== "object" || (o as { ok?: unknown }).ok === false || (o as { applied?: unknown }).applied === false || "error" in (o as object);

/** A query's kind, measure and dimension: what a dashboard chart would have to show to answer it. */
function signatureOf(q: unknown): string | null {
  if (!q || typeof q !== "object") return null;
  const x = q as { kind?: string; measure?: string; dimension?: string };
  return x.kind ? `${x.kind}|${x.measure ?? ""}|${x.dimension ?? ""}` : null;
}

export function reuseLayer(o: ReuseOptions) {
  const now = o.now ?? (() => new Date());
  const store: ReuseStore = reuseStore(o.file, { maxEntries: () => o.settings().maxEntries, now, log: o.log });
  const on = () => {
    const s = o.settings();
    return s.on && s.enabled;
  };

  const keys = (t: ReuseTurn, kind: "answer" | "edit") => ({
    scope: scopeOf(t.ctx),
    // The board's filters are part of an answer's version; an edit's board is its content hash.
    version: shortHash(canonical({ pack: packHash(t.pack), prompt: PROMPT_VERSION, rules: t.rules ?? null, ...(kind === "answer" ? { filters: t.config.filters } : {}) })),
    replyLang: t.picked ?? "auto",
  });
  const expired = (e: Entry) => !e.pinned && now().getTime() - Date.parse(e.createdAt) > o.settings().ttlHours * 3_600_000;
  const asked = (e: Entry) => {
    e.asked = [...e.asked, now().getTime()].slice(-60);
  };

  /** The entries a turn may be served from: same pack, scope and version, in date. Expired ones are dropped on the way. */
  function candidates(t: ReuseTurn): Entry[] {
    const a = keys(t, "answer");
    const ed = keys(t, "edit");
    const before = boardHash(t.config);
    const out: Entry[] = [];
    for (const e of store.entries()) {
      if (expired(e)) {
        store.delete(e.id);
        continue;
      }
      if (e.pack !== t.packName) continue;
      if (e.kind === "answer" && e.board === t.board && e.scope === a.scope && e.version === a.version) out.push(e);
      if (e.kind === "edit" && !t.readOnly && e.boardBefore === before && e.scope === ed.scope && e.version === ed.version) out.push(e);
    }
    return out;
  }

  const tools = (t: ReuseTurn, store?: BoardStore, held = false) =>
    new Map(boardTools({ pack: t.pack, connector: t.connector, store: store ?? t.store, boardId: t.board, ctx: t.ctx, proposals: t.proposals, readOnly: t.readOnly, held, onEdit: t.onEdit }).map((x) => [x.name, x]));

  /** Runs a plan's data calls again under the asker's own access. Null when one fails: the full assistant answers instead. */
  async function rerun(t: ReuseTurn, plan: Call[]): Promise<Call[] | null> {
    const byName = tools(t);
    const out: Call[] = [];
    for (const c of plan) {
      if (!DATA_TOOLS.has(c.tool)) {
        out.push(c);
        continue;
      }
      const tool = byName.get(c.tool);
      const args = tool?.inputSchema.safeParse(c.input);
      if (!tool || !args?.success) return null;
      const output = await tool.execute(args.data);
      if (failed(output)) return null;
      out.push({ tool: c.tool, input: c.input, output });
    }
    return out;
  }

  /** The cheap model: the router role's provider, else a Haiku, else the turn's own model. */
  function cheap(t: ReuseTurn): Provider | null {
    const up = (p?: Provider) => (p && p.available !== false ? p : undefined);
    return up(t.providers.find((p) => p.name === t.routerName)) ?? up(t.providers.find((p) => /haiku/i.test(p.model))) ?? up(t.providers.find((p) => p.name === t.builder.name)) ?? null;
  }
  async function small(t: ReuseTurn, p: Provider, system: string, user: string, maxOutputTokens: number): Promise<string> {
    const effort = p.efforts ? effortFor(p, p.efforts.levels.includes("low") ? "low" : null) : undefined;
    const messages: ModelMessage[] = [{ role: "user", content: user }];
    const r = await withMeter({ ...t.meter, role: "reuse", effort }, () => generateText({ model: p.languageModel, ...shapeCall(p, { system: [system], messages, effort }), maxOutputTokens }));
    return r.text.trim();
  }

  /** The reply for fresh results: by template when safe, else one small rewrite call; null when neither works. */
  async function replyFor(t: ReuseTurn, e: Entry, fresh: Call[], opt: { swap?: [string, string][]; language?: string; noTemplate?: string }): Promise<{ text: string; how: string } | null> {
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
    const p = cheap(t);
    if (!p) return null;
    try {
      const text = await small(t, p, REWRITE_PROMPT, rewriteMessage({ question: t.question, reply, before, after, language: opt.language }), 1500);
      return text ? { text, how: `rewritten by ${p.name}: ${why}` } : null;
    } catch (err) {
      o.log?.(`reuse: rewrite failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  const chunksFor = (calls: Call[], reply: string, note: Record<string, unknown>): UIMessageChunk[] => [
    { type: "start" },
    ...(calls.length
      ? ([
          { type: "start-step" },
          ...calls.flatMap((c, i) => [
            { type: "tool-input-available", toolCallId: `saved-${i}`, toolName: c.tool, input: c.input },
            { type: "tool-output-available", toolCallId: `saved-${i}`, output: c.output },
          ]),
          { type: "finish-step" },
        ] as UIMessageChunk[])
      : []),
    { type: "start-step" },
    { type: "text-start", id: "saved-reply" },
    { type: "text-delta", id: "saved-reply", delta: reply },
    { type: "text-end", id: "saved-reply" },
    { type: "finish-step" },
    { type: "data-reuse", data: note },
  ];

  /** Keeps a full turn's work as an entry (or refreshes the one it replaces). */
  function keep(t: ReuseTurn, kind: "answer" | "edit", plan: Call[], reply: string, o: { costUsd: number; model: string; dataAsOf?: string; from?: Entry }) {
    const k = keys(t, kind);
    const norm = normalise(t.question);
    const before = kind === "edit" ? boardHash(t.config) : undefined;
    const id = shortHash([kind, t.packName, k.scope, k.version, k.replyLang, norm, kind === "answer" ? t.board : before].join("\u0000"));
    const old = store.get(id);
    const slotted = kind === "answer" ? slotsOf(t.question, plan) : null;
    const at = now().toISOString();
    const e: Entry = {
      id,
      kind,
      pack: t.packName,
      board: t.board,
      scope: k.scope,
      version: k.version,
      lang: guessLanguage(t.question, t.picked),
      replyLang: k.replyLang,
      question: old?.question ?? t.question.trim().slice(0, 500),
      norm,
      variants: old?.variants ?? [],
      ...(slotted ? { pattern: slotted.pattern, slots: slotted.slots } : {}),
      plan,
      reply,
      dataAsOf: o.dataAsOf ?? at,
      ...(before ? { boardBefore: before } : {}),
      costUsd: old?.costUsd ?? o.costUsd,
      model: old?.model ?? o.model,
      createdAt: old?.createdAt ?? at,
      lastHit: old?.lastHit ?? null,
      hits: old?.hits ?? 0,
      asked: old?.asked ?? [],
      tierCounts: old?.tierCounts ?? emptyTiers(),
      pinned: old?.pinned ?? false,
    };
    if (!o.from) asked(e);
    store.put(e);
    return e;
  }

  function served(t: ReuseTurn, e: Entry, tier: Tier, calls: Call[], reply: string, dataAsOf: string, how?: string): Served {
    e.hits++;
    e.tierCounts[tier]++;
    e.lastHit = now().toISOString();
    asked(e);
    const wording = t.question.trim().slice(0, 500);
    if (normalise(wording) !== normalise(e.question) && !e.variants.includes(wording)) e.variants = [...e.variants, wording].slice(-10);
    store.touch();
    const spent = t.calls.reduce((s, c) => s + (c.usd ?? 0), 0);
    const average = store.averageTurn(t.builder.name) ?? e.costUsd;
    const savedUsd = Math.max(0, Math.round((average - spent) * 1e6) / 1e6);
    store.count({ tier, savedUsd });
    const note = { tier, entry: e.id, kind: e.kind, dataAsOf, savedUsd, question: e.question, ...(how ? { how } : {}) };
    return { tier, entry: e, reply, chunks: chunksFor(calls, reply, note), savedUsd, dataAsOf, ...(how ? { why: how } : {}) };
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
    const s = served(t, e, tier, fresh, reply.text, at, reply.how);
    if (standalone(t.question, firstTurn(t.messages))) keep(t, "answer", fresh, reply.text, { costUsd: e.costUsd, model: e.model, dataAsOf: at, from: e });
    return s;
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
    const p = cheap(t);
    if (!p || o.settings().router !== "on") return null;
    // Saved questions that share words with this one; one in another language shares none, so it is a candidate anyway.
    const asked = guessLanguage(t.question, t.picked);
    const ranked = pool
      .map((e) => ({ e, s: Math.max(similarity(norm, e.norm), ...e.variants.map((v) => similarity(norm, normalise(v)))) }))
      .filter((x) => x.s >= 0.15 || x.e.lang !== asked)
      .sort((a, b) => b.s - a.s)
      .slice(0, ROUTER_CANDIDATES)
      .map((x) => x.e);
    if (!ranked.length) return null;
    let route: ReturnType<typeof parseRoute> = null;
    try {
      route = parseRoute(await small(t, p, ROUTER_PROMPT, routerMessage(t.question, ranked), 400), ranked.map((e) => e.id));
    } catch (err) {
      o.log?.(`reuse: router failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    const e = route?.match ? ranked.find((x) => x.id === route!.match) : undefined;
    if (!e) return null;
    const lang = guessLanguage(t.question, t.picked);
    if (e.kind === "edit") return lang === e.lang ? edit(t, e, "t4") : null;
    // A slot the router left out keeps its value only if the question still says it.
    const texts = (e.slots ?? []).map((s) => route!.slots[slotName(s)] ?? (` ${norm} `.includes(` ${s.text} `) ? s.text : "\u0000"));
    if (texts.includes("\u0000")) return null;
    const r = await reslot(t, e, texts);
    if (!r) return null;
    const language = lang !== e.lang || (t.picked ?? "auto") !== e.replyLang ? lang : undefined;
    return answer(t, e, "t4", { ...(r.changed ? { plan: r.plan, swap: r.swap, noTemplate: r.noTemplate } : {}), language });
  }

  return {
    store,
    /** Before the agent: a saved answer for this turn, or null (the full assistant answers). Never throws. */
    async serve(t: ReuseTurn): Promise<Served | null> {
      if (!on() || t.fresh) return null;
      try {
        // What the board shows, for "a chart would answer this" (chart candidates).
        const info = store.board(t.board);
        const widgets = [...new Set(Object.values(t.config.widgets ?? {}).map((w) => signatureOf((w as { query?: unknown }).query)).filter((s): s is string => !!s))];
        if (widgets.join(",") !== info.widgets.join(",")) (info.widgets = widgets), store.touch();
        if (!standalone(t.question, firstTurn(t.messages))) return null;
        const pool = candidates(t);
        if (!pool.length) return null;
        const norm = normalise(t.question);
        const replyLang = t.picked ?? "auto";
        const exact = pool.find((e) => e.norm === norm && e.replyLang === replyLang);
        if (exact) {
          const s = exact.kind === "edit" ? await edit(t, exact, "t1") : await answer(t, exact, "t2");
          if (s) return s;
        }
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
        o.log?.(`reuse: ${e instanceof Error ? e.message : String(e)}; the assistant answers instead`);
        return null;
      }
    },

    /** After a full turn: keep it when it ended well and stands on its own. */
    remember(t: ReuseTurn, r: TurnOutcome) {
      if (!on()) return;
      try {
        store.count({});
        if (!r.completed) return;
        store.turnCost(t.builder.name, r.costUsd);
        const reply = r.reply.trim();
        if (!reply || r.fixed || !standalone(t.question, firstTurn(t.messages))) return;
        const calls = r.calls.map((c) => ({ tool: c.tool, input: (c.input ?? {}) as Record<string, unknown>, output: c.output }));
        if (r.saved.length) {
          if (!r.accepted) return;
          const edits = calls.filter((c) => isApplied(c.output)).map(({ tool, input }) => ({ tool, input }));
          if (edits.length) keep(t, "edit", edits, reply, { costUsd: r.costUsd, model: t.builder.name });
          return;
        }
        // An answer: only calls that read data or the pack, and at least the data calls succeeded.
        if (calls.some((c) => !DATA_TOOLS.has(c.tool) && !PACK_TOOLS.has(c.tool))) return;
        const plan = calls.filter((c) => DATA_TOOLS.has(c.tool) && !failed(c.output));
        if (JSON.stringify(plan).length > MAX_PLAN_CHARS) return;
        keep(t, "answer", plan, reply, { costUsd: r.costUsd, model: t.builder.name });
      } catch (e) {
        o.log?.(`reuse: could not keep the turn: ${e instanceof Error ? e.message : String(e)}`);
      }
    },

    /** Whether a turn's edits replay an edit plan already accepted on a board with the same content: the reviewer need not look again. */
    acceptedBefore(t: ReuseTurn, steps: { toolResults?: { toolName?: string; input?: unknown; output?: unknown }[] }[]): boolean {
      if (!on()) return false;
      const edits = steps.flatMap((s) => (s.toolResults ?? []).filter((r) => isApplied(r.output)).map((r) => ({ tool: r.toolName ?? "", input: r.input ?? {} })));
      if (!edits.length) return false;
      const k = keys(t, "edit");
      const before = boardHash(t.config);
      const plan = canonical(edits);
      return store.entries().some((e) => e.kind === "edit" && e.pack === t.packName && e.scope === k.scope && e.version === k.version && e.boardBefore === before && canonical(e.plan.map(({ tool, input }) => ({ tool, input }))) === plan);
    },

    /** Every audit event: a change to a board counts toward its edit frequency (settled boards). */
    noteEvent(e: AuditEvent) {
      if (!e.board || e.outcome !== "ok") return;
      const edit = ["ops", "layout", "revert", "chat-save"].includes(e.action) || (e.action === "chat-edit" && !String(e.detail ?? "").includes("draft"));
      if (!edit) return;
      const info = store.board(e.board);
      const cutoff = now().getTime() - 90 * 86_400_000;
      info.edits = [...info.edits.filter((x) => x >= cutoff), now().getTime()].slice(-500);
      store.touch();
    },

    /** The most-asked questions on a board, for the chat's suggestion chips; scope null: every scope (admins). */
    suggestions(q: { board: string; pack?: string; scope?: Ctx | null; lang?: string | null; limit?: number }): string[] {
      const scope = q.scope ? scopeOf(q.scope) : null;
      const since = now().getTime() - 30 * 86_400_000;
      const lang = q.lang && q.lang !== "auto" ? q.lang.slice(0, 2) : null;
      const seen = new Set<string>();
      return store
        .entries()
        .filter((e) => e.kind === "answer" && e.board === q.board && (!q.pack || e.pack === q.pack) && (!scope || e.scope === scope) && (!lang || e.lang === lang) && !expired(e))
        .map((e) => ({ e, n: e.asked.filter((x) => x >= since).length }))
        .filter((x) => x.n >= 2 || x.e.pinned)
        .sort((a, b) => Number(b.e.pinned) - Number(a.e.pinned) || b.n - a.n || (b.e.lastHit ?? "").localeCompare(a.e.lastHit ?? ""))
        .map((x) => x.e.question)
        .filter((q) => !seen.has(normalise(q)) && seen.add(normalise(q)))
        .slice(0, q.limit ?? 5);
    },

    /** For the admin API: the stats and every entry. */
    list() {
      const week = now().getTime() - 7 * 86_400_000;
      return {
        stats: store.stats(),
        entries: store
          .entries()
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
    pin(id: string, pinned: boolean) {
      const e = store.get(id);
      if (!e) return false;
      e.pinned = pinned;
      store.touch();
      return true;
    },
    evict: (id: string) => store.delete(id),

    /** Questions asked often that no chart on their board answers: candidates for a new chart. */
    chartCandidates(q: { minAsks?: number; days?: number } = {}) {
      const since = now().getTime() - (q.days ?? 14) * 86_400_000;
      const min = q.minAsks ?? 3;
      const out: { id: string; board: string; question: string; variants: string[]; asks: number; query: unknown; lastHit: string | null }[] = [];
      for (const e of store.entries()) {
        if (e.kind !== "answer") continue;
        const asks = e.asked.filter((x) => x >= since).length;
        const first = e.plan.find((c) => c.tool === "query");
        const query = first && (first.output as { query?: unknown } | undefined)?.query;
        const sig = signatureOf(query);
        if (asks < min || !sig || store.board(e.board).widgets.includes(sig)) continue;
        out.push({ id: e.id, board: e.board, question: e.question, variants: e.variants, asks, query, lastHit: e.lastHit });
      }
      return out.sort((a, b) => b.asks - a.asks);
    },

    /** How often each board was changed: a board with no change in a week is settled. */
    boards() {
      const t = now().getTime();
      return Object.entries(store.boards())
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
