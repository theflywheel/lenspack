import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { memoryStore } from "@lenspack/core";
import { openDuckdb } from "@lenspack/sql/duckdb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pack, seedFixture } from "../../../sources/sql/test/fixture-pack";
import { boardTools, createMcpServer } from "../src";

let db: Awaited<ReturnType<typeof openDuckdb>>;
const store = memoryStore();

beforeAll(async () => {
  db = await openDuckdb();
  await seedFixture(db.writer, "duckdb");
  await store.create({ id: "b", pack, title: "Test board" });
});
afterAll(async () => db.close());

describe("mcp", () => {
  it("still takes a bare SQL executor, and builds run_sql from it only when asked", async () => {
    const names = (runSql?: "role-scoped") => boardTools({ pack, executor: db.executor, store, boardId: "b", ctx: { tenant: "t1" }, runSql }).map((t) => t.name);
    expect(names()).not.toContain("run_sql");
    expect(names("role-scoped")).toContain("run_sql");
  });

  it("serves the tools over MCP, a refusal as a result rather than an error", async () => {
    const server = createMcpServer(boardTools({ pack, executor: db.executor, store, boardId: "b", ctx: { tenant: "t1" } }));
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("add_widget");
    const r = await client.callTool({ name: "query", arguments: { query_kind: "value", measure: "things", filters: "colour == red" } });
    expect(JSON.parse((r.content as { text: string }[])[0]!.text)).toMatchObject({ ok: false, applied: false });
    await client.close();
  });
});
