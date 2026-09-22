// A minimal host: the board API that @lenspack/react's BoardHost callbacks
// talk to. Serves every example that has a seeded database file.
//   LENSPACK_DATA_DIR=./data PORT=8787 tsx server.ts        (files: <example>.duckdb)
//   LENSPACK_PG_URL=postgres://…                              (one Postgres for all)
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { type BoardOp, opSchema } from "@lenspack/core";
import { catalogueFrom } from "@lenspack/spec";
import { type Executor, type Writer, checkOps, dimensionValues, resolveBoard, sqlStore } from "@lenspack/sql";

import { type ExampleName, buildBoard, contextFor, examples } from "../index";

const dataDir = process.env.LENSPACK_DATA_DIR ?? ".";
const port = Number(process.env.PORT ?? 8787);

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
      return json(res, 200, { examples: list });
    }
    const h = hosts.get(exampleName as ExampleName);
    const ex = examples[exampleName as ExampleName];
    if (!h || !ex) return json(res, 404, { error: "no such example" });
    if (!boardId) return json(res, 200, { example: exampleName, pack: ex.pack.pack, description: ex.pack.description, boards: await h.store.list(), catalogue: h.catalogue });
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
    }
    return json(res, 404, { error: "not found" });
  } catch (e) {
    return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
}).listen(port, () => console.log(`lenspack demo api: ${[...hosts.keys()].join(", ") || "(no examples seeded)"} on http://localhost:${port}/api`));
