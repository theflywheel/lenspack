import { mkdtempSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { openDuckdb } from "@lenspack/sql/duckdb";
import { openSqlite } from "@lenspack/sql/sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { seed } from "../../../examples/campaign/seed";
import { configSchema, createApp, openConfig, readConfig, resolveSecrets, seedBoards } from "../src";

const campaign = fileURLToPath(new URL("../../../examples/campaign/", import.meta.url));

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
    const { seedSearch } = await import("../../../examples/campaign/seed");
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
