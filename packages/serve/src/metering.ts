import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { dirname } from "node:path";

import { type LanguageModel, type LanguageModelUsage, wrapLanguageModel } from "ai";

import { type QueryMeter, emptyQueryMeter } from "@lenspack/engine";

// What the models cost. Metered at the model, not at the call site: every
// provider's model is wrapped when it is built, so every call through any
// adapter (a chat round, a review, a probe, an eval, the visual judge) is
// one record, priced from the provider's rates. Who a call is for comes from
// the scope it runs in (withMeter), carried by AsyncLocalStorage through the
// SDK's tool loop; a call in no scope is still counted, as role "other".
// A provider with no price is counted in tokens and reported as unpriced,
// never as free.

/**
 * US dollars per million tokens, as providers publish them. A cache read or
 * write with no price of its own is charged as plain input.
 */
export type Pricing = { input: number; output: number; cachedInput?: number; cacheWrite?: number };

/** One call's tokens. Cache reads and writes are parts of inputTokens; reasoning is part of outputTokens. */
export type Tokens = { inputTokens: number; cachedInputTokens: number; cacheWriteTokens: number; outputTokens: number; reasoningTokens: number };

/** Usage as a provider reports it to the SDK (LanguageModelV4Usage), the shape an adapter's model returns. */
export type ProviderUsage = {
  inputTokens: { total?: number; noCache?: number; cacheRead?: number; cacheWrite?: number };
  outputTokens: { total?: number; text?: number; reasoning?: number };
};

export type Usage = Tokens & {
  calls: number;
  /** Calls that ended in an error. */
  failed: number;
  /** Cost of the priced calls. */
  usd: number;
  /** Calls whose provider has no price: their tokens are counted, their cost is not in usd. */
  unpriced: number;
};

export type Role = "build" | "escalate" | "review" | "probe" | "eval" | "judge" | "other";

/** Who and what a call is for. */
export type Attribution = {
  role: Role;
  user?: string;
  pack?: string;
  board?: string;
  turn?: string;
  /** The effort the call ran at, for a provider that takes one. */
  effort?: string;
};

/** One model call, as every sink receives it and the usage file keeps it. */
export type CallRecord = Attribution &
  Tokens & {
    at: string;
    provider: string;
    model: string;
    /** The adapter kind. */
    kind: string;
    /** null when the provider has no price: unpriced, not free. */
    usd: number | null;
    priced: boolean;
    ms: number;
    ok: boolean;
    error?: string;
  };

/** Where call records go: the in-memory ledger, the usage file, anything else. A sink that throws is skipped, never the call. */
export type UsageSink = { record(r: CallRecord): void };

/** What the metering wrapper needs to know about a provider. buildProvider fills it from the config and the adapter. */
export type MeterInfo = { provider: string; model: string; kind: string; pricing?: Pricing; tokens?: (u: ProviderUsage) => Tokens };

export const emptyUsage = (): Usage => ({ calls: 0, failed: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, usd: 0, unpriced: 0 });

/** Uncached input, cache reads, cache writes and output, each at its own rate. */
export function costOf(t: Tokens, pricing: Pricing): number {
  const plain = t.inputTokens - t.cachedInputTokens - t.cacheWriteTokens;
  return (plain * pricing.input + t.cachedInputTokens * (pricing.cachedInput ?? pricing.input) + t.cacheWriteTokens * (pricing.cacheWrite ?? pricing.input) + t.outputTokens * pricing.output) / 1e6;
}

/** The provider-level usage shape as metered tokens; what an adapter gets unless it maps its own. */
export function tokensOf(u: ProviderUsage | undefined): Tokens {
  const i = u?.inputTokens ?? {};
  const o = u?.outputTokens ?? {};
  const cachedInputTokens = i.cacheRead ?? 0;
  const cacheWriteTokens = i.cacheWrite ?? 0;
  return {
    inputTokens: i.total ?? (i.noCache ?? 0) + cachedInputTokens + cacheWriteTokens,
    cachedInputTokens,
    cacheWriteTokens,
    outputTokens: o.total ?? (o.text ?? 0) + (o.reasoning ?? 0),
    reasoningTokens: o.reasoning ?? 0,
  };
}

/** A call-level SDK usage (result.usage), priced. For callers outside the wrapped models. */
export function usageOf(u: LanguageModelUsage | undefined, pricing?: Pricing, calls = 1): Usage {
  const t: Tokens = {
    inputTokens: u?.inputTokens ?? 0,
    cachedInputTokens: u?.inputTokenDetails?.cacheReadTokens ?? 0,
    cacheWriteTokens: u?.inputTokenDetails?.cacheWriteTokens ?? 0,
    outputTokens: u?.outputTokens ?? 0,
    reasoningTokens: u?.outputTokenDetails?.reasoningTokens ?? 0,
  };
  return { calls, failed: 0, ...t, usd: pricing ? costOf(t, pricing) : 0, unpriced: pricing ? 0 : calls };
}

export function usageOfRecord(r: CallRecord): Usage {
  return { calls: 1, failed: r.ok ? 0 : 1, inputTokens: r.inputTokens, cachedInputTokens: r.cachedInputTokens, cacheWriteTokens: r.cacheWriteTokens, outputTokens: r.outputTokens, reasoningTokens: r.reasoningTokens, usd: r.usd ?? 0, unpriced: r.priced ? 0 : 1 };
}

const USAGE_KEYS = Object.keys(emptyUsage()) as (keyof Usage)[];

/** Adds u's counts into `into` (which may carry labels beside them, as a ModelLine does). */
export function addUsage<U extends Usage>(into: U, u: Usage): U {
  for (const k of USAGE_KEYS) into[k] += u[k];
  return into;
}

const round = (usd: number) => Math.round(usd * 1e6) / 1e6;
const rounded = <U extends Usage>(u: U): U => ({ ...u, usd: round(u.usd) });

// --- scopes ---------------------------------------------------------------

type Frame = { attribution: Partial<Attribution>; sinks: UsageSink[]; collectors: CallRecord[][] };

const frames = new AsyncLocalStorage<Frame>();
const globalSinks = new Set<UsageSink>();

/** A sink for every metered call in the process, in a scope or not. Returns a function that removes it. */
export function addUsageSink(sink: UsageSink): () => void {
  globalSinks.add(sink);
  return () => globalSinks.delete(sink);
}

export type MeterScope = Partial<Attribution> & {
  /** Sinks for the calls in this scope, beside the process-wide ones. */
  sinks?: UsageSink[];
  /** Every call in this scope is also pushed here: a turn's own summary. */
  collect?: CallRecord[];
};

/**
 * Runs fn with its model calls attributed to the scope. Scopes nest: an inner
 * one keeps what it does not set (a round's role inside a turn's user and pack).
 */
export function withMeter<T>(scope: MeterScope, fn: () => T): T {
  const parent = frames.getStore();
  const { sinks, collect, ...attribution } = scope;
  const set = Object.fromEntries(Object.entries(attribution).filter(([, v]) => v !== undefined));
  return frames.run(
    {
      attribution: { ...parent?.attribution, ...set },
      sinks: [...(parent?.sinks ?? []), ...(sinks ?? [])],
      collectors: [...(parent?.collectors ?? []), ...(collect ? [collect] : [])],
    },
    fn,
  );
}

/** The attribution a call made here would get. */
export function currentAttribution(): Attribution {
  return { role: "other", ...frames.getStore()?.attribution };
}

function emit(frame: Frame | undefined, r: CallRecord) {
  for (const c of frame?.collectors ?? []) c.push(r);
  for (const sink of new Set([...globalSinks, ...(frame?.sinks ?? [])])) {
    try {
      sink.record(r);
    } catch {
      // A full disk or a broken sink must not fail the call it describes.
    }
  }
}

/** Starts timing a call in the current scope; end() records it once, however the call ends. */
function startCall(info: MeterInfo) {
  // Captured now: the scope is the caller's, whichever stream reader finishes the call.
  const frame = frames.getStore();
  const started = performance.now();
  const at = new Date().toISOString();
  let done = false;
  return (usage: ProviderUsage | undefined, error?: unknown) => {
    if (done) return;
    done = true;
    const t = (info.tokens ?? tokensOf)(usage ?? { inputTokens: {}, outputTokens: {} });
    const message = error === undefined ? undefined : (error instanceof Error ? error.message : String(error)).slice(0, 300);
    emit(frame, {
      at,
      provider: info.provider,
      model: info.model,
      kind: info.kind,
      role: "other",
      ...frame?.attribution,
      ...t,
      usd: info.pricing ? round(costOf(t, info.pricing)) : null,
      priced: !!info.pricing,
      ms: Math.round(performance.now() - started),
      ok: error === undefined,
      ...(message !== undefined ? { error: message } : {}),
    });
  };
}

/**
 * The same model, every call recorded: a generate when it returns or throws,
 * a stream when its finish part has passed (or it errs or is cancelled).
 */
export function meterModel(model: Exclude<LanguageModel, string>, info: MeterInfo): Exclude<LanguageModel, string> {
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v4",
      wrapGenerate: async ({ doGenerate }) => {
        const end = startCall(info);
        try {
          const out = await doGenerate();
          end(out.usage);
          return out;
        } catch (e) {
          end(undefined, e);
          throw e;
        }
      },
      wrapStream: async ({ doStream }) => {
        const end = startCall(info);
        let out: Awaited<ReturnType<typeof doStream>>;
        try {
          out = await doStream();
        } catch (e) {
          end(undefined, e);
          throw e;
        }
        let usage: ProviderUsage | undefined;
        let error: unknown;
        type Part = { type: string; usage?: ProviderUsage; error?: unknown };
        const observe: Transformer<Part, Part> & { cancel?: (reason: unknown) => void } = {
          transform(part, controller) {
            if (part.type === "finish") usage = part.usage;
            else if (part.type === "error" && error === undefined) error = part.error ?? "stream error";
            controller.enqueue(part);
          },
          flush: () => end(usage, error ?? (usage ? undefined : "stream ended before it finished")),
          cancel: (reason) => end(usage, reason ?? "cancelled"),
        };
        return { ...out, stream: (out.stream as ReadableStream<Part>).pipeThrough(new TransformStream(observe)) as typeof out.stream };
      },
    },
  }) as Exclude<LanguageModel, string>;
}

// --- a turn ---------------------------------------------------------------

export type ModelLine = { role: Role; provider: string; model: string; effort?: string } & Usage;

/** What one chat turn cost, for the stream, the audit line and the ledger. */
export type TurnCost = { total: Usage; models: ModelLine[]; queries: QueryMeter };

/** A turn's calls, one line per role and provider, and the queries its tools ran. */
export function turnCost(calls: CallRecord[], queries: QueryMeter = emptyQueryMeter()): TurnCost {
  const models: ModelLine[] = [];
  for (const r of calls) {
    const line = models.find((m) => m.role === r.role && m.provider === r.provider);
    if (line) addUsage(line, usageOfRecord(r));
    else models.push({ role: r.role, provider: r.provider, model: r.model, ...(r.effort ? { effort: r.effort } : {}), ...usageOfRecord(r) });
  }
  return { total: rounded(models.reduce((t, m) => addUsage(t, m), emptyUsage())), models: models.map(rounded), queries: { ...queries, ms: Math.round(queries.ms) } };
}

// --- the ledger -----------------------------------------------------------

type Key = { day: string; user: string; pack: string };
/** byEffort: the calls that ran at an effort, by provider and then effort. */
type Entry = Key & { turnIds: Set<string>; llm: Usage; byProvider: Record<string, Usage>; byRole: Partial<Record<Role, Usage>>; byEffort: Record<string, Record<string, Usage>>; queries: QueryMeter };

const dayOf = (at: Date | string) => (typeof at === "string" ? at : at.toISOString()).slice(0, 10);

/**
 * Running totals by day (UTC), user and pack, for GET /api/_usage and the
 * budget. A sink: every metered call lands here. Since the last restart,
 * unless restored from the usage file.
 */
export function usageLedger() {
  const entries = new Map<string, Entry>();
  const packQueries = new Map<string, QueryMeter>();
  let since = new Date().toISOString();
  const entry = (k: Key) => {
    const id = `${k.day}\u0000${k.user}\u0000${k.pack}`;
    let e = entries.get(id);
    if (!e) entries.set(id, (e = { ...k, turnIds: new Set(), llm: emptyUsage(), byProvider: {}, byRole: {}, byEffort: {}, queries: emptyQueryMeter() }));
    return e;
  };
  const record = (r: CallRecord) => {
    const e = entry({ day: dayOf(r.at), user: r.user ?? "-", pack: r.pack ?? "-" });
    const u = usageOfRecord(r);
    addUsage(e.llm, u);
    addUsage((e.byProvider[r.provider] ??= emptyUsage()), u);
    addUsage((e.byRole[r.role] ??= emptyUsage()), u);
    if (r.effort) addUsage(((e.byEffort[r.provider] ??= {})[r.effort] ??= emptyUsage()), u);
    if (r.turn) e.turnIds.add(r.turn);
  };
  return {
    record,
    /** Today's calls from the usage file, so a restart does not reset the totals or the budget. */
    restore(records: CallRecord[]) {
      for (const r of records) {
        record(r);
        if (r.at < since) since = r.at;
      }
    },
    /** The meter every query a pack runs is counted into, board loads and chat tools alike. */
    queriesOf(pack: string) {
      let m = packQueries.get(pack);
      if (!m) packQueries.set(pack, (m = emptyQueryMeter()));
      return m;
    },
    /** A finished turn's queries. Its model calls arrived one by one through record. */
    turn(k: Omit<Key, "day">, cost: Pick<TurnCost, "queries">, at = new Date()) {
      const e = entry({ ...k, day: dayOf(at) });
      e.queries.queries += cost.queries.queries;
      e.queries.failed += cost.queries.failed;
      e.queries.ms += cost.queries.ms;
      e.queries.rows += cost.queries.rows;
    },
    /** Priced spend on a day (today by default), for one user or everyone. */
    spent(opts: { user?: string; at?: Date } = {}) {
      const day = dayOf(opts.at ?? new Date());
      let usd = 0;
      for (const e of entries.values()) if (e.day === day && (opts.user === undefined || e.user === opts.user)) usd += e.llm.usd;
      return usd;
    },
    report() {
      const rows = [...entries.values()].sort((a, b) => b.day.localeCompare(a.day) || b.llm.usd - a.llm.usd);
      const total = rows.reduce((t, e) => addUsage(t, e.llm), emptyUsage());
      return {
        since,
        total: { turns: rows.reduce((s, e) => s + e.turnIds.size, 0), ...rounded(total) },
        packs: Object.fromEntries([...packQueries].map(([p, m]) => [p, { ...m, ms: Math.round(m.ms) }])),
        turns: rows.map(({ turnIds, ...e }) => ({
          ...e,
          turns: turnIds.size,
          llm: rounded(e.llm),
          byProvider: Object.fromEntries(Object.entries(e.byProvider).map(([k, u]) => [k, rounded(u)])),
          byRole: Object.fromEntries(Object.entries(e.byRole).map(([k, u]) => [k, rounded(u!)])),
          byEffort: Object.fromEntries(Object.entries(e.byEffort).map(([p, levels]) => [p, Object.fromEntries(Object.entries(levels).map(([k, u]) => [k, rounded(u)]))])),
          queries: { ...e.queries, ms: Math.round(e.queries.ms) },
        })),
      };
    },
  };
}

export type UsageLedger = ReturnType<typeof usageLedger>;

// --- the usage file -------------------------------------------------------

/** One JSON line per call, appended as it ends, so usage outlives the process. */
export function jsonlUsageSink(path: string): UsageSink {
  mkdirSync(dirname(path), { recursive: true });
  return { record: (r) => appendFileSync(path, `${JSON.stringify(r)}\n`) };
}

/** How far back from the end of the file a restore reads: a day of calls, many times over. */
const RESTORE_BYTES = 32 * 1024 * 1024;

/**
 * The calls of one day (today by default) from a usage file. It is append-only
 * and in time order, so only its tail is read.
 */
export function readUsageFile(path: string, at = new Date()): CallRecord[] {
  if (!existsSync(path)) return [];
  const day = dayOf(at);
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, RESTORE_BYTES);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    const lines = buf.toString("utf8").split("\n");
    if (length < size) lines.shift(); // a partial first line
    const out: CallRecord[] = [];
    for (const line of lines) {
      if (!line.startsWith("{")) continue;
      try {
        const r = JSON.parse(line) as CallRecord;
        if (typeof r.at === "string" && r.at.startsWith(day)) out.push(r);
      } catch {
        // A line cut short by a crash.
      }
    }
    return out;
  } finally {
    closeSync(fd);
  }
}

// --- the budget -----------------------------------------------------------

/** Daily caps on priced spend, in US dollars, per UTC day. */
export type Budget = { usdPerDay?: number; usdPerUserPerDay?: number };

/** The caps and today's priced spend against them: the server's, and each user's. */
export function budgetReport(ledger: UsageLedger, budget: Budget, at = new Date()) {
  const users: Record<string, number> = {};
  for (const row of ledger.report().turns) if (row.day === dayOf(at) && row.user !== "-") users[row.user] = round((users[row.user] ?? 0) + row.llm.usd);
  return { ...budget, day: dayOf(at), spent: round(ledger.spent({ at })), users };
}

/** Why chat must wait until tomorrow, or null. Only priced calls count; probes have no user, so never count against one. */
export function overBudget(ledger: UsageLedger, budget: Budget | undefined, user: string, at = new Date()): string | null {
  if (!budget) return null;
  const day = budget.usdPerDay !== undefined ? ledger.spent({ at }) : 0;
  if (budget.usdPerDay !== undefined && day >= budget.usdPerDay)
    return `Chat has used today's budget for this server (US$${day.toFixed(2)} of US$${budget.usdPerDay.toFixed(2)}). It resets at 00:00 UTC.`;
  const mine = budget.usdPerUserPerDay !== undefined ? ledger.spent({ user, at }) : 0;
  if (budget.usdPerUserPerDay !== undefined && mine >= budget.usdPerUserPerDay)
    return `You have used today's chat budget (US$${mine.toFixed(2)} of US$${budget.usdPerUserPerDay.toFixed(2)}). It resets at 00:00 UTC.`;
  return null;
}
