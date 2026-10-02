import type { Query } from "@lenspack/core";
import { type BoundPlan, type Ctx, resolve } from "@lenspack/engine";
import type { Pack } from "@lenspack/spec";

import { capabilitiesFor, printFor } from "./dialects";
import { plan, type Shape } from "./plan";
import { type Dialect } from "./print/base";

export type Compiled = { sql: string; params: unknown[]; shape: Shape; bound: BoundPlan; dialect: Dialect };

export function printPlan(bound: BoundPlan, pack: Pack, dialect: Dialect): Compiled {
  const { ast, shape } = plan(bound, pack);
  const printed = printFor(dialect)(ast);
  return { ...printed, shape, bound, dialect };
}

/** resolve → plan → print. Throws ResolveError for anything the pack cannot answer. */
export function compile(query: Query, pack: Pack, opts: { dialect: Dialect; ctx?: Ctx }): Compiled {
  return printPlan(resolve(query, pack, opts.ctx, capabilitiesFor(opts.dialect)), pack, opts.dialect);
}
