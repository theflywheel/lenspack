// A minimal host: the board API that @lenspack/react's BoardHost callbacks
// talk to. Serves every example that has a seeded database file.
//   LENSPACK_DATA_DIR=./data PORT=8787 tsx server.ts        (files: <example>.duckdb)
//   LENSPACK_PG_URL=postgres://…                              (one Postgres for all)
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { type ToolSet, type UIMessage, convertToModelMessages, stepCountIs, streamText } from "ai";

import { type BoardOp, opSchema } from "@lenspack/core";
import { boardTools, fileProposals, toVercelAI } from "@lenspack/mcp";
import { catalogueFrom } from "@lenspack/spec";
import { type Executor, type Writer, checkOps, dimensionValues, resolveBoard, sqlStore } from "@lenspack/sql";

import { type ExampleName, buildBoard, contextFor, examples } from "../index";

const dataDir = process.env.LENSPACK_DATA_DIR ?? ".";
const port = Number(process.env.PORT ?? 8787);

// Chat is optional: any OpenAI-compatible endpoint. Without a key the demo
// still runs, and the client hides the chat panel.
const llm =
  process.env.LENSPACK_LLM_API_KEY && process.env.LENSPACK_LLM_BASE_URL
    ? createOpenAICompatible({ name: "lenspack-llm", baseURL: process.env.LENSPACK_LLM_BASE_URL, apiKey: process.env.LENSPACK_LLM_API_KEY }).chatModel(
        process.env.LENSPACK_LLM_MODEL ?? "gpt-4o-mini",
      )
    : null;

const SYSTEM = (pack: string, grain: string) => `You build and edit a dashboard ("board") over the "${pack}" data pack. ${grain}

Rules:
- Call get_board before editing so you use the widget ids that exist. Call list_metrics before naming any dimension or measure; only ever use keys it returns.
- Every edit is a tool call. Never describe an edit you did not make. Do not ask permission for straightforward edits; just make them and say what changed.
- If a tool returns applied:false with didYouMean, retry once with that key. If a query is refused for fan-out, use a measure on the other entity instead (list_metrics hints say which).
- Prefer: KPIs across the top (width third or quarter, place top); charts below, half width; a breakdown for "by X", a series for "over time", a value for a single number.
- Reply in one or two plain sentences. No markdown headings, no bullet lists of what you did.`;

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
      return json(res, 200, { examples: list, chat: !!llm });
    }
    const h = hosts.get(exampleName as ExampleName);
    const ex = examples[exampleName as ExampleName];
    if (!h || !ex) return json(res, 404, { error: "no such example" });
    if (!boardId) return json(res, 200, { example: exampleName, pack: ex.pack.pack, description: ex.pack.description, boards: await h.store.list(), catalogue: h.catalogue });
    if (boardId === "pack") return json(res, 200, { yaml: ex.packYaml });
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
        if (!llm) return json(res, 503, { error: "Chat is not configured on this server (LENSPACK_LLM_BASE_URL / LENSPACK_LLM_API_KEY)" });
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
        const grains = Object.entries(ex.pack.entities).map(([k, e]) => `${k}: ${e.grain ?? ""}`).join("; ");
        const result = streamText({
          model: llm,
          system: SYSTEM(ex.pack.pack, `Entities — ${grains}.`),
          messages: await convertToModelMessages(body.messages),
          tools: tools as unknown as ToolSet,
          stopWhen: stepCountIs(10),
        });
        const response = result.toUIMessageStreamResponse();
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
