// A minimal host: the board API that @lenspack/react's BoardHost callbacks
// talk to. Serves every example that has a seeded database file.
//   LENSPACK_DATA_DIR=./data PORT=8787 tsx server.ts        (files: <example>.duckdb)
//   LENSPACK_PG_URL=postgres://…                              (one Postgres for all)
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { type ToolSet, type UIMessage, convertToModelMessages, createUIMessageStream, createUIMessageStreamResponse, stepCountIs, streamText } from "ai";

import { type BoardOp, boardConfigSchema, opSchema, summarise } from "@lenspack/core";
import { boardTools, fileProposals, toVercelAI } from "@lenspack/mcp";
import { catalogueFrom } from "@lenspack/spec";
import { type Executor, type Writer, checkOps, dimensionValues, resolveBoard, sqlStore } from "@lenspack/sql";

import { type ExampleName, buildBoard, contextFor, examples } from "../index";
import { buildProvider, probe, providersFromEnv, publicView } from "./llm";
import { SYSTEM } from "./prompt";
import { healingPrompt, reviewTurn } from "./review";

const dataDir = process.env.LENSPACK_DATA_DIR ?? ".";
const port = Number(process.env.PORT ?? 8787);

// Chat is optional. Providers come from the environment (see llm.ts); each
// is probed at startup and the first that answers is the default.
const providers = providersFromEnv().map(buildProvider);
void Promise.all(providers.map((p) => probe(p))).then((probed) => {
  probed.forEach((p, i) => (providers[i] = p));
  console.log(`[demo] chat providers: ${probed.map((p) => `${p.name}${p.available ? ` ok ${p.latencyMs}ms` : ` unavailable (${p.error})`}`).join("; ") || "(none)"}`);
});
const defaultProvider = () => providers.find((p) => p.available) ?? providers.find((p) => p.available === null) ?? null;

type Db = { dialect: "postgres" | "duckdb"; executor: Executor; writer: Writer };
const hosts = new Map<ExampleName, { db: Db; store: ReturnType<typeof sqlStore>; catalogue: ReturnType<typeof catalogueFrom> }>();

for (const name of Object.keys(examples) as ExampleName[]) {
  const ex = examples[name];
  let db: Db;
  if (process.env.LENSPACK_PG_URL) db = await (await import("@lenspack/sql/pg")).openPostgres(process.env.LENSPACK_PG_URL);
  else {
    const file = join(dataDir, `${name}.duckdb`);
    if (!existsSync(file)) {
      console.warn(`[demo] no ${file}; run: pnpm seed ${name} ${file}`);
      continue;
    }
    db = await (await import("@lenspack/sql/duckdb")).openDuckdb(file);
  }
  const store = sqlStore(db);
  await store.migrate();
  for (const b of ex.boards) if (!(await store.get(b.id))) await store.create({ id: b.id, pack: ex.pack, title: b.title, config: buildBoard(name, b.id) });
  hosts.set(name, { db, store, catalogue: catalogueFrom(ex.pack) });
}

const json = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const read = (req: import("node:http").IncomingMessage) =>
  new Promise<unknown>((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => resolve(s ? JSON.parse(s) : {}));
  });

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const [, api, exampleName, boardId, action] = url.pathname.split("/");
  try {
    if (api !== "api") return json(res, 404, { error: "not found" });
    if (!exampleName) {
      const list = await Promise.all(
        [...hosts.entries()].map(async ([name, h]) => ({ example: name, description: examples[name].pack.description, boards: await h.store.list() })),
      );
      return json(res, 200, { examples: list, chat: providers.length > 0, models: providers.map(publicView) });
    }
    const h = hosts.get(exampleName as ExampleName);
    const ex = examples[exampleName as ExampleName];
    if (!h || !ex) return json(res, 404, { error: "no such example" });
    if (!boardId) return json(res, 200, { example: exampleName, pack: ex.pack.pack, description: ex.pack.description, boards: await h.store.list(), catalogue: h.catalogue });
    if (boardId === "pack") return json(res, 200, { yaml: ex.packYaml });
    // Temporary boards for previews and evals: created from a config, deleted after.
    if (boardId === "boards" && req.method === "POST") {
      const body = (await read(req)) as { config: unknown; title?: string; temporary?: boolean };
      const config = boardConfigSchema.parse(body.config);
      const id = `${body.temporary ? "tmp" : "b"}_${Math.random().toString(36).slice(2, 10)}`;
      const board = await h.store.create({ id, pack: ex.pack, title: body.title ?? config.title, config });
      return json(res, 200, { id: board.id, version: board.version });
    }
    // The canonical board: built from the pack's own ops file, never the
    // shared, editable copy. The landing page previews this.
    if (action === "canonical" && req.method === "GET") {
      const config = buildBoard(exampleName as ExampleName, boardId);
      const ctx = contextFor[exampleName as ExampleName];
      const data = await resolveBoard(config, { pack: ex.pack, executor: h.db.executor, ctx });
      return json(res, 200, { board: { id: boardId, pack: ex.pack.pack, config, version: 0, updatedAt: new Date() }, catalogue: h.catalogue, data });
    }
    const board = await h.store.get(boardId);
    if (!board) return json(res, 404, { error: "no such board" });
    if (req.method === "DELETE" && !action) {
      if (!boardId.startsWith("tmp_")) return json(res, 403, { error: "only temporary boards can be deleted here" });
      await h.store.delete(boardId);
      return json(res, 200, { deleted: boardId });
    }
    const ctx = contextFor[exampleName as ExampleName];
    const opts = { pack: ex.pack, executor: h.db.executor, ctx };
    switch (`${req.method} ${action ?? ""}`) {
      case "GET ":
        return json(res, 200, { board, catalogue: h.catalogue });
      case "GET data": {
        const selections = Object.fromEntries([...url.searchParams].filter(([k]) => k.startsWith("f_")).map(([k, v]) => [k.slice(2), v]));
        return json(res, 200, await resolveBoard(board.config, opts, selections));
      }
      case "GET options":
        return json(res, 200, await dimensionValues(url.searchParams.get("field") ?? "", opts));
      case "GET versions":
        return json(res, 200, await h.store.versions(boardId));
      case "POST ops": {
        const body = (await read(req)) as { ops: unknown[] };
        const ops = body.ops.map((o) => opSchema.parse(o)) as BoardOp[];
        const checked = checkOps(ops, ex.pack, { dialect: h.db.dialect, ctx });
        if (!checked.ok) return json(res, 200, checked);
        return json(res, 200, await h.store.patch({ id: boardId, ops, catalogue: h.catalogue, source: "ops" }));
      }
      case "POST layout": {
        const body = (await read(req)) as { layout: BoardOp[] };
        return json(res, 200, await h.store.replaceConfig({ id: boardId, config: { ...board.config, layout: body.layout as never } }));
      }
      case "POST revert": {
        const body = (await read(req)) as { version: number };
        return json(res, 200, await h.store.revertTo(boardId, body.version));
      }
      case "POST chat": {
        const wanted = url.searchParams.get("model");
        const provider = (wanted ? providers.find((p) => p.name === wanted) : null) ?? defaultProvider();
        if (!provider) return json(res, 503, { error: "Chat is not configured on this server (LENSPACK_LLM_PROVIDERS)" });
        if (provider.available === false) return json(res, 503, { error: `${provider.name} is unavailable: ${provider.error}` });
        // The reviewer: another (or the same) provider; ?review=off disables it.
        const reviewWanted = url.searchParams.get("review");
        const reviewer = reviewWanted === "off" ? null : ((reviewWanted ? providers.find((p) => p.name === reviewWanted && p.available) : null) ?? provider);
        const maxRounds = Number(url.searchParams.get("rounds") ?? 2);
        const body = (await read(req)) as { messages: UIMessage[] };
        const tools = toVercelAI(
          boardTools({
            pack: ex.pack,
            executor: h.db.executor,
            store: h.store,
            boardId,
            ctx,
            proposals: fileProposals(join(dataDir, `${exampleName}.proposals.json`)),
          }),
        );
        const system = SYSTEM(ex.pack, h.catalogue, board.config);
        const modelMessages = await convertToModelMessages(body.messages);
        const lastUser = [...body.messages].reverse().find((m) => m.role === "user");
        const instruction = (lastUser?.parts ?? []).map((p) => ("text" in p ? (p as { text: string }).text : "")).join(" ").trim();
        const before = summarise(board.config);
        const startVersion = board.version;

        // Build, then review, then heal — all in one response stream. The
        // reviewer's verdict is written as a data part the UI renders.
        const stream = createUIMessageStream({
          execute: async ({ writer }) => {
            let messages = modelMessages;
            for (let round = 1; round <= Math.max(1, maxRounds); round++) {
              const result = streamText({ model: provider.languageModel, system, messages, tools: tools as ToolSet, stopWhen: stepCountIs(12) });
              writer.merge(result.toUIMessageStream({ sendStart: round === 1, sendFinish: false }));
              const steps = await result.steps;
              const reply = await result.text;
              if (!reviewer) break;
              const current = (await h.store.get(boardId))!;
              const versions = (await h.store.versions(boardId)).filter((v) => v.version > startVersion);
              const receipt = versions.map((v) => `v${v.version} ${v.summary}`).reverse().join("\n");
              // Questions get no review: there is nothing on the board to check.
              if (versions.length === 0 && !/\b(add|rename|remove|move|resize|make|put|show|plot|pack|compact|set)\b/i.test(instruction)) break;
              let review;
              try {
                review = await reviewTurn(reviewer.languageModel, { instruction, before, after: summarise(current.config), receipt });
              } catch (e) {
                review = { satisfied: true, missing: [], wrong: [], note: `review skipped: ${(e instanceof Error ? e.message : String(e)).slice(0, 80)}` };
              }
              writer.write({ type: "data-review", data: { round, reviewer: reviewer.name, ...review, raw: undefined } });
              if (review.satisfied || round === maxRounds) break;
              // Another round with the review as the instruction; the model keeps its own history.
              const assistantTurn = steps.flatMap((s) => s.response.messages);
              messages = [...messages, ...assistantTurn, { role: "user", content: healingPrompt(review) }];
              void reply;
            }
            writer.write({ type: "finish" });
          },
          onError: (e) => (e instanceof Error ? e.message : String(e)),
        });
        const response = createUIMessageStreamResponse({ stream });
        const headers: Record<string, string> = {};
        response.headers.forEach((v, k) => (headers[k] = v));
        res.writeHead(response.status, headers);
        if (response.body) for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
        return res.end();
      }
    }
    return json(res, 404, { error: "not found" });
  } catch (e) {
    return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
}).listen(port, () => console.log(`lenspack demo api: ${[...hosts.keys()].join(", ") || "(no examples seeded)"} on http://localhost:${port}/api`));
