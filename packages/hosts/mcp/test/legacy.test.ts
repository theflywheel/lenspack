import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BoardStore, BoardVersion } from "@lenspack/core";
import { parsePackText } from "@lenspack/pack";
import { sqlStore } from "@lenspack/sql";
import { openDuckdb } from "@lenspack/sql/duckdb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openMcp } from "../src/open";

// Earlier versions of lenspack-mcp kept boards in the data database. They
// come across into the new board store once, with their history, and the data
// file is only ever read.

const root = mkdtempSync(join(tmpdir(), "lenspack-mcp-legacy-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const PACK = `pack: plain
version: 1
entities:
  items: { source: items, grain: one row per item }
dimensions:
  - { key: colour, entity: items, sql: colour }
measures:
  - { key: items, entity: items, agg: count }
`;
const pack = parsePackText(PACK);
const other = parsePackText(PACK.replace("pack: plain", "pack: other"));

const legacy = join(root, "legacy.duckdb");
const hash = () => createHash("sha256").update(readFileSync(legacy)).digest("hex");
let original: { list: Awaited<ReturnType<BoardStore["list"]>>; versions: Record<string, BoardVersion[]> };

beforeAll(async () => {
  // A data file as an earlier lenspack-mcp left it: the data, and its boards beside it.
  const db = await openDuckdb(legacy);
  await db.writer.exec(`CREATE TABLE items (id INTEGER, colour VARCHAR)`);
  await db.writer.exec(`INSERT INTO items VALUES (1, 'red')`);
  const store = sqlStore(db);
  await store.migrate();
  const board = await store.create({ id: "default", pack, title: "plain board" });
  for (const title of ["Sales", "Sales by colour", "Sales, weekly"])
    await store.replaceConfig({ id: "default", config: { ...board.config, title }, source: "chat", summary: `renamed to ${title}` });
  await store.create({ id: "second", pack, title: "Second" });
  await store.create({ id: "elsewhere", pack: other, title: "Another pack's board" });
  original = { list: await store.list(), versions: { default: await store.versions("default"), second: await store.versions("second") } };
  await db.close();
});

const start = (name: string, store?: string) => {
  const dir = mkdtempSync(join(root, `${name}-`));
  const packFile = join(dir, "pack.yaml");
  writeFileSync(packFile, PACK);
  return { dir, open: () => openMcp({ pack: packFile, db: legacy, store, board: "default", runSql: false }) };
};

const tool = (served: { tools: { name: string; execute(a: never): Promise<unknown> }[] }, name: string) => served.tools.find((t) => t.name === name)!;
const strip = (vs: BoardVersion[], times = true) => vs.map(({ createdAt, ...v }) => (times ? { ...v, createdAt: createdAt.toISOString() } : v));

describe("boards from an earlier lenspack-mcp", () => {
  it("are copied once into the new store, with their whole history, and the data file is not touched", async () => {
    const before = hash();
    const { dir, open } = start("file");
    const served = await open();
    try {
      expect(served.imported).toEqual({ boards: 2, versions: 5, skipped: [] });
      expect(served.store).toBe(join(dir, "plain.boards.duckdb"));
    } finally {
      await served.close();
    }
    // Read the new store on its own: the same boards, versions, sources, summaries, configs and times.
    const db = await openDuckdb(join(dir, "plain.boards.duckdb"));
    try {
      const store = sqlStore(db);
      const list = await store.list();
      expect(list.map((b) => b.id).sort()).toEqual(["default", "second"]);
      expect((await store.get("default"))?.config.title).toBe("Sales, weekly");
      expect((await store.get("default"))?.version).toBe(4);
      expect(strip(await store.versions("default"))).toEqual(strip(original.versions.default!));
      expect(strip(await store.versions("second"))).toEqual(strip(original.versions.second!));
    } finally {
      await db.close();
    }
    expect(hash()).toBe(before);

    // The next start finds its boards in the store and copies nothing.
    const again = await open();
    try {
      expect(again.imported).toBeNull();
      expect(await tool(again, "get_board").execute({} as never)).toMatchObject({ version: 4 });
    } finally {
      await again.close();
    }
    expect(hash()).toBe(before);
  });

  it("are replayed into a memory store, version for version", async () => {
    const before = hash();
    const served = await start("memory", "memory").open();
    try {
      expect(served.imported).toEqual({ boards: 2, versions: 5, skipped: [] });
      // The same versions in the same order, made by the same hands; only the times are new.
      const listed = (await tool(served, "list_versions").execute({ limit: 20 } as never)) as { versions: { version: number; source: string; summary: string }[] };
      expect(listed.versions.map(({ version, source, summary }) => ({ version, source, summary }))).toEqual(
        original.versions.default!.map(({ version, source, summary }) => ({ version, source, summary })).map((v) => (v.version === 1 ? { ...v, source: "create", summary: "created" } : v)),
      );
    } finally {
      await served.close();
    }
    expect(hash()).toBe(before);
  });

  it("are not copied into a store that already has boards for the pack", async () => {
    const { dir, open } = start("existing");
    const db = await openDuckdb(join(dir, "plain.boards.duckdb"));
    const store = sqlStore(db);
    await store.migrate();
    await store.create({ id: "mine", pack, title: "Already here" });
    await db.close();
    const served = await open();
    try {
      expect(served.imported).toBeNull();
    } finally {
      await served.close();
    }
  });

  it("leave nothing to copy when the data has no board tables", async () => {
    const plain = join(root, "plain.duckdb");
    const db = await openDuckdb(plain);
    await db.writer.exec(`CREATE TABLE items (id INTEGER, colour VARCHAR)`);
    await db.close();
    const dir = mkdtempSync(join(root, "none-"));
    writeFileSync(join(dir, "pack.yaml"), PACK);
    const served = await openMcp({ pack: join(dir, "pack.yaml"), db: plain, board: "default", runSql: false });
    try {
      expect(served.imported).toBeNull();
      expect(existsSync(join(dir, "plain.boards.duckdb"))).toBe(true);
    } finally {
      await served.close();
    }
  });
});
