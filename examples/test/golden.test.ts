import { type Executor, resolveBoard, sqlConnector } from "@lenspack/sql";
import { describe, expect, it } from "vitest";

import { type ExampleName, buildBoard, contextFor, examples } from "../index";

// Every statement each example board sends, per dialect, byte for byte. A
// recording executor stands in for the database, so this needs none and
// catches any change in the SQL text or its parameters.

const NAMES = Object.keys(examples) as ExampleName[];
const stringify = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x));

async function statements(name: ExampleName, dialect: "postgres" | "duckdb") {
  const seen = new Set<string>();
  const executor: Executor = {
    dialect,
    async query(sql, params) {
      seen.add(`-- params: ${stringify(params)}\n${sql};\n`);
      return [];
    },
  };
  const { pack } = examples[name];
  for (const board of examples[name].boards) await resolveBoard(buildBoard(name, board.id), { pack, connector: sqlConnector(executor), ctx: contextFor[name] });
  return [...seen].sort().join("\n");
}

describe("example boards print the same SQL", () => {
  for (const name of NAMES) {
    for (const dialect of ["postgres", "duckdb"] as const) {
      it(`${name} on ${dialect}`, async () => {
        await expect(await statements(name, dialect)).toMatchFileSnapshot(`./golden/${name}.${dialect}.sql`);
      });
    }
  }
});
