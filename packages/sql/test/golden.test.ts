import { ResolveError } from "@lenspack/engine";
import { describe, expect, it } from "vitest";

import { compile } from "../src/compile";
import type { Dialect } from "../src/print/base";
import { GOLDEN_QUERIES, ctx, pack } from "./golden-pack";

// The printer's output, byte for byte, for every node the planner can emit,
// in every dialect. The Postgres and DuckDB files were written before
// dialects became drivers and have not changed since; a change in any file
// is a change in the SQL lenspack sends, so it must be meant. A query a
// dialect refuses is recorded as the refusal.

const stringify = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x));

export function goldenText(dialect: Dialect) {
  return GOLDEN_QUERIES.map((query) => {
    try {
      const c = compile(query, pack, { dialect, ctx });
      return `-- ${JSON.stringify(query)}\n-- params: ${stringify(c.params)}\n${c.sql};\n`;
    } catch (e) {
      if (!(e instanceof ResolveError)) throw e;
      return `-- ${JSON.stringify(query)}\n-- refused (${e.code}): ${e.message}\n`;
    }
  }).join("\n");
}

describe("golden SQL", () => {
  for (const dialect of ["postgres", "duckdb", "mysql", "sqlite", "clickhouse"] as const) {
    it(`${dialect} prints exactly what it printed before`, async () => {
      await expect(goldenText(dialect)).toMatchFileSnapshot(`./golden/${dialect}.sql`);
    });
  }
});
