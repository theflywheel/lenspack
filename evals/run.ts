#!/usr/bin/env tsx
// pnpm eval [--providers <file.json>] [--only <task,ids>] [--models <name,names>]
//
// Scores each configured model on the board-building tasks in tasks.ts, in
// process: real pack, real DuckDB, real tools, the same system prompt the demo
// uses. Writes evals/results/<timestamp>.json and prints a markdown table.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type ToolSet, generateText, stepCountIs } from "ai";

import { type BoardOp, memoryStore, opSchema, summarise } from "@lenspack/core";
import { boardTools, toVercelAI } from "@lenspack/mcp";
import { catalogueFrom } from "@lenspack/spec";
import { run } from "@lenspack/sql";
import { openDuckdb } from "@lenspack/sql/duckdb";

import { SMALL, contextFor, examples } from "../examples/index";
import { type ProviderConfig, buildProvider, probe, providersFromEnv, stopOnRepeatedRefusals } from "../examples/demo/llm";
import { PROMPT_VERSION, SYSTEM } from "../examples/demo/prompt";
import { screenshotBoard } from "./screenshot";
import { type Review, healingPrompt, refusalsFrom, reviewTurn } from "../examples/demo/review";
import { type HcmFacts, hcmTasks } from "./tasks-hcm";
import { type Facts, tasks } from "./tasks";
import { type VisualVerdict, judgeScreenshot } from "./visual";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const only = arg("only")?.split(",");
// --visual <provider name>: screenshot each resulting board through the demo
// server at --demo (default http://127.0.0.1:8787) and have that model judge it.
const visualName = arg("visual");
// --review [<provider name>]: an adversarial text review after each task
// (default reviewer = the builder itself); --heal gives the builder one more
// round when the reviewer is not satisfied, and reports pass rates both ways.
const reviewFlag = process.argv.includes("--review");
const reviewName = arg("review");
const heal = process.argv.includes("--heal");
const escalateName = arg("escalate");
// --pack commerce|hcm: which example, its canonical board and task set.
const packName = (arg("pack") ?? "commerce") as "commerce" | "hcm";
const demoUrl = arg("demo") ?? "http://127.0.0.1:8787";
const modelFilter = arg("models")?.split(",");
const providerConfigs: ProviderConfig[] = arg("providers") ? (JSON.parse(readFileSync(arg("providers")!, "utf8")) as ProviderConfig[]) : providersFromEnv();
if (providerConfigs.length === 0) {
  console.error("No providers: set LENSPACK_LLM_PROVIDERS or pass --providers file.json");
  process.exit(2);
}

const NARRATION = /\b(I need to|Let me|I will|I'll|The user wants|First,? I|I should)\b/;

type Result = {
  provider: string;
  task: string;
  pass: boolean;
  note: string | null;
  steps: number;
  toolCalls: number;
  toolErrors: number;
  narrated: boolean;
  latencyMs: number;
  reply: string;
  error?: string;
  visual?: VisualVerdict;
  review?: Review & { agrees: boolean };
  healed?: { pass: boolean; note: string | null; latencyMs: number };
};

async function main() {
  const ex = examples[packName];
  const db = await openDuckdb();
  await ex.seed(db.writer, "duckdb", SMALL[packName] as never);
  const catalogue = catalogueFrom(ex.pack);
  const ctx = contextFor[packName];
  console.log(`pack ${packName}; prompt version ${PROMPT_VERSION}`);
  const canonicalBoard = packName === "hcm" ? "campaign" : "overview";
  const canonicalOps = ex.boards.find((b) => b.id === canonicalBoard)!.ops.map((o) => opSchema.parse(o)) as BoardOp[];
  const q = (query: Parameters<typeof run>[0]) => run(query, { pack: ex.pack, executor: db.executor, ctx });
  let facts: Facts | HcmFacts;
  let taskList: { id: string; kind?: "edit" | "question" | "refusal"; prompt: string; check: (c: never, reply: string, f: never) => string | null }[];
  if (packName === "hcm") {
    const byLoc = await q({ kind: "breakdown", dimension: "locality", measure: "success_rate", limit: 50, sort: "asc" });
    const worst = byLoc.rows.find((r) => r.count >= 100)!;
    const reasons = await q({ kind: "breakdown", dimension: "non_delivery_reason", measure: "undelivered", limit: 10, sort: "desc" });
    const top = reasons.rows.find((r) => r.group !== "(none)")!;
    const hh = await q({ kind: "value", measure: "households" });
    facts = { worstLocality: { locality: worst.group, rate: worst.value ?? 0, tasks: worst.count }, topReason: { reason: top.group, count: top.value ?? 0 }, households: hh.rows[0]!.value ?? 0 };
    console.log(`facts: worst locality ${worst.group} ${((worst.value ?? 0) * 100).toFixed(1)}% (${worst.count} visits); top reason ${top.group} ${top.value}; households ${hh.rows[0]!.value}`);
    taskList = hcmTasks as never;
  } else {
    const refund = await q({ kind: "breakdown", dimension: "country", measure: "refund_rate", limit: 12, sort: "desc" });
    facts = { topRefund: { country: refund.rows[0]!.group, rate: refund.rows[0]!.value ?? 0 } };
    console.log(`facts: top refund rate ${refund.rows[0]!.group} ${((refund.rows[0]!.value ?? 0) * 100).toFixed(1)}%`);
    taskList = tasks as never;
  }

  const results: Result[] = [];
  const judge = visualName ? await probe(buildProvider(providerConfigs.find((c) => c.name.includes(visualName))!)) : null;
  const reviewerCfg = reviewName && !reviewName.startsWith("--") ? providerConfigs.find((c) => c.name.includes(reviewName)) : undefined;
  const fixedReviewer = reviewerCfg ? await probe(buildProvider(reviewerCfg)) : null;
  const escalateCfg = escalateName ? providerConfigs.find((c) => c.name.includes(escalateName)) : undefined;
  const escalateProvider = escalateCfg ? await probe(buildProvider(escalateCfg)) : null;
  if (escalateName && !escalateProvider?.available) throw new Error(`escalate provider ${escalateName} unavailable`);
  if (visualName && !judge?.available) throw new Error(`visual judge ${visualName} unavailable: ${judge?.error}`);
  for (const cfg of providerConfigs) {
    if (modelFilter && !modelFilter.some((m) => cfg.name.includes(m))) continue;
    const provider = await probe(buildProvider(cfg));
    if (!provider.available) {
      console.log(`\n## ${cfg.name} — unavailable: ${provider.error}`);
      for (const t of taskList) results.push({ provider: cfg.name, task: t.id, pass: false, note: "provider unavailable", steps: 0, toolCalls: 0, toolErrors: 0, narrated: false, latencyMs: 0, reply: "", error: provider.error });
      continue;
    }
    console.log(`\n## ${cfg.name} (${cfg.model}) — probe ${provider.latencyMs}ms`);
    for (const t of taskList) {
      if (only && !only.includes(t.id)) continue;
      // A fresh copy of the canonical board for every task.
      const store = memoryStore();
      await store.create({ id: "b", pack: ex.pack, title: "Shop overview" });
      const seeded = await store.patch({ id: "b", ops: canonicalOps, catalogue });
      if (!seeded.ok) throw new Error(seeded.error);
      const tools = toVercelAI(boardTools({ pack: ex.pack, executor: db.executor, store, boardId: "b", ctx })) as unknown as ToolSet;
      const started = Date.now();
      let r: Result;
      try {
        const out = await generateText({
          model: provider.languageModel,
          system: SYSTEM(ex.pack, catalogue, seeded.board.config),
          prompt: t.prompt,
          tools,
          stopWhen: [stepCountIs(12), stopOnRepeatedRefusals(3)],
          abortSignal: AbortSignal.timeout(120_000),
        });
        const calls = out.steps.flatMap((s) => s.toolCalls);
        const outputs = out.steps.flatMap((s) => s.toolResults);
        const toolErrors = outputs.filter((o) => {
          const v = (o as { output?: unknown }).output as { applied?: boolean; ok?: boolean } | undefined;
          return v?.applied === false || v?.ok === false;
        }).length;
        const board = (await store.get("b"))!;
        const note = t.check(board.config as never, out.text, facts as never);
        r = { provider: cfg.name, task: t.id, pass: note === null, note, steps: out.steps.length, toolCalls: calls.length, toolErrors, narrated: NARRATION.test(out.text), latencyMs: Date.now() - started, reply: out.text.slice(0, 300) };
        if ((reviewFlag || heal) && (t.kind ?? "edit") === "edit") {
          const reviewerModel = (fixedReviewer ?? provider).languageModel;
          const versions = (await store.versions("b")).filter((v) => v.version > seeded.board.version);
          const receipt = versions.map((v) => `v${v.version} ${v.summary}`).reverse().join("\n");
          const review = await reviewTurn(reviewerModel, { instruction: t.prompt, before: summarise(seeded.board.config), after: summarise(board.config), receipt, refusals: refusalsFrom(out.steps as never) });
          // Does the reviewer agree with the deterministic check?
          r.review = { ...review, raw: undefined, agrees: review.unavailable ? false : review.satisfied === r.pass };
          if (heal && !review.satisfied && !review.unavailable) {
            const healStart = Date.now();
            const history = out.steps.flatMap((st) => st.response.messages);
            const again = await generateText({
              model: (escalateProvider ?? provider).languageModel,
              system: SYSTEM(ex.pack, catalogue, seeded.board.config),
              messages: [{ role: "user", content: t.prompt }, ...history, { role: "user", content: healingPrompt(review) }],
              tools,
              stopWhen: stepCountIs(12),
              abortSignal: AbortSignal.timeout(120_000),
            });
            const healedBoard = (await store.get("b"))!;
            const healedNote = t.check(healedBoard.config as never, again.text, facts as never);
            r.healed = { pass: healedNote === null, note: healedNote, latencyMs: Date.now() - healStart };
          }
        }
        if (judge && (t.kind ?? "edit") !== "question") {
          try {
            const png = await screenshotBoard(board.config, { baseUrl: demoUrl, example: packName });
            r.visual = await judgeScreenshot(judge.languageModel, png, t.prompt);
          } catch (e) {
            r.visual = { ok: false, score: 0, issues: [`visual check failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`], seen: "", raw: "" };
          }
        }
      } catch (e) {
        r = { provider: cfg.name, task: t.id, pass: false, note: "threw", steps: 0, toolCalls: 0, toolErrors: 0, narrated: false, latencyMs: Date.now() - started, reply: "", error: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
      }
      results.push(r);
      console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${t.id.padEnd(16)} ${String(r.latencyMs).padStart(6)}ms  steps=${r.steps} calls=${r.toolCalls} errs=${r.toolErrors}${r.narrated ? " NARRATED" : ""}${r.review ? `  review=${r.review.satisfied ? "ok" : "no"}${r.review.agrees ? "" : "(disagrees)"}` : ""}${r.healed ? `  healed=${r.healed.pass ? "PASS" : "FAIL"} +${r.healed.latencyMs}ms` : ""}${r.visual ? `  visual=${r.visual.ok ? "ok" : "no"}(${r.visual.score})${r.visual.issues.length ? ` ${r.visual.issues.join("; ").slice(0, 100)}` : ""}` : ""}${r.note ? `  — ${r.note}` : ""}${r.error ? `  — ${r.error}` : ""}`);
    }
  }
  await db.close();

  const stamp = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${packName}`;
  const dir = join(import.meta.dirname, "results");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${stamp}.json`), JSON.stringify(results, null, 2));

  const names = [...new Set(results.map((r) => r.provider))];
  const taskIds = [...new Set(results.map((r) => r.task))];
  const lines = [
    `| model | pass | after heal | reviewer agrees | avg latency | avg steps | tool errors | narrated | visual ok |`,
    `|---|---|---|---|---|---|---|---|---|`,
    ...names.map((n) => {
      const rs = results.filter((r) => r.provider === n);
      const ran = rs.filter((r) => !r.error || r.note !== "provider unavailable");
      const avg = (f: (r: Result) => number) => (ran.length ? Math.round(ran.reduce((s, r) => s + f(r), 0) / ran.length) : 0);
      const vis = rs.filter((r) => r.visual);
      const rev = rs.filter((r) => r.review);
      const finalPass = rs.filter((r) => (r.healed ? r.healed.pass : r.pass)).length;
      return `| ${n} | ${rs.filter((r) => r.pass).length}/${rs.length} | ${rs.some((r) => r.healed) ? `${finalPass}/${rs.length}` : "—"} | ${rev.length ? `${rev.filter((r) => r.review!.agrees).length}/${rev.length}` : "—"} | ${avg((r) => r.latencyMs)} ms | ${avg((r) => r.steps)} | ${rs.reduce((s, r) => s + r.toolErrors, 0)} | ${rs.filter((r) => r.narrated).length} | ${vis.length ? `${vis.filter((r) => r.visual!.ok).length}/${vis.length}` : "—"} |`;
    }),
    ``,
    `| task | ${names.join(" | ")} |`,
    `|---|${names.map(() => "---").join("|")}|`,
    ...taskIds.map((t) => `| ${t} | ${names.map((n) => { const r = results.find((x) => x.provider === n && x.task === t); return r?.pass ? "✅" : r?.healed?.pass ? "🩹" : "❌"; }).join(" | ")} |`),
  ];
  const md = lines.join("\n");
  writeFileSync(join(dir, `${stamp}.md`), md);
  console.log(`\n${md}\n\nwritten to evals/results/${stamp}.{json,md}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
