#!/usr/bin/env tsx
// pnpm eval [--providers <file.json>] [--only <task,ids>] [--models <name,names>]
//
// Scores each configured model on the board-building tasks in tasks.ts, in
// process: real pack, real DuckDB, real tools, the same system prompt the demo
// uses. Writes evals/results/<timestamp>.json and prints a markdown table.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type ToolSet, generateText, stepCountIs } from "ai";

import { type BoardOp, memoryStore, opSchema } from "@lenspack/core";
import { boardTools, toVercelAI } from "@lenspack/mcp";
import { catalogueFrom } from "@lenspack/spec";
import { openDuckdb } from "@lenspack/sql/duckdb";

import { SMALL, contextFor, examples } from "../examples/index";
import { type ProviderConfig, buildProvider, probe, providersFromEnv } from "../examples/demo/llm";
import { SYSTEM } from "../examples/demo/prompt";
import { tasks } from "./tasks";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const only = arg("only")?.split(",");
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
};

async function main() {
  const ex = examples.commerce;
  const db = await openDuckdb();
  await ex.seed(db.writer, "duckdb", SMALL.commerce);
  const catalogue = catalogueFrom(ex.pack);
  const ctx = contextFor.commerce;
  const grains = Object.entries(ex.pack.entities).map(([k, e]) => `${k}: ${e.grain ?? ""}`).join("; ");
  const canonicalOps = ex.boards.find((b) => b.id === "overview")!.ops.map((o) => opSchema.parse(o)) as BoardOp[];

  const results: Result[] = [];
  for (const cfg of providerConfigs) {
    if (modelFilter && !modelFilter.some((m) => cfg.name.includes(m))) continue;
    const provider = await probe(buildProvider(cfg));
    if (!provider.available) {
      console.log(`\n## ${cfg.name} — unavailable: ${provider.error}`);
      for (const t of tasks) results.push({ provider: cfg.name, task: t.id, pass: false, note: "provider unavailable", steps: 0, toolCalls: 0, toolErrors: 0, narrated: false, latencyMs: 0, reply: "", error: provider.error });
      continue;
    }
    console.log(`\n## ${cfg.name} (${cfg.model}) — probe ${provider.latencyMs}ms`);
    for (const t of tasks) {
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
          system: SYSTEM(ex.pack.pack, `Entities — ${grains}.`),
          prompt: t.prompt,
          tools,
          stopWhen: stepCountIs(10),
          abortSignal: AbortSignal.timeout(120_000),
        });
        const calls = out.steps.flatMap((s) => s.toolCalls);
        const outputs = out.steps.flatMap((s) => s.toolResults);
        const toolErrors = outputs.filter((o) => {
          const v = (o as { output?: unknown }).output as { applied?: boolean; ok?: boolean } | undefined;
          return v?.applied === false || v?.ok === false;
        }).length;
        const board = (await store.get("b"))!;
        const note = t.check(board.config, out.text);
        r = { provider: cfg.name, task: t.id, pass: note === null, note, steps: out.steps.length, toolCalls: calls.length, toolErrors, narrated: NARRATION.test(out.text), latencyMs: Date.now() - started, reply: out.text.slice(0, 300) };
      } catch (e) {
        r = { provider: cfg.name, task: t.id, pass: false, note: "threw", steps: 0, toolCalls: 0, toolErrors: 0, narrated: false, latencyMs: Date.now() - started, reply: "", error: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
      }
      results.push(r);
      console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${t.id.padEnd(16)} ${String(r.latencyMs).padStart(6)}ms  steps=${r.steps} calls=${r.toolCalls} errs=${r.toolErrors}${r.narrated ? " NARRATED" : ""}${r.note ? `  — ${r.note}` : ""}${r.error ? `  — ${r.error}` : ""}`);
    }
  }
  await db.close();

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = join(import.meta.dirname, "results");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${stamp}.json`), JSON.stringify(results, null, 2));

  const names = [...new Set(results.map((r) => r.provider))];
  const taskIds = [...new Set(results.map((r) => r.task))];
  const lines = [
    `| model | pass | avg latency | avg steps | tool errors | narrated |`,
    `|---|---|---|---|---|---|`,
    ...names.map((n) => {
      const rs = results.filter((r) => r.provider === n);
      const ran = rs.filter((r) => !r.error || r.note !== "provider unavailable");
      const avg = (f: (r: Result) => number) => (ran.length ? Math.round(ran.reduce((s, r) => s + f(r), 0) / ran.length) : 0);
      return `| ${n} | ${rs.filter((r) => r.pass).length}/${rs.length} | ${avg((r) => r.latencyMs)} ms | ${avg((r) => r.steps)} | ${rs.reduce((s, r) => s + r.toolErrors, 0)} | ${rs.filter((r) => r.narrated).length} |`;
    }),
    ``,
    `| task | ${names.join(" | ")} |`,
    `|---|${names.map(() => "---").join("|")}|`,
    ...taskIds.map((t) => `| ${t} | ${names.map((n) => (results.find((r) => r.provider === n && r.task === t)?.pass ? "✅" : "❌")).join(" | ")} |`),
  ];
  const md = lines.join("\n");
  writeFileSync(join(dir, `${stamp}.md`), md);
  console.log(`\n${md}\n\nwritten to evals/results/${stamp}.{json,md}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
