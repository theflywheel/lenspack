import type { BoardOp, Query } from "@lenspack/core";
import type { Pack } from "@lenspack/spec";

import { plan, type Shape } from "./plan";
import { type Dialect } from "./print/base";
import { printDuckdb } from "./print/duckdb";
import { printPostgres } from "./print/postgres";
import { type BoundPlan, type Ctx, ResolveError, resolve } from "./resolve";

export type Compiled = { sql: string; params: unknown[]; shape: Shape; bound: BoundPlan; dialect: Dialect };

/** resolve → plan → print. Throws ResolveError for anything the pack cannot answer. */
export function compile(query: Query, pack: Pack, opts: { dialect: Dialect; ctx?: Ctx }): Compiled {
  const bound = resolve(query, pack, opts.ctx);
  const { ast, shape } = plan(bound, pack);
  const printed = opts.dialect === "postgres" ? printPostgres(ast) : printDuckdb(ast);
  return { ...printed, shape, bound, dialect: opts.dialect };
}

/**
 * Compiles every query an add/update op would put on the board, so a widget
 * the pack cannot answer is refused at edit time rather than rendering an
 * error later. Vocabulary is checked by core's applyOps; this catches what
 * only resolution knows: join paths, fan-out, tenancy, time.
 */
export function checkOps(ops: BoardOp[], pack: Pack, opts: { dialect: Dialect; ctx?: Ctx }): { ok: true } | { ok: false; opIndex: number; error: string; hint?: string } {
  for (const [opIndex, op] of ops.entries()) {
    if (op.op !== "add_widget" && op.op !== "update_widget") continue;
    if (op.widget.kind === "text") continue;
    try {
      compile(op.widget.query, pack, opts);
    } catch (e) {
      if (e instanceof ResolveError) return { ok: false, opIndex, error: e.message, hint: e.nearest };
      throw e;
    }
  }
  return { ok: true };
}
