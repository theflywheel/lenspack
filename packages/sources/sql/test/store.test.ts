import { emptyBoard } from "@lenspack/core";
import { describe, expect, it } from "vitest";

import { sqlStore } from "../src";
import { openDuckdb } from "../src/executors/duckdb";
import { openPostgres } from "../src/executors/pg";

// The board store in a database: who a board is shared with is kept beside it,
// and a table from before sharing by name keeps its shared boards shared with everyone.

const packRef = { pack: "plain", version: 1 };

// Postgres when one is reachable (CI provides one; locally LENSPACK_PG_URL), in a space of its own.
const PG_URL = process.env.LENSPACK_PG_URL ?? "postgres://localhost:5432/lenspack_test";
const engines = [
  { name: "duckdb", open: () => openDuckdb() },
  { name: "postgres", open: () => openPostgres(PG_URL).then(async (pg) => (await pg.pool.query("SELECT 1"), pg)) },
];

describe("sql board store", () => {
  it.for(engines)("keeps who a board is shared with, across a reopen ($name)", async ({ name, open }, { skip }) => {
    const db = await open().catch((e) => {
      if (name === "duckdb") throw e;
      console.warn(`[store] Postgres not reachable at ${PG_URL}; skipping (${String(e).slice(0, 80)})`);
      return null;
    });
    if (!db) return skip();
    const space = `share_${Math.random().toString(36).slice(2, 10)}`;
    const store = sqlStore(db, { space });
    await store.migrate();
    await store.create({ id: "x", pack: packRef, title: "T", owner: "ann", tenant: "t1" });
    expect(await store.get("x")).toMatchObject({ owner: "ann", tenant: "t1", shared: false, everyone: false, people: [] });
    expect(await store.share("x", { everyone: false, people: ["bob", "cy"] })).toMatchObject({ shared: true, everyone: false, people: ["bob", "cy"] });
    await store.replaceConfig({ id: "x", config: { ...(await store.get("x"))!.config, title: "Renamed" } });
    const again = sqlStore(db, { space });
    expect(await again.get("x")).toMatchObject({ version: 2, shared: true, everyone: false, people: ["bob", "cy"] });
    expect((await again.list())[0]).toMatchObject({ shared: true, everyone: false, people: ["bob", "cy"] });
    await again.share("x", { everyone: true, people: [] });
    expect(await store.get("x")).toMatchObject({ shared: true, everyone: true, people: [] });
    // The names that used the space, by tenant, kept across a reopen; another space has its own.
    await store.noteUser("bob", "t1");
    await store.noteUser("bob", "t1");
    await store.noteUser("Cy", "t1");
    await store.noteUser("dee");
    expect(await sqlStore(db, { space }).users("t1")).toEqual(["Cy", "bob"]);
    expect(await sqlStore(db, { space }).users()).toEqual(["dee"]);
    expect(await sqlStore(db, { space: `${space}_other` }).users("t1")).toEqual([]);
    await db.writer.exec(`DELETE FROM lenspack_users WHERE space = $1`, [space]);
    await store.delete("x");
    await db.close();
  });

  it("adds the people column to a table from before, its shared boards shared with everyone", async () => {
    const db = await openDuckdb();
    // lenspack_boards as the release before sharing by name made it.
    await db.writer.exec(`CREATE TABLE lenspack_boards (space VARCHAR NOT NULL, id VARCHAR NOT NULL, pack VARCHAR NOT NULL, title VARCHAR NOT NULL, owner VARCHAR, tenant VARCHAR, shared BOOLEAN NOT NULL, version INTEGER NOT NULL, config TEXT NOT NULL, updated_at TIMESTAMP NOT NULL, PRIMARY KEY (space, id))`);
    const config = JSON.stringify(emptyBoard(packRef, "Old"));
    for (const [id, owner, shared] of [["open", "ann", true], ["closed", "ann", false], ["file", null, false]] as const)
      await db.writer.exec(`INSERT INTO lenspack_boards VALUES ('', $1, 'plain', 'Old', $2, NULL, $3, 1, $4, CAST('2026-01-01 00:00:00' AS TIMESTAMP))`, [id, owner, shared, config]);
    const store = sqlStore(db);
    await store.migrate();
    await store.migrate();
    expect(await store.get("open")).toMatchObject({ owner: "ann", shared: true, everyone: true, people: [] });
    expect(await store.get("closed")).toMatchObject({ owner: "ann", shared: false, everyone: false, people: [] });
    expect(await store.get("file")).not.toHaveProperty("everyone");
    // And it takes names from now on, and notes who used it.
    await store.share("closed", { everyone: false, people: ["bob"] });
    expect(await sqlStore(db).get("closed")).toMatchObject({ shared: true, everyone: false, people: ["bob"] });
    await store.noteUser("bob");
    expect(await store.users()).toEqual(["bob"]);
    // The release before still writes its boards to the table.
    await db.writer.exec(`INSERT INTO lenspack_boards (space, id, pack, title, owner, tenant, shared, version, config, updated_at) VALUES ('', 'older', 'plain', 'Old', 'ann', NULL, false, 1, $1, CAST('2026-01-02 00:00:00' AS TIMESTAMP))`, [config]);
    expect(await store.get("older")).toMatchObject({ owner: "ann", shared: false, people: [] });
    await db.close();
  });
});
