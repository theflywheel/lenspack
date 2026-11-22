#!/usr/bin/env tsx
// pnpm eval:suite --suite <suite.yaml> [--truth truth.json] [--models a,b | --stub] [--repeats 1]
//                 [--only ids] [--tiers T1,T8] [--judge <provider>] [--max-usd 1] [--effort low]
//                 [--out dir] [--board-cache board.json] [--superset-url http://…]
//
// Accuracy against frozen truth: every question gets a fresh board and one
// chat turn (or several, for a multi-turn question) through the real chat
// endpoint, hosted in process. See evals/README.md, "Suites".
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { BoardConfig } from "@lenspack/core";
import { type CallRecord, type Provider, buildProvider, probe, providersFromEnv, turnCost, withMeter } from "@lenspack/serve";
import { generateText } from "ai";

import { type Rig, type TurnRecord, chatTurn, dirOf, exampleRig, freshBoard, serve, supersetRig, widgetData } from "./harness";
import {
  type AnswerScore,
  type DeclineLabel,
  type Outcome,
  type QueryLike,
  JUDGE_PROMPT,
  bestQuery,
  boardDiff,
  dataAsText,
  discloses,
  editMisses,
  grounding,
  heuristicDecline,
  numbersIn,
  parseJudge,
  scoreAnswer,
  soundsLikeDecline,
} from "./score";
import { stubProvider } from "./stub";
import { type Question, type Truth, type TruthFile, loadSuite, shapeRows, turnsOf } from "./suite";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

export type Result = {
  model: string;
  repeat: number;
  id: string;
  tier: string;
  expect: Question["expect"];
  tags: string[];
  why?: string;
  outcome: Outcome;
  detail: string;
  answer?: AnswerScore & { by: "reply" | "chart" };
  query?: { ok: boolean; misses: string[] };
  edit?: { misses: string[]; dataOk?: boolean };
  decline?: { label: DeclineLabel; by: "judge" | "heuristic" };
  disclosed?: boolean;
  grounded: { total: number; grounded: number; ungrounded: string[] };
  boardChanged: boolean;
  steps: number;
  toolCalls: number;
  toolErrors: number;
  latencyMs: number;
  usd: number;
  judgeUsd: number;
  inputTokens: number;
  outputTokens: number;
  unpriced: number;
  reply: string;
  calls: { tool: string; input: unknown; ok?: boolean }[];
  error?: string;
  raw?: Raw;
};

async function main() {
  const suitePath = arg("suite");
  if (!suitePath) throw new Error("--suite <file> is required");
  const suite = loadSuite(suitePath);
  // --rescore <results.json>: score a stored run again (after a scorer or truth fix), no model, no database.
  if (arg("rescore")) {
    const file = arg("rescore")!;
    const stored = JSON.parse(readFileSync(file, "utf8")) as { meta: Record<string, unknown>; results: Result[] };
    const truth = JSON.parse(readFileSync(arg("truth")!, "utf8")) as TruthFile;
    const byId = new Map(suite.questions.map((q) => [q.id, q]));
    const results = stored.results.map((r) => (r.raw && byId.get(r.id) ? scoreRaw(r.model, r.repeat, byId.get(r.id)!, truth.questions[r.id], r.raw) : r));
    const meta = { ...stored.meta, rescored: new Date().toISOString(), truthComputed: truth.computed };
    const out = file.replace(/\.json$/, "-rescored");
    writeFileSync(`${out}.json`, JSON.stringify({ meta, results }, null, 1));
    const md = report(meta, results);
    writeFileSync(`${out}.md`, md);
    console.log(`${md}\nwritten to ${out}.{json,md}`);
    return;
  }
  const now = suite.now ? new Date(suite.now) : undefined;
  const only = arg("only")?.split(",");
  const tiers = arg("tiers")?.split(",");
  const questions = suite.questions.filter((q) => (!only || only.includes(q.id)) && (!tiers || tiers.includes(q.tier)));
  const repeats = Number(arg("repeats") ?? 1);
  const maxUsd = arg("max-usd") ? Number(arg("max-usd")) : Infinity;
  const outDir = resolve(arg("out") ?? join(import.meta.dirname, "results"));
  mkdirSync(outDir, { recursive: true });

  // The rig: a deployment's Superset config, or an in-repo example on DuckDB.
  let rig: Rig;
  if (suite.config) {
    rig = await supersetRig(resolve(dirOf(suitePath), suite.config), { dashboard: suite.board.dashboard, boardCache: arg("board-cache"), now, supersetUrl: arg("superset-url") });
  } else if (suite.example) {
    rig = await exampleRig(suite.example, { board: suite.board.example_board, now });
  } else throw new Error("the suite names neither a config nor an example");
  console.log(`suite ${suite.suite}: ${questions.length} questions; pack ${rig.host.pack.pack}; seed board ${rig.seed ? `"${rig.seed.title}" (${Object.keys(rig.seed.widgets).length} widgets)` : "empty"}`);

  // Truth: frozen in a file (computed outside), or computed here when the rig owns its database.
  let truth: TruthFile;
  if (arg("truth")) truth = JSON.parse(readFileSync(arg("truth")!, "utf8")) as TruthFile;
  else if (rig.sql) {
    truth = { suite: suite.suite, computed: new Date().toISOString(), questions: {} };
    for (const q of suite.questions) {
      if (!q.truth) continue;
      const t: Truth = { shape: q.truth.shape, unit: q.truth.unit, value: shapeRows(await rig.sql(q.truth.sql), q.truth.shape), ...(q.truth.k ? { k: q.truth.k } : {}) };
      if (q.truth.universe_sql) t.universe = (await rig.sql(q.truth.universe_sql)).map((r) => String(Object.values(r)[0]));
      if (q.truth.alternatives) t.alternatives = await Promise.all(q.truth.alternatives.map(async (a) => ({ label: a.label, value: shapeRows(await rig.sql!(a.sql), q.truth!.shape) })));
      truth.questions[q.id] = t;
    }
  } else throw new Error("--truth <file> is required for this suite");
  if (truth.suite !== suite.suite) throw new Error(`truth is for suite ${truth.suite}, not ${suite.suite}`);
  console.log(`truth computed ${truth.computed}${truth.fingerprint ? `; fingerprint ${JSON.stringify(truth.fingerprint)}` : ""}`);

  // Models.
  let providers: Provider[];
  if (flag("stub")) providers = [stubProvider(suite)];
  else {
    const wanted = arg("models")?.split(",");
    const configs = providersFromEnv().filter((c) => !wanted || wanted.some((w) => c.name.includes(w)));
    if (configs.length === 0) throw new Error("No providers: set LENSPACK_LLM_PROVIDERS (and --models to pick)");
    providers = await Promise.all(configs.map((c) => probe(buildProvider(c))));
    for (const p of providers) if (!p.available) throw new Error(`${p.name} unavailable: ${p.error}`);
  }
  const judgeName = arg("judge");
  const judge = judgeName ? await probe(buildProvider(providersFromEnv().find((c) => c.name.includes(judgeName))!)) : null;
  if (judgeName && !judge?.available) throw new Error(`judge ${judgeName} unavailable`);

  const srv = await serve(rig, providers);
  const results: Result[] = [];
  let spent = 0;
  let stopped: string | null = null;
  // Interleaved: each question runs on every model (in parallel) before the next, so a run cut
  // short by the cap still compares the models on the same questions. The cap is checked
  // before each batch against the dearest batch so far, so it is never overshot by much.
  let dearest = 0;
  try {
    outer: for (let rep = 1; rep <= repeats; rep++) {
      for (const q of questions) {
        if (spent + dearest > maxUsd) {
          stopped = `stopped at $${spent.toFixed(4)} before ${q.id} #${rep}: --max-usd ${maxUsd} (dearest batch $${dearest.toFixed(4)})`;
          break outer;
        }
        const batch = await Promise.all(providers.map((p) => runQuestion(rig, srv, p, q, truth.questions[q.id], { effort: arg("effort"), judge, rep })));
        const cost = batch.reduce((t, r) => t + r.usd + r.judgeUsd, 0);
        dearest = Math.max(dearest, cost);
        spent += cost;
        for (const r of batch) {
          results.push(r);
          console.log(`  ${r.model} #${rep} ${q.id.padEnd(5)} ${r.outcome.padEnd(17)} ${String(r.latencyMs).padStart(6)}ms steps=${r.steps} $${(r.usd + r.judgeUsd).toFixed(4)}  ${r.detail.slice(0, 140)}`);
        }
        // Partial results survive a crash or a kill.
        writeFileSync(join(outDir, "_partial.json"), JSON.stringify({ spent, results }));
      }
    }
  } finally {
    await srv.close();
    await rig.close();
  }
  if (stopped) console.log(stopped);

  const stamp = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${suite.suite}`;
  const meta = { suite: suite.suite, suiteFile: basename(suitePath), pack: rig.host.pack.pack, truthComputed: truth.computed, fingerprint: truth.fingerprint ?? null, now: suite.now ?? null, effort: arg("effort") ?? null, judge: judgeName ?? null, repeats, stopped, spentUsd: spent };
  writeFileSync(join(outDir, `${stamp}.json`), JSON.stringify({ meta, results }, null, 1));
  const md = report(meta, results);
  writeFileSync(join(outDir, `${stamp}.md`), md);
  console.log(`\n${md}\nwritten to ${join(outDir, stamp)}.{json,md}`);
}

/** What a question's run left behind, enough to score it again without a model (--rescore). */
export type Raw = {
  reply: string;
  records: { steps: number; latencyMs: number; usage: TurnRecord["usage"]; error?: string }[];
  calls: TurnRecord["toolCalls"];
  before: BoardConfig;
  after: BoardConfig;
  /** The data each new or changed widget draws, as the board would run it. */
  widgetRows: Record<string, { group: string; value: number | null; values?: Record<string, number | null> }[] | null>;
  judge?: { label: DeclineLabel; by: "judge" | "heuristic"; usd: number };
};

export async function runQuestion(rig: Rig, srv: Awaited<ReturnType<typeof serve>>, p: Provider, q: Question, truth: Truth | undefined, o: { effort?: string; judge: Provider | null; rep: number }): Promise<Result> {
  const boardId = `eval-${q.id.replace(/\W/g, "_")}-${p.name.replace(/\W/g, "_")}-${o.rep}`;
  const before: BoardConfig = await freshBoard(rig, boardId);
  let history: Parameters<typeof chatTurn>[2] = [];
  const records: TurnRecord[] = [];
  for (const text of turnsOf(q)) {
    const { record, messages } = await chatTurn(srv, boardId, history, text, { model: p.name, effort: o.effort });
    records.push(record);
    history = messages;
    if (record.error && !record.reply) break;
  }
  const after = (await rig.host.store.get(boardId))!.config;
  const reply = records.at(-1)!.reply;
  const diff = boardDiff(before, after);
  const widgetRows: Raw["widgetRows"] = {};
  for (const id of [...diff.added, ...diff.changed]) {
    const w = after.widgets[id];
    if (w && "query" in w) widgetRows[id] = (await widgetData(rig, w.query))?.rows.map((r) => ({ group: r.group, value: r.value, ...(r.values ? { values: r.values } : {}) })) ?? null;
  }
  const raw: Raw = { reply, records: records.map((r) => ({ steps: r.steps, latencyMs: r.latencyMs, usage: r.usage, ...(r.error ? { error: r.error } : {}) })), calls: records.flatMap((r) => r.toolCalls), before, after, widgetRows };
  // Declines are labelled once, when the run happens; a rescore reuses the label.
  if (q.expect === "decline") {
    if (!o.judge) raw.judge = { label: heuristicDecline(reply, diff.any), by: "heuristic", usd: 0 };
    else {
      const metered: CallRecord[] = [];
      const out = await withMeter({ role: "judge", pack: rig.host.name, turn: `judge/${q.id}`, collect: metered }, () => generateText({ model: o.judge!.languageModel, prompt: JUDGE_PROMPT(turnsOf(q).join(" / "), q.note, reply), maxOutputTokens: 10 }));
      raw.judge = { label: parseJudge(out.text) ?? heuristicDecline(reply, diff.any), by: "judge", usd: turnCost(metered).total.usd };
    }
  }
  return scoreRaw(p.name, o.rep, q, truth, raw);
}

/** Scores a run from what it left behind: no model, no database. */
export function scoreRaw(model: string, rep: number, q: Question, truth: Truth | undefined, raw: Raw): Result {
  const { reply, calls, before, after } = raw;
  const outputs = calls.map((c) => c.output).filter((x) => x !== undefined);
  const okOf = (c: (typeof calls)[number]) => {
    const v = c.output as { ok?: boolean; applied?: boolean } | undefined;
    return c.error ? false : v?.ok === false || v?.applied === false ? false : true;
  };
  const diff = boardDiff(before, after);
  const queries: QueryLike[] = [
    ...calls.filter((c) => c.tool === "query" && okOf(c)).map((c) => (c.output as { query?: QueryLike }).query).filter(Boolean) as QueryLike[],
    ...[...diff.added, ...diff.changed].map((id) => after.widgets[id]).filter((w) => w && "query" in w).map((w) => (w as { query: QueryLike }).query),
  ];
  const errors = raw.records.map((r) => r.error).filter(Boolean);
  const base = {
    model,
    repeat: rep,
    id: q.id,
    tier: q.tier,
    expect: q.expect,
    tags: q.tags,
    ...(q.why ? { why: q.why } : {}),
    grounded: grounding(reply, outputs),
    boardChanged: diff.any,
    steps: raw.records.reduce((s, r) => s + r.steps, 0),
    toolCalls: calls.length,
    toolErrors: calls.filter((c) => !okOf(c)).length,
    latencyMs: raw.records.reduce((s, r) => s + r.latencyMs, 0),
    usd: raw.records.reduce((s, r) => s + (r.usage?.usd ?? 0), 0),
    judgeUsd: raw.judge?.usd ?? 0,
    inputTokens: raw.records.reduce((s, r) => s + (r.usage?.inputTokens ?? 0), 0),
    outputTokens: raw.records.reduce((s, r) => s + (r.usage?.outputTokens ?? 0), 0),
    unpriced: raw.records.reduce((s, r) => s + (r.usage?.unpriced ?? 0), 0),
    reply,
    calls: calls.map((c) => ({ tool: c.tool, input: c.input, ok: okOf(c) })),
    ...(errors.length ? { error: errors.join("; ") } : {}),
    raw,
  };
  if (!reply && base.error && !diff.any) return { ...base, outcome: "error", detail: base.error };
  const asserts = numbersIn(reply).length > 0 || diff.added.length > 0;

  if (q.expect === "decline") {
    const d = raw.judge ?? { label: heuristicDecline(reply, diff.any), by: "heuristic" as const, usd: 0 };
    const ok = d.label !== "answered";
    return { ...base, decline: { label: d.label, by: d.by }, outcome: ok ? "declined_ok" : asserts ? "confidently_wrong" : "wrong", detail: `${d.by}: ${d.label}` };
  }

  const chartScore = (id: string) => {
    const rows = raw.widgetRows[id];
    return truth && rows ? scoreAnswer(truth, dataAsText(rows, truth.unit)) : null;
  };
  // The answer from the reply, or else from what a new or changed widget draws.
  const answerFrom = (): (AnswerScore & { by: "reply" | "chart" }) | undefined => {
    if (!truth) return undefined;
    const fromReply = { ...scoreAnswer(truth, reply), by: "reply" as const };
    if (fromReply.correct) return fromReply;
    for (const id of [...diff.added, ...diff.changed]) {
      const s = chartScore(id);
      if (s && (s.correct || s.recall > fromReply.recall)) return { ...s, by: "chart" as const };
    }
    return fromReply;
  };

  if (q.expect === "edit") {
    const em = editMisses(q, before, after);
    const dataOk = truth && em.widgetIds[0] ? (chartScore(em.widgetIds[0])?.correct ?? false) : undefined;
    const query = bestQuery(queries, q.accept);
    if (em.misses.length === 0 && dataOk !== false) return { ...base, edit: { misses: [], dataOk }, query, outcome: "correct", detail: dataOk ? "board right; widget data matches truth" : "board right" };
    // An edit Lenspack cannot make is a decline question in the suite, so an unchanged board here is a miss.
    if (!diff.any) return { ...base, edit: { misses: em.misses }, outcome: "wrong", detail: `board unchanged${soundsLikeDecline(reply) ? " (declined)" : ""}: ${em.misses.join("; ")}` };
    const close = em.widgetIds.length > 0 && em.misses.length <= 1;
    return { ...base, edit: { misses: em.misses, dataOk }, query, outcome: close ? "partial" : "wrong", detail: [...em.misses, ...(dataOk === false ? ["widget data does not match truth"] : [])].join("; ") };
  }

  // expect: answer
  const answer = answerFrom();
  const query = bestQuery(queries, q.accept);
  const ambiguous = q.tags.includes("ambiguous");
  const disclosed = ambiguous ? discloses(reply, q.disclose) : undefined;
  if (answer?.correct) {
    const note = `${answer.by}${answer.matched && answer.matched !== "primary" ? ` (${answer.matched})` : ""}${answer.coarse ? ", rounded" : ""}`;
    if (ambiguous && !disclosed) return { ...base, answer, query, disclosed, outcome: "partial", detail: `right number, definition not said: ${note}` };
    return { ...base, answer, query, ...(ambiguous ? { disclosed } : {}), outcome: "correct", detail: note };
  }
  const d = heuristicDecline(reply, diff.any);
  if (answer && (answer.recall > 0 || query.ok)) return { ...base, answer, query, outcome: "partial", detail: `recall ${answer.recall.toFixed(2)}${answer.precision !== undefined && answer.precision < 1 ? `, precision ${answer.precision.toFixed(2)}` : ""}${answer.missing.length ? `; missing ${answer.missing.slice(0, 4).join(", ")}` : ""}; query ${query.ok ? "ok" : query.misses.join(", ")}` };
  if (d === "declined" || d === "clarify") return { ...base, answer, query, decline: { label: d, by: "heuristic" }, outcome: "wrong", detail: `declined an answerable question (${d})` };
  return { ...base, answer, query, outcome: asserts ? "confidently_wrong" : "wrong", detail: `missing ${answer?.missing.slice(0, 4).join(", ") ?? "?"}; query ${query.ok ? "ok" : query.misses.join(", ")}` };
}

// ── report ───────────────────────────────────────────────────────────────

export function report(meta: Record<string, unknown>, rs: Result[]): string {
  const models = [...new Set(rs.map((r) => r.model))];
  const tiers = [...new Set(rs.map((r) => r.tier))];
  const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "—");
  const usd = (n: number) => `$${n.toFixed(4)}`;
  const q = (xs: number[], p: number) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : 0;
  };
  const lines = [
    `# ${meta.suite}: ${new Date().toISOString().slice(0, 16)}Z`,
    ``,
    `pack ${meta.pack} · truth ${meta.truthComputed} · clock ${meta.now ?? "real"} · effort ${meta.effort ?? "default"} · decline labels ${meta.judge ? `judge ${meta.judge}` : "heuristic"} · repeats ${meta.repeats}${meta.stopped ? ` · **${meta.stopped}**` : ""}`,
    ``,
    `| model | n | right | partial | declined ok | confidently wrong | wrong | error | pass | turn cost | total | per right | latency p50 / p95 | steps | tool errors |`,
    `|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`,
  ];
  for (const m of models) {
    const x = rs.filter((r) => r.model === m);
    const c = (o: Outcome) => x.filter((r) => r.outcome === o).length;
    const total = x.reduce((s, r) => s + r.usd + r.judgeUsd, 0);
    const turns = x.reduce((s, r) => s + r.usd, 0);
    const right = c("correct") + c("declined_ok");
    lines.push(
      `| ${m} | ${x.length} | ${c("correct")} | ${c("partial")} | ${c("declined_ok")} | ${c("confidently_wrong")} | ${c("wrong")} | ${c("error")} | ${pct(right, x.length)} | ${usd(turns / Math.max(1, x.length))} | ${usd(total)} | ${right ? usd(total / right) : "—"} | ${q(x.map((r) => r.latencyMs), 0.5)} / ${q(x.map((r) => r.latencyMs), 0.95)} ms | ${(x.reduce((s, r) => s + r.steps, 0) / Math.max(1, x.length)).toFixed(1)} | ${x.reduce((s, r) => s + r.toolErrors, 0)} |`,
    );
  }
  lines.push(``, `Pass = right + declined ok. Turn cost excludes the judge. Unpriced calls: ${rs.reduce((s, r) => s + r.unpriced, 0)}.`, ``);
  lines.push(`## By tier`, ``, `| tier | ${models.join(" | ")} |`, `|---|${models.map(() => "---").join("|")}|`);
  for (const t of tiers) lines.push(`| ${t} | ${models.map((m) => { const x = rs.filter((r) => r.model === m && r.tier === t); return `${x.filter((r) => r.outcome === "correct" || r.outcome === "declined_ok").length}/${x.length}`; }).join(" | ")} |`);
  const declines = rs.filter((r) => r.expect === "decline");
  if (declines.length) {
    lines.push(``, `## Expected fails by reason`, ``, `| why | ${models.join(" | ")} |`, `|---|${models.map(() => "---").join("|")}|`);
    for (const w of [...new Set(declines.map((r) => r.why ?? "?"))]) lines.push(`| ${w} | ${models.map((m) => { const x = declines.filter((r) => r.model === m && (r.why ?? "?") === w); return `${x.filter((r) => r.outcome === "declined_ok").length}/${x.length}`; }).join(" | ")} |`);
  }
  const bad = rs.filter((r) => r.outcome === "confidently_wrong");
  if (bad.length) {
    lines.push(``, `## Confidently wrong`, ``);
    for (const r of bad) lines.push(`- **${r.model} ${r.id}** (${r.detail}): ${r.reply.replace(/\s+/g, " ").slice(0, 300)}`);
  }
  lines.push(``, `## Every question`, ``, `| q | ${models.join(" | ")} |`, `|---|${models.map(() => "---").join("|")}|`);
  const icon: Record<Outcome, string> = { correct: "✅", declined_ok: "✅↩", partial: "🟡", confidently_wrong: "❌!", wrong: "❌", error: "⚠️" };
  for (const id of [...new Set(rs.map((r) => r.id))]) lines.push(`| ${id} | ${models.map((m) => rs.filter((r) => r.model === m && r.id === id).map((r) => `${icon[r.outcome]} ${r.detail.replace(/\|/g, "/").slice(0, 80)}`).join("<br>")).join(" | ")} |`);
  return lines.join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
