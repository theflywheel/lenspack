import { randomUUID } from "node:crypto";

import { generateText } from "ai";

import type { Catalogue } from "@lenspack/core";
import type { Connector, Ctx } from "@lenspack/engine";
import { type Pack, catalogueFrom } from "@lenspack/pack";

import { type Audit, type AuditEvent, turnRow } from "../audit";
import type { Features } from "../features";
import { type Provider, shapeCall } from "../llm";
import { type CallRecord, withMeter } from "../metering";
import { catalogueText } from "../prompt";
import type { SettingsStore } from "../settings";
import { compareReadings } from "./compare";
import { DAILY_PROMPT, type ReviewPlan, type ReviewProposal, type ReviewReport, type ReviewSettings, parseReport, planReview, repeats, reviewDefaults, updateSettings } from "./daily";
import { type DigestTurn, digestTurns } from "./digest";
import { type TurnDefinitions, definitionsKey } from "./hooks";
import { type Overlay, OverlayError, applyOverlay, entryLine, overlayStore } from "./overlay";
import { type DocStore, fileDocs, readDoc, updateDoc } from "./store";
import { type OpenQuestion, type QuestionLog, QuestionError, questionLog } from "./questions";
import { scheduler, slots as slotsNow } from "./schedule";

// The review system: one per server. It holds each pack's definitions overlay and open-questions
// log, the daily review's settings, runs and proposals, and the scheduler; it gives the chat its
// per-turn hooks (TurnDefinitions) and the admin panel everything it shows. Everything is kept in
// a document store (the state directory's files by default), read on every use.

export type ReviewHost = { name: string; pack: Pack; connector: Connector; ctx: Ctx; catalogue?: Catalogue };

export type ReviewSystemOptions = {
  stateDir: string;
  /** Where the definitions, open questions, proposals, runs and schedule are kept; the state directory's files by default. */
  docs?: DocStore;
  hosts: ReviewHost[];
  features: Features;
  settings: SettingsStore;
  /** The models, read when a run starts (the runtime probes them after start). */
  providers: () => Provider[];
  /** The audit events at or after a time, any order: the review reads the chat-turn lines. */
  events?: (from: Date) => AuditEvent[];
  /** Where the admin's changes are recorded. */
  audit?: Audit;
  log?: (line: string) => void;
  overlayBudget?: number;
  now?: () => Date;
  timers?: { set: (fn: () => void, ms: number) => unknown; clear: (t: unknown) => void };
  /** Questions an answer cache saw often (GET <prefix>/cache/chart-candidates), when a cache is running. */
  chartCandidates?: () => Promise<unknown[] | null>;
};

export type ProposalStatus = "pending" | "accepted" | "rejected";
export type StoredProposal = ReviewProposal & { id: string; run: string; pack: string; status: ProposalStatus; createdAt: string; decidedBy?: string; decidedAt?: string; note?: string; definition?: string };

export type PackRun = {
  pack: string;
  turns: number;
  status: "ok" | "skipped" | "failed";
  reason?: string;
  plan?: Omit<ReviewPlan, "text">;
  report?: ReviewReport;
  problems?: string[];
  proposals?: string[];
  questions?: string[];
  compared?: number;
  usd: number;
  /** u1, u2… as the report names them, to the real user names: kept on this server only. */
  users?: Record<string, string>;
  /** The turns the report cites, by number: when, who and what was asked. Kept on this server only. */
  turnIndex?: { n: number; at: string; user: string; question: string }[];
};

export type ReviewRun = {
  id: string;
  at: string;
  trigger: "schedule" | "manual";
  by: string;
  slot?: string;
  status: "running" | "ok" | "skipped" | "failed";
  reason?: string;
  settings: ReviewSettings;
  from: string;
  to: string;
  packs: PackRun[];
  usd: number;
  ms?: number;
};

const RUNS_KEPT = 90;
const DEFAULT_THINKING_ALLOWANCE = 4096;

export class ReviewBusy extends Error {}

export type ReviewSystem = ReturnType<typeof reviewSystem>;

export function reviewSystem(o: ReviewSystemOptions) {
  const now = o.now ?? (() => new Date());
  const log = o.log ?? (() => {});
  const docs = o.docs ?? fileDocs(o.stateDir);
  const hosts = new Map(o.hosts.map((h) => [h.name, h]));
  const keysOf = (h: ReviewHost) => () => new Set([...h.pack.dimensions.map((d) => d.key), ...h.pack.measures.map((m) => m.key)]);
  const overlays = new Map<string, Overlay>([...hosts.values()].map((h) => [h.name, overlayStore(docs, h.name, { keys: keysOf(h), budget: o.overlayBudget, now })]));
  const logs = new Map<string, QuestionLog>([...hosts.values()].map((h) => [h.name, questionLog(docs, h.name, { now })]));
  const host = (name: string) => {
    const h = hosts.get(name);
    if (!h) throw new QuestionError(`no pack ${name}`);
    return h;
  };
  const overlay = (name: string) => (host(name), overlays.get(name)!);
  const questions = (name: string) => (host(name), logs.get(name)!);
  const audit = (user: string, action: string, detail: string, pack?: string, outcome: AuditEvent["outcome"] = "ok") => {
    try {
      o.audit?.({ at: now().toISOString(), user, ...(pack ? { pack } : {}), action, outcome, detail: detail.slice(0, 1000) });
    } catch {
      /* the audit log never takes a change down with it */
    }
  };

  // ---- Settings ---------------------------------------------------------------------------------
  const defaultZone = [...hosts.values()].find((h) => h.pack.timeZone)?.pack.timeZone ?? "UTC";
  const defaults = reviewDefaults(defaultZone);
  const saved = () => o.settings.get<Partial<ReviewSettings>>("review") ?? {};
  const settings = (): ReviewSettings => ({ ...defaults, ...saved() });

  // ---- Proposals --------------------------------------------------------------------------------
  const PROPOSALS = "review-proposals.json";
  const allProposals = async () => (await readDoc<StoredProposal[]>(docs, PROPOSALS, () => [])).value;
  const changeProposals = <R>(fn: (list: StoredProposal[]) => { next: StoredProposal[]; result: R }) =>
    updateDoc<StoredProposal[], R>(docs, PROPOSALS, () => [], (list) => {
      const r = fn(list);
      return { next: r.next.slice(-500), result: r.result };
    });
  const proposal = async (id: string) => {
    const p = (await allProposals()).find((x) => x.id === id);
    if (!p) throw new QuestionError(`no proposal ${id}`);
    return p;
  };

  // ---- Runs -------------------------------------------------------------------------------------
  const runName = (id: string) => `review-runs/${id}.json`;
  const saveRun = async (r: ReviewRun) => {
    await docs.put(runName(r.id), JSON.stringify(r, null, 2));
    const all = await docs.list("review-runs/");
    for (const f of all.slice(0, Math.max(0, all.length - RUNS_KEPT))) await docs.remove(f);
  };
  const runs = async (): Promise<ReviewRun[]> => {
    const names = (await docs.list("review-runs/")).filter((f) => f.endsWith(".json")).reverse();
    const out: ReviewRun[] = [];
    for (const f of names) {
      try {
        const d = await docs.get(f);
        if (d) out.push(JSON.parse(d.text) as ReviewRun);
      } catch {
        /* an unreadable run is skipped */
      }
    }
    return out;
  };
  // Ids sort by time: a run's file name is when it started.
  const runId = () => `${now().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 4)}`;

  const STATE = "review-state.json";
  const state = {
    get: async (): Promise<string | null> => (await readDoc<{ lastSlot?: string }>(docs, STATE, () => ({}))).value.lastSlot ?? null,
    set: async (iso: string) => void (await docs.put(STATE, JSON.stringify({ lastSlot: iso }))),
  };

  /** The pack as the review reads it: catalogue, the pack's own rules, the admin's definitions, the open questions. */
  const contextFor = async (h: ReviewHost, turns: DigestTurn[], candidates: unknown[] | null) => {
    const entries = await overlays.get(h.name)!.entries();
    const open = await logs.get(h.name)!.list();
    const rep = repeats(turns);
    return [
      `PACK "${h.pack.pack}" (times in ${h.pack.timeZone ?? "UTC"}):`,
      catalogueText(h.pack, h.catalogue ?? catalogueFrom(h.pack)),
      `\nDOMAIN RULES (the pack's own):\n${h.pack.instructions?.trim() || "(none)"}`,
      `\nDEFINITIONS ALREADY SET BY AN ADMIN:\n${entries.map((e) => `- [${e.kind}] ${entryLine(e)}`).join("\n") || "(none)"}`,
      `\nOPEN QUESTIONS ALREADY LOGGED:\n${open.slice(0, 40).map((q) => `- (${q.status}) ${q.pattern} [${q.readings.map((r) => r.label).join(" | ")}]${q.status === "answered" ? ` → ${q.readings.find((r) => r.id === q.chosen)?.label ?? ""}` : ""}`).join("\n") || "(none)"}`,
      `\nQUESTIONS ASKED MORE THAN ONCE THIS PERIOD:\n${rep.map((r) => `- ${r.count}× "${r.question.slice(0, 160)}" (turns ${r.turns.join(", ")})`).join("\n") || "(none)"}`,
      ...(candidates?.length ? [`\nFREQUENT QUESTIONS FROM THE ANSWER CACHE:\n${JSON.stringify(candidates).slice(0, 3000)}`] : []),
    ].join("\n");
  };

  const pricingOf = (p: Provider) => p.pricing;
  const allowanceOf = (p: Provider) => (p.kind === "anthropic" ? (p.anthropic?.thinkingAllowance ?? DEFAULT_THINKING_ALLOWANCE) : 0);

  /** Each pack's turns in the period, digested; users are numbered across packs. */
  const gather = (s: ReviewSettings) => {
    const to = now();
    const from = new Date(to.getTime() - s.lookbackHours * 3_600_000);
    const events = (o.events?.(from) ?? []).filter((e) => e.action === "chat-turn" && !e.internal);
    const users = new Map<string, string>();
    const packs = [...hosts.values()].map((h) => ({ h, turns: digestTurns(events.filter((e) => e.pack === h.name), users) }));
    return { from, to, packs, users };
  };

  /** What a run would send and cost, per pack, without calling a model. */
  const estimate = async () => {
    const s = settings();
    const provider = o.providers().find((p) => p.name === s.model);
    const { from, to, packs } = gather(s);
    const candidates = o.chartCandidates ? await o.chartCandidates().catch(() => null) : null;
    let left = s.maxUsd;
    const out: Record<string, unknown>[] = [];
    for (const { h, turns } of packs) {
      if (!provider) {
        out.push({ pack: h.name, turns: turns.length, error: `the review model ${s.model} is not configured` });
        continue;
      }
      const pricing = pricingOf(provider);
      if (!pricing) {
        out.push({ pack: h.name, turns: turns.length, error: `${provider.name} has no price, so the cap cannot be enforced` });
        continue;
      }
      if (!turns.length) {
        out.push({ pack: h.name, turns: 0 });
        continue;
      }
      const plan = planReview({ turns, fixed: DAILY_PROMPT + (await contextFor(h, turns, candidates)), pricing, maxUsd: left, thinkingAllowance: allowanceOf(provider) });
      if ("error" in plan) {
        out.push({ pack: h.name, turns: turns.length, error: plan.error });
        continue;
      }
      left -= plan.worstUsd;
      const { text: _t, ...rest } = plan;
      out.push({ pack: h.name, turns: turns.length, ...rest });
    }
    return { settings: s, model: provider ? { name: provider.name, available: provider.available, priced: !!provider.pricing } : null, from: from.toISOString(), to: to.toISOString(), packs: out };
  };

  let running: Promise<ReviewRun> | null = null;

  /** One review run over every pack with turns; the cap is for the whole run. */
  async function runReview(trigger: "schedule" | "manual", by: string, slot?: Date): Promise<ReviewRun> {
    if (running) throw new ReviewBusy("a review is already running");
    const go = async (): Promise<ReviewRun> => {
      const started = Date.now();
      const s = settings();
      const { from, to, packs, users } = gather(s);
      const run: ReviewRun = { id: runId(), at: now().toISOString(), trigger, by, ...(slot ? { slot: slot.toISOString() } : {}), status: "running", settings: s, from: from.toISOString(), to: to.toISOString(), packs: [], usd: 0 };
      await saveRun(run);
      const finish = async (status: ReviewRun["status"], reason?: string) => {
        run.status = status;
        if (reason) run.reason = reason;
        run.usd = Math.round(run.packs.reduce((n, p) => n + p.usd, 0) * 1e6) / 1e6;
        run.ms = Date.now() - started;
        await saveRun(run);
        audit(by, "review run", `${trigger}: ${status}${reason ? ` (${reason})` : ""}, $${run.usd}`);
        log(`daily review ${run.id}: ${status}${reason ? ` (${reason})` : ""}, $${run.usd}`);
        return run;
      };
      const provider = o.providers().find((p) => p.name === s.model);
      if (!provider) return finish("failed", `the review model ${s.model} is not configured on this server`);
      if (provider.available === false) return finish("failed", `${provider.name} is unavailable: ${provider.error ?? ""}`);
      const pricing = pricingOf(provider);
      if (!pricing) return finish("failed", `${provider.name} has no price, so the cap of $${s.maxUsd} cannot be enforced`);
      const candidates = o.chartCandidates ? await o.chartCandidates().catch(() => null) : null;
      const names = Object.fromEntries([...users].map(([real, short]) => [short, real]));
      let left = s.maxUsd;
      for (const { h, turns } of packs) {
        const pr: PackRun = { pack: h.name, turns: turns.length, status: "skipped", usd: 0 };
        run.packs.push(pr);
        if (!turns.length) {
          pr.reason = "no turns in the period";
          continue;
        }
        if (trigger === "schedule" && turns.length < s.minTurns) {
          pr.reason = `${turns.length} turns, fewer than the ${s.minTurns} a scheduled review waits for`;
          continue;
        }
        const context = await contextFor(h, turns, candidates);
        const plan = planReview({ turns, fixed: DAILY_PROMPT + context, pricing, maxUsd: left, thinkingAllowance: allowanceOf(provider) });
        if ("error" in plan) {
          pr.status = "failed";
          pr.reason = plan.error;
          continue;
        }
        const { text, ...shape } = plan;
        pr.plan = shape;
        pr.users = Object.fromEntries(turns.map((t) => [t.user, names[t.user] ?? t.user]));
        pr.turnIndex = turns.map((t) => ({ n: t.n, at: t.at, user: t.user, question: t.question.slice(0, 200) }));
        // Counted against the cap at its worst before the call, so the run can never pass it.
        left -= plan.worstUsd;
        const calls: CallRecord[] = [];
        const content = `${context}\n\nPERIOD: ${from.toISOString()} to ${to.toISOString()}: ${turns.length} turns; ${plan.included.length} below${plan.dropped ? ` (${plan.dropped} left out to stay within the cost cap)` : ""}${plan.shortened ? `, ${plan.shortened} shortened` : ""}.\n\nTURNS:\n${text}`;
        try {
          const out = await withMeter({ role: "daily-review", user: by, pack: h.name, collect: calls }, () =>
            generateText({
              model: provider.languageModel,
              ...shapeCall(provider, { system: [DAILY_PROMPT], messages: [{ role: "user", content }] }),
              maxOutputTokens: plan.maxOutputTokens,
              abortSignal: AbortSignal.timeout(15 * 60_000),
            }),
          );
          pr.usd = Math.round(calls.reduce((n, c) => n + (c.usd ?? 0), 0) * 1e6) / 1e6;
          const parsed = parseReport(out.text);
          if ("error" in parsed) {
            pr.status = "failed";
            pr.reason = parsed.error;
            continue;
          }
          pr.status = "ok";
          pr.report = parsed.report;
          pr.problems = parsed.problems;
          // Proposals wait for an admin; questions join the log (a repeat counts against the one there).
          const made: StoredProposal[] = parsed.report.proposals.map((p) => ({ ...p, id: randomUUID().slice(0, 8), run: run.id, pack: h.name, status: "pending", createdAt: now().toISOString() }));
          if (made.length) await changeProposals((list) => ({ next: [...list, ...made], result: null }));
          pr.proposals = made.map((p) => p.id);
          pr.questions = [];
          for (const q of parsed.report.questions) {
            try {
              const examples = q.examples.length ? q.examples : q.turns.map((n) => turns.find((t) => t.n === n)?.question ?? "").filter(Boolean);
              let logged: OpenQuestion | null = null;
              for (const example of examples.length ? examples.slice(0, 3) : [undefined]) logged = await logs.get(h.name)!.note({ pattern: q.pattern, readings: q.readings, example, source: "review" });
              if (logged) pr.questions.push(logged.id);
            } catch (e) {
              pr.problems.push(`question "${q.pattern}" not logged: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
          if (o.features.on("review.compare")) pr.compared = (await compareAll(h.name)).length;
        } catch (e) {
          pr.usd = Math.round(calls.reduce((n, c) => n + (c.usd ?? 0), 0) * 1e6) / 1e6;
          pr.status = "failed";
          pr.reason = (e instanceof Error ? e.message : String(e)).slice(0, 300);
        }
        await saveRun(run);
      }
      const ran = run.packs.filter((p) => p.status !== "skipped");
      if (!ran.length) return finish("skipped", run.packs.map((p) => `${p.pack}: ${p.reason}`).join("; "));
      return finish(ran.every((p) => p.status === "failed") ? "failed" : "ok");
    };
    running = go().finally(() => (running = null));
    return running;
  }

  /** Every open question with runnable readings, compared on the data. No model is called. */
  async function compareAll(packName: string): Promise<string[]> {
    const h = host(packName);
    const done: string[] = [];
    for (const q of await logs.get(packName)!.list("open")) {
      if (q.readings.filter((r) => r.query).length < 2) continue;
      await logs.get(packName)!.setCompared(q.id, await compareReadings(q, { pack: h.pack, connector: h.connector, ctx: h.ctx, now }));
      done.push(q.id);
    }
    return done;
  }

  const schedule = scheduler({
    now,
    setTimer: o.timers?.set ?? ((fn, ms) => setTimeout(fn, ms).unref()),
    clearTimer: o.timers?.clear ?? ((t) => clearTimeout(t as NodeJS.Timeout)),
    enabled: () => o.features.on("review.daily"),
    when: () => ({ time: settings().time, timeZone: settings().timeZone }),
    lastSlot: state,
    run: (slot) => runReview("schedule", "daily-review", slot),
    log,
  });

  const turn: TurnDefinitions = {
    apply: async (name, pack, catalogue) => {
      const ov = overlays.get(name);
      return ov ? applyOverlay(await ov.entries(), pack, catalogue) : { pack, catalogue };
    },
    version: async (name, pack) => definitionsKey(pack, (await overlays.get(name)?.key()) ?? "d0"),
    clarify: () => o.features.on("clarify"),
    note: async (name, n) => {
      try {
        return (await logs.get(name)?.note(n)) ?? null;
      } catch {
        return null;
      }
    },
    choose: async (name, id, label) => {
      try {
        await logs.get(name)?.choose(id, label);
      } catch {
        /* a full disk must not cost the user the answer */
      }
    },
  };

  /** Usage by day from the audit log: turns, people, cost, errors, clarifications, reviewer findings. */
  const overview = async (days = 14) => {
    const to = now();
    const from = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate() - (days - 1)));
    const events = (o.events?.(from) ?? []).filter((e) => e.action === "chat-turn" && !e.internal);
    const byDay = new Map<string, { day: string; turns: number; users: Set<string>; costUsd: number; errors: number; refusals: number; findings: number; asked: number; assumed: number; picked: number }>();
    for (let i = 0; i < days; i++) {
      const d = new Date(from.getTime() + i * 86_400_000).toISOString().slice(0, 10);
      byDay.set(d, { day: d, turns: 0, users: new Set(), costUsd: 0, errors: 0, refusals: 0, findings: 0, asked: 0, assumed: 0, picked: 0 });
    }
    const digest = digestTurns(events);
    for (const [i, e] of [...events].sort((a, b) => a.at.localeCompare(b.at)).entries()) {
      const row = turnRow(e);
      const t = digest[i];
      const b = byDay.get(e.at.slice(0, 10));
      if (!row || !b || !t) continue;
      b.turns += 1;
      b.users.add(e.user);
      b.costUsd += row.costUsd + row.sttUsd;
      if (t.tools.some((x) => / → (error|refused)/.test(x)) || !t.answer || t.outcome === "not saved") b.errors += 1;
      if (t.refused.length) b.refusals += 1;
      if (t.findings.length) b.findings += 1;
      if (t.clarify?.startsWith("asked")) b.asked += 1;
      else if (t.clarify) b.assumed += 1;
      if (t.quickReply) b.picked += 1;
    }
    const list = [...byDay.values()].map((b) => ({ ...b, users: b.users.size, costUsd: Math.round(b.costUsd * 1e4) / 1e4 }));
    const sum = (k: "turns" | "costUsd" | "errors" | "refusals" | "findings" | "asked" | "assumed" | "picked") => Math.round(list.reduce((n, b) => n + b[k], 0) * 1e4) / 1e4;
    return {
      from: from.toISOString(),
      days: list,
      total: { turns: sum("turns"), users: new Set(events.map((e) => e.user)).size, costUsd: sum("costUsd"), errors: sum("errors"), refusals: sum("refusals"), findings: sum("findings"), asked: sum("asked"), assumed: sum("assumed"), picked: sum("picked") },
      open: (await Promise.all([...logs.values()].map((l) => l.list("open")))).reduce((n, l) => n + l.length, 0),
      pending: (await allProposals()).filter((p) => p.status === "pending").length,
      estimate: "Chat costs are estimates from list prices.",
    };
  };

  return {
    turn,
    /** The definitions version a cache keys on: changes when the pack's file or its overlay does. */
    definitionsVersion: async (packName: string) => {
      const h = host(packName);
      return definitionsKey(h.pack, await overlays.get(packName)!.key());
    },
    packs: () => [...hosts.values()].map((h) => ({ name: h.name, pack: h.pack.pack, version: h.pack.version, timeZone: h.pack.timeZone ?? "UTC" })),
    host,
    overlay,
    questions,
    settings,
    defaults,
    settingsView: async () => ({ ...settings(), defaults, enabled: o.features.on("review.daily"), compare: o.features.on("review.compare"), next: schedule.next()?.toISOString() ?? null, lastSlot: await state.get(), running: !!running }),
    updateSettings(body: Record<string, unknown>, by: string) {
      const r = updateSettings(saved(), body, o.providers().map((p) => p.name));
      if (!r.ok) return r;
      o.settings.set("review", Object.keys(r.next).length ? r.next : undefined);
      audit(by, "settings review", JSON.stringify(r.next));
      schedule.reschedule();
      return { ok: true as const };
    },
    /** The daily switch went on: slots that passed while it was off are not owed. */
    async switchedOn() {
      const { time, timeZone } = settings();
      const { last } = slotsNow(time, timeZone, now());
      await state.set(last.toISOString());
      schedule.reschedule();
    },
    reschedule: () => schedule.reschedule(),
    estimate,
    runNow: (by: string) => runReview("manual", by),
    running: () => !!running,
    runs,
    run: async (id: string) => {
      if (!/^[\w-]+$/.test(id)) return null;
      const d = await docs.get(runName(id));
      return d ? (JSON.parse(d.text) as ReviewRun) : null;
    },
    proposals: async (status?: ProposalStatus) => {
      const list = await allProposals();
      return (status ? list.filter((p) => p.status === status) : list).slice().reverse();
    },
    /** Accepting writes the overlay; an edit made first is what is written. */
    async acceptProposal(id: string, by: string, edit: Partial<ReviewProposal> = {}, why = "") {
      const p = await proposal(id);
      if (p.status !== "pending") throw new QuestionError(`proposal ${id} is already ${p.status}`);
      const merged = { ...p, ...edit };
      const { entry } = await overlay(p.pack).add({ kind: merged.kind, key: merged.key, text: merged.text, words: merged.words, when: merged.when, source: "proposal" }, by, why || merged.rationale || `proposal ${id}`);
      await changeProposals((list) => ({ next: list.map((x) => (x.id === id ? { ...merged, status: "accepted" as const, decidedBy: by, decidedAt: now().toISOString(), definition: entry.id, ...(why ? { note: why } : {}) } : x)), result: null }));
      audit(by, "proposal accept", `${id}: ${entryLine(entry)}`, p.pack);
      return { proposal: await proposal(id), entry };
    },
    async rejectProposal(id: string, by: string, why = "") {
      const p = await proposal(id);
      if (p.status !== "pending") throw new QuestionError(`proposal ${id} is already ${p.status}`);
      await changeProposals((list) => ({ next: list.map((x) => (x.id === id ? { ...x, status: "rejected" as const, decidedBy: by, decidedAt: now().toISOString(), ...(why ? { note: why } : {}) } : x)), result: null }));
      audit(by, "proposal reject", `${id}${why ? `: ${why}` : ""}`, p.pack);
      return proposal(id);
    },
    /** Answering an open question writes its reading as a definition in the overlay. */
    async answer(packName: string, id: string, reading: string, by: string, why = "") {
      const log = questions(packName);
      const q = await log.get(id);
      if (q.status === "answered") throw new QuestionError(`question ${id} is already answered`);
      const r = q.readings.find((x) => x.id === reading);
      if (!r) throw new QuestionError(`question ${id} has no reading ${reading}`);
      const how = r.query ? ` (${Object.entries(r.query).map(([k, v]) => `${k} ${v}`).join(", ")})` : r.how ? ` (${r.how})` : "";
      const { entry } = await overlay(packName).add({ kind: "definition", when: q.pattern, text: `${r.label}${r.explanation ? `: ${r.explanation}` : ""}${how}`.slice(0, 600), question: id, source: "question" }, by, why || `answered open question ${id}`);
      audit(by, "question answer", `${id}: ${q.pattern} → ${r.label}`, packName);
      return { question: await log.answer(id, reading, by, why, entry.id), entry };
    },
    async dismiss(packName: string, id: string, by: string, why = "") {
      const q = await questions(packName).dismiss(id, by, why);
      audit(by, "question dismiss", `${id}: ${q.pattern}`, packName);
      return q;
    },
    async reopen(packName: string, id: string, by: string) {
      const q = await questions(packName).reopen(id);
      audit(by, "question reopen", `${id}: ${q.pattern}`, packName);
      return q;
    },
    async addQuestion(packName: string, body: { pattern?: unknown; readings?: unknown; example?: unknown }, by: string) {
      const q = await questions(packName).note({ pattern: String(body.pattern ?? ""), readings: (Array.isArray(body.readings) ? body.readings : []) as never, example: typeof body.example === "string" ? body.example : undefined, source: "admin" });
      audit(by, "question add", `${q.id}: ${q.pattern}`, packName);
      return q;
    },
    async editQuestion(packName: string, id: string, body: { pattern?: unknown; readings?: unknown }, by: string) {
      const q = await questions(packName).edit(id, body);
      audit(by, "question edit", `${id}: ${q.pattern}`, packName);
      return q;
    },
    async compare(packName: string, id: string) {
      const h = host(packName);
      const q = await questions(packName).get(id);
      const c = await compareReadings(q, { pack: h.pack, connector: h.connector, ctx: h.ctx, now });
      await questions(packName).setCompared(id, c);
      return c;
    },
    compareAll,
    audit,
    overview,
    start: () => schedule.start(),
    stop: () => schedule.stop(),
    /** For tests: the scheduler's own check. */
    check: () => schedule.check(),
  };
}


export { OverlayError, QuestionError };
