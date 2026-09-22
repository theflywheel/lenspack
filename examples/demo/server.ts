// A minimal host: the board API that @lenspack/react's BoardHost callbacks
// talk to. Nothing here is specific to a pack.
//   LENSPACK_EXAMPLE=commerce LENSPACK_DB=./commerce.duckdb tsx server.ts
import { createServer } from "node:http";

import { type BoardOp, opSchema } from "@lenspack/core";
import { catalogueFrom } from "@lenspack/spec";
import { checkOps, dimensionValues, resolveBoard, sqlStore } from "@lenspack/sql";

import { type ExampleName, buildBoard, contextFor, examples } from "../index";

const name = (process.env.LENSPACK_EXAMPLE ?? "commerce") as ExampleName;
const target = process.env.LENSPACK_DB ?? `./${name}.duckdb`;
const ex = examples[name];
const pack = ex.pack;
const catalogue = catalogueFrom(pack);
const ctx = contextFor[name];

const db = target.startsWith("postgres") ? await (await import("@lenspack/sql/pg")).openPostgres(target) : await (await import("@lenspack/sql/duckdb")).openDuckdb(target);
const store = sqlStore(db);
await store.migrate();
for (const b of ex.boards) if (!(await store.get(b.id))) await store.create({ id: b.id, pack, title: b.title, config: buildBoard(name, b.id) });

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
  const [, api, boardId, action] = url.pathname.split("/");
  try {
    if (api !== "api") return json(res, 404, { error: "not found" });
    if (!boardId) return json(res, 200, { pack: pack.pack, boards: await store.list(), catalogue });
    const board = await store.get(boardId);
    if (!board) return json(res, 404, { error: "no such board" });
    const opts = { pack, executor: db.executor, ctx };
    switch (`${req.method} ${action ?? ""}`) {
      case "GET ":
        return json(res, 200, { board, catalogue });
      case "GET data": {
        const selections = Object.fromEntries([...url.searchParams].filter(([k]) => k.startsWith("f_")).map(([k, v]) => [k.slice(2), v]));
        return json(res, 200, await resolveBoard(board.config, opts, selections));
      }
      case "GET options":
        return json(res, 200, await dimensionValues(url.searchParams.get("field") ?? "", opts));
      case "GET versions":
        return json(res, 200, await store.versions(boardId));
      case "POST ops": {
        const body = (await read(req)) as { ops: unknown[] };
        const ops = body.ops.map((o) => opSchema.parse(o)) as BoardOp[];
        const checked = checkOps(ops, pack, { dialect: db.dialect, ctx });
        if (!checked.ok) return json(res, 200, checked);
        return json(res, 200, await store.patch({ id: boardId, ops, catalogue, source: "ops" }));
      }
      case "POST layout": {
        const body = (await read(req)) as { layout: BoardOp[] };
        const next = { ...board.config, layout: body.layout as never };
        return json(res, 200, await store.replaceConfig({ id: boardId, config: next }));
      }
      case "POST revert": {
        const body = (await read(req)) as { version: number };
        return json(res, 200, await store.revertTo(boardId, body.version));
      }
    }
    return json(res, 404, { error: "not found" });
  } catch (e) {
    return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
}).listen(8787, () => console.log(`lenspack demo api: ${name} from ${target} on http://localhost:8787/api`));
