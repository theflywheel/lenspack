import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { BoardStore } from "@lenspack/core";
import { openDuckdb } from "@lenspack/sql/duckdb";
import { openSqlite } from "@lenspack/sql/sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { seed } from "../../../../examples/campaign/seed";
import { configSchema, createApp, openConfig, readConfig, resolveSecrets, seedBoards } from "../src";

const campaign = fileURLToPath(new URL("../../../../examples/campaign/", import.meta.url));

describe("config secrets", () => {
  it("reads env: references and refuses a missing one", () => {
    expect(resolveSecrets({ url: "env:X_URL", n: 1 }, { X_URL: "http://h" })).toEqual({ url: "http://h", n: 1 });
    expect(() => resolveSecrets({ key: "env:NOPE" }, {})).toThrow(/env:NOPE, which is not set/);
  });
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; base: string }> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { server, base: `http://127.0.0.1:${port}/api` };
}

describe("lenspack serve from a config file", () => {
  const dir = mkdtempSync(join(tmpdir(), "lenspack-serve-"));
  const servers: Server[] = [];
  const closers: (() => Promise<void>)[] = [];

  const start = async (source: string) => {
    const file = join(dir, `lenspack.${source.split(":")[0]}.yaml`);
    writeFileSync(
      file,
      `sources:\n  data: ${source}\npacks:\n  - pack: ${campaign}pack.yaml\n    source: data\n    boards: ${campaign}boards\n    now: "2026-09-01T00:00:00Z"\nstore: { kind: memory }\n`,
    );
    const { config, dir: base } = readConfig(file);
    const opened = await openConfig(config, base, { ...process.env, CAMPAIGN_ES: process.env.LENSPACK_ES_URL ?? "" });
    for (const h of opened.hosts) await seedBoards(h);
    const { server, base: url } = await listen(createApp(opened.hosts));
    servers.push(server);
    closers.push(opened.close);
    return url;
  };

  let sqlApi: string;
  beforeAll(async () => {
    const db = await openDuckdb(join(dir, "campaign.duckdb"));
    await seed(db.writer, "duckdb", { households: 3000 });
    await db.close();
    sqlApi = await start(`{ kind: duckdb, path: ${join(dir, "campaign.duckdb")} }`);
    const lite = await openSqlite(join(dir, "campaign.db"));
    await seed(lite.writer, "sqlite", { households: 3000 });
    await lite.close();
  });
  afterAll(async () => {
    for (const s of servers) s.close();
    for (const c of closers) await c();
  });

  const get = async (url: string) => (await fetch(url)).json() as Promise<any>;

  it("lists packs with the kind of source each reads", async () => {
    const api = await get(sqlApi);
    expect(api.examples).toEqual([expect.objectContaining({ example: "campaign", source: "duckdb", boards: [expect.objectContaining({ id: "overview" })] })]);
  });

  it("draws a board, cross-index ratio included", async () => {
    const data = await get(`${sqlApi}/campaign/overview/data`);
    expect(Object.keys(data).length).toBe(9);
    for (const [id, d] of Object.entries<any>(data)) expect(d.error, id).toBeUndefined();
    expect(data.coverage.rows[0].value).toBeGreaterThan(0);
  });

  it("pages a table of rows through the source, one page per request, under the board's order", async () => {
    const post = async (url: string, body: unknown) => (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<any>;
    const { id } = await post(`${sqlApi}/campaign/boards`, { title: "paged", temporary: true });
    const columns = ["district", "village", "delivered_by"];
    const rows = { kind: "rows", entity: "task", columns, limit: 6, orderBy: { key: "village", dir: "asc" } };
    const added = await post(`${sqlApi}/campaign/${id}/ops`, {
      ops: [
        { op: "add_widget", id: "turns", widget: { kind: "table", title: "Visits", query: rows, pageSize: 5 } },
        { op: "add_widget", id: "count", widget: { kind: "kpi", title: "n", query: { kind: "value", measure: "visits" } } },
      ],
    });
    expect(added.ok ?? added.applied ?? true).not.toBe(false);
    const board = await get(`${sqlApi}/campaign/${id}/data`);
    const p0 = await get(`${sqlApi}/campaign/${id}/page?widget=turns&page=0`);
    const p1 = await get(`${sqlApi}/campaign/${id}/page?widget=turns&page=1`);
    expect([p0.page, p0.pageSize, p0.offset, p0.hasNext, p0.records.length]).toEqual([0, 5, 0, true, 5]);
    expect([p1.page, p1.offset, p1.records.length]).toEqual([1, 5, 5]);
    // Page 0 is the rows the board shows; page 1 carries on where it stops.
    expect(p0.records).toEqual(board.turns.records.slice(0, 5));
    expect(p1.records[0]).toEqual(board.turns.records[5]);
    expect(p0.columns).toEqual(columns);
    const deep = await fetch(`${sqlApi}/campaign/${id}/page?widget=turns&page=2001`);
    expect(deep.status).toBe(400);
    expect((await deep.json()).error).toMatch(/as deep as row 10000/);
    expect((await fetch(`${sqlApi}/campaign/${id}/page?widget=count&page=1`)).status).toBe(400);
  });

  it("explains a query in the source's own language, and refuses with a reason", async () => {
    const ok = await get(`${sqlApi}/campaign/explain?q=${encodeURIComponent(JSON.stringify({ kind: "breakdown", dimension: "district", measure: "visits" }))}`);
    expect(ok.native).toMatch(/SELECT/);
    const no = await get(`${sqlApi}/campaign/explain?q=${encodeURIComponent(JSON.stringify({ kind: "breakdown", dimension: "distrct", measure: "visits" }))}`);
    expect(no).toMatchObject({ ok: false, code: "UNKNOWN_DIMENSION", nearest: "district" });
  });

  it("takes a source as a connection URL, the driver read from its scheme, relative to the config", async () => {
    const liteApi = await start(`{ url: "sqlite:./campaign.db" }`);
    expect((await get(liteApi)).examples[0].source).toBe("sqlite");
    const [a, b] = await Promise.all([get(`${sqlApi}/campaign/overview/data`), get(`${liteApi}/campaign/overview/data`)]);
    for (const id of Object.keys(a)) expect(b[id].rows, id).toEqual(a[id].rows);
  });

  it("refuses a kind that disagrees with the URL, and a scheme with no driver", async () => {
    const parse = (source: unknown) => configSchema.parse({ sources: { data: source }, packs: [{ pack: "p.yaml", source: "data" }] });
    expect(parse({ url: "env:DATABASE_URL" }).sources.data).toEqual({ url: "env:DATABASE_URL" });
    expect(parse({ kind: "postgres", url: "env:PG" }).sources.data).toMatchObject({ kind: "postgres" });
    const open = (source: unknown) => openConfig(parse(source), dir);
    await expect(open({ kind: "mysql", url: "sqlite:./campaign.db" })).rejects.toThrow(/says kind: mysql, but its URL is a sqlite URL/);
    await expect(open({ url: "oracle://h/db" })).rejects.toThrow(/No driver for "oracle:"/);
  });

  it("skips an optional file source that is not there, with its packs; one that must be there stops the server", async () => {
    const config = (optional?: boolean) => configSchema.parse({ sources: { gone: { url: "duckdb:./nowhere.duckdb", optional } }, packs: [{ pack: `${campaign}pack.yaml`, source: "gone" }] });
    const opened = await openConfig(config(true), dir);
    expect(opened.hosts).toEqual([]);
    await opened.close();
    await expect(openConfig(config(), dir)).rejects.toThrow();
  });

  it("lists what each source holds", async () => {
    const opened = await openConfig(configSchema.parse({ sources: { lite: { url: "sqlite:./campaign.db" } }, packs: [{ pack: `${campaign}pack.yaml`, source: "lite" }] }), dir);
    const schema = await opened.sources.get("lite")!.introspect!();
    await opened.close();
    const tasks = schema.collections.find((c) => c.name === "project-task-index-v1");
    expect(tasks?.rows).toBe(3000);
    expect(tasks?.fields.map((f) => f.path)).toContain("Data.district");
  });

  it.skipIf(!process.env.LENSPACK_ES_URL)("serves the same board from Elasticsearch, configured by env reference", async () => {
    const esApi = await start("{ kind: elasticsearch, url: env:CAMPAIGN_ES }");
    // Same generator and size as the connector parity test, so either may seed it.
    const { elasticsearchConnector } = await import("@lenspack/elasticsearch");
    const { seedSearch } = await import("../../../../examples/campaign/seed");
    await seedSearch(elasticsearchConnector({ url: process.env.LENSPACK_ES_URL! }).request, { households: 3000 });
    expect((await get(esApi)).examples[0].source).toBe("elasticsearch");
    const [a, b] = await Promise.all([get(`${sqlApi}/campaign/overview/data`), get(`${esApi}/campaign/overview/data`)]);
    for (const id of Object.keys(a)) {
      expect(b[id].error, id).toBeUndefined();
      const approx = id === "distributors";
      if (!approx) expect(b[id].rows, id).toEqual(a[id].rows);
    }
    const e = await get(`${esApi}/campaign/explain?q=${encodeURIComponent(JSON.stringify({ kind: "value", measure: "household_coverage" }))}`);
    expect(e.native).toMatch(/POST \/project-index-v1\/_search/);
  });
});

describe("the UI as an app", () => {
  it("writes the deployment's ui settings into the page, escaped, and nowhere else", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lenspack-ui-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><html><head><title>lenspack</title></head><body></body></html>");
    writeFileSync(join(dir, "app.js"), "console.log(1)");
    const page = { title: "Boards </script><b>", home: "campaign/overview", intro: "Read me </script>" };
    expect(configSchema.parse({ sources: {}, packs: [{ pack: "p", source: "s" }], ui: { title: "T" } }).ui).toEqual({ title: "T" });
    expect(configSchema.parse({ sources: {}, packs: [{ pack: "p", source: "s" }], ui: "./dist" }).ui).toBe("./dist");
    expect(configSchema.parse({ sources: {}, packs: [{ pack: "p", source: "s" }], ui: { mode: "app", intro: "Our boards." } }).ui).toEqual({ mode: "app", intro: "Our boards." });
    const { server, base } = await listen(createApp([], { ui: dir, page }));
    const html = await (await fetch(base.replace("/api", "/"))).text();
    const js = await (await fetch(base.replace("/api", "/app.js"))).text();
    server.close();
    const injected = /window\.__lenspackUi=(.*?)<\/script>/.exec(html)?.[1];
    expect(JSON.parse(injected!)).toEqual(page);
    expect(html).toContain("<title>Boards &#60;/script&#62;&#60;b&#62;</title>");
    expect(js).toBe("console.log(1)");
  });

  it("serves files from a ui directory given with .. in it, and nothing outside it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lenspack-ui-"));
    mkdirSync(join(dir, "dist"));
    mkdirSync(join(dir, "other"));
    writeFileSync(join(dir, "dist", "index.html"), "<!doctype html><html><head></head><body>index</body></html>");
    writeFileSync(join(dir, "dist", "app.js"), "console.log(2)");
    writeFileSync(join(dir, "secret.txt"), "outside");
    const { server, base } = await listen(createApp([], { ui: join(dir, "other", "..", "dist") }));
    const at = (path: string) => fetch(base.replace("/api", path)).then((r) => r.text());
    const [js, escaped, encoded] = [await at("/app.js"), await at("/../secret.txt"), await at("/%2e%2e/secret.txt")];
    server.close();
    expect(js).toBe("console.log(2)");
    expect(escaped).toContain("index");
    expect(encoded).toContain("index");
  });
});

describe("boards kept in a database", () => {
  const dir = mkdtempSync(join(tmpdir(), "lenspack-store-"));
  const boards = join(dir, "boards");
  const file = (title: string, packVersion = 1) => {
    mkdirSync(boards, { recursive: true });
    writeFileSync(join(dir, "pack.yaml"), readFileSync(`${campaign}pack.yaml`, "utf8").replace(/^version: 1$/m, `version: ${packVersion}`));
    const overview = JSON.parse(readFileSync(`${campaign}boards/overview.json`, "utf8"));
    writeFileSync(join(boards, "overview.json"), JSON.stringify({ ...overview, title }));
  };
  // One pack mounted twice, both kept in one database file.
  const open = async () => {
    const pack = (name: string) => ({ pack: "./pack.yaml", source: "data", name, boards: "./boards" });
    const opened = await openConfig(configSchema.parse({ sources: { data: { url: "duckdb:./data.duckdb" } }, packs: [pack("north"), pack("south")], store: { kind: "duckdb", path: "./boards.duckdb" } }), dir);
    for (const h of opened.hosts) await seedBoards(h);
    const [north, south] = opened.hosts.map((h) => h.store);
    return { north: north!, south: south!, hosts: opened.hosts, close: opened.close };
  };
  const title = async (store: BoardStore, id: string) => (await store.get(id))?.config.title;
  // Sources open read-only, so the (empty) data file must exist.
  beforeAll(async () => void (await (await openDuckdb(join(dir, "data.duckdb"))).close()));

  it("keeps each pack's boards apart, and what people made across a restart", async () => {
    file("From the file");
    const first = await open();
    const { catalogueFrom, parsePackText } = await import("@lenspack/pack");
    const catalogue = catalogueFrom(parsePackText(readFileSync(`${campaign}pack.yaml`, "utf8")));
    await first.north.patch({ id: "overview", ops: [{ op: "set_title", title: "Edited in the app" }], catalogue });
    await first.north.create({ id: "mine", pack: { pack: "campaign", version: 1 }, title: "Mine", owner: "amina" });
    expect(await title(first.south, "overview")).toBe("From the file");
    expect((await first.south.list()).map((b) => b.id)).toEqual(["overview"]);
    await first.close();

    const again = await open();
    expect(await again.north.get("mine")).toMatchObject({ owner: "amina", shared: false });
    // The pack's own boards list first, even after someone's board changed more recently.
    await again.north.share("mine", { everyone: true, people: [] });
    const { server, base } = await listen(createApp(again.hosts));
    const listed = (await (await fetch(`${base}/north`)).json()).boards.map((b: { id: string }) => b.id);
    server.close();
    expect(listed).toEqual(["overview", "mine"]);
    expect(await title(again.north, "overview")).toBe("Edited in the app");
    await again.close();
  });

  it("puts a changed board file on top, the app's edit kept in the history", async () => {
    file("The file changed");
    const changed = await open();
    expect(await title(changed.north, "overview")).toBe("The file changed");
    const [latest, edited] = await changed.north.versions("overview");
    expect(latest).toMatchObject({ source: "file" });
    expect(edited?.config.title).toBe("Edited in the app");
    await changed.close();
  });

  it("leaves a board alone when only the pack's version moved", async () => {
    file("The file changed", 2);
    const bumped = await open();
    expect((await bumped.north.versions("overview"))[0]).toMatchObject({ source: "file", config: { title: "The file changed" } });
    expect((await bumped.north.versions("overview")).filter((v) => v.source === "file")).toHaveLength(1);
    await bumped.close();
  });
});
