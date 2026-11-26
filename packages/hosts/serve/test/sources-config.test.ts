// `lenspack sources` is the step before a pack exists: it reads only the config's sources, so a
// config with no packs, an empty list, or a pack file not written yet still lists what a source holds.
// `lenspack serve` still needs at least one pack.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDuckdb } from "@lenspack/sql/duckdb";
import { beforeAll, describe, expect, it } from "vitest";

import { openSources, readConfig, readSourcesConfig } from "../src";

describe("reading a config for its sources alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "lenspack-sources-"));

  beforeAll(async () => {
    const db = await openDuckdb(join(dir, "desk.duckdb"));
    await db.writer.exec("create table tickets (id integer, team varchar, opened_at timestamp)");
    await db.writer.exec("insert into tickets values (1, 'billing', '2026-08-01 10:00:00')");
    await db.close();
  });

  const write = (name: string, packs: string) => {
    const file = join(dir, name);
    writeFileSync(file, `sources:\n  desk: { url: "duckdb:./desk.duckdb" }\n${packs}`);
    return file;
  };

  it.each([
    ["no packs key", ""],
    ["an empty packs list", "packs: []\n"],
    ["an empty packs key", "packs:\n"],
    ["a pack file not written yet", "packs:\n  - { pack: ./desk/tickets.pack.yaml, source: desk }\n"],
  ])("lists the tables with %s", async (label, packs) => {
    const { config, dir: base } = readSourcesConfig(write(`${label.replace(/\W+/g, "-")}.yaml`, packs));
    const { sources, close } = await openSources(config, base);
    try {
      const schema = await sources.get("desk")!.introspect!();
      const tickets = schema.collections.find((c) => c.name === "tickets");
      expect(tickets?.fields.map((f) => f.path)).toEqual(["id", "team", "opened_at"]);
    } finally {
      await close();
    }
  });

  it("still checks the sources themselves", () => {
    const file = join(dir, "bad.yaml");
    writeFileSync(file, "sources:\n  Desk: { url: duckdb:./desk.duckdb }\n");
    expect(() => readSourcesConfig(file)).toThrow();
  });

  it("serving still needs a pack", () => {
    expect(() => readConfig(write("serve.yaml", "packs: []\n"))).toThrow(/at least 1/);
  });
});
