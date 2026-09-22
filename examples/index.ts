import type { BoardConfig, BoardOp } from "@lenspack/core";
import { applyOps, emptyBoard, opSchema } from "@lenspack/core";
import { catalogueFrom } from "@lenspack/spec";

import * as commerce from "./commerce/index";
import * as consultation from "./consultation/index";
import * as events from "./events/index";
import * as tickets from "./tickets/index";

export const examples = { commerce, events, consultation, tickets } as const;
export type ExampleName = keyof typeof examples;

/** Builds a board config from an example's ops file — the same path the model uses. */
export function buildBoard(example: ExampleName, boardId: string): BoardConfig {
  const ex = examples[example];
  const board = ex.boards.find((b) => b.id === boardId);
  if (!board) throw new Error(`No board "${boardId}" in ${example}`);
  const catalogue = catalogueFrom(ex.pack);
  const ops = board.ops.map((op) => opSchema.parse(op)) as BoardOp[];
  const result = applyOps(emptyBoard(ex.pack, board.title), ops, catalogue);
  if (!result.ok) throw new Error(`Board ${example}/${boardId} op ${result.opIndex}: ${result.error}${result.hint ? ` (${result.hint})` : ""}`);
  return result.config;
}

/** Context each example needs to query: only the multi-tenant pack takes a tenant. */
export const contextFor: Record<ExampleName, { tenant?: string; now: Date }> = {
  commerce: { now: new Date("2026-09-01T00:00:00Z") },
  events: { now: new Date("2026-09-01T00:00:00Z") },
  consultation: { tenant: "dopt", now: new Date("2026-09-01T00:00:00Z") },
  tickets: { now: new Date("2026-09-01T00:00:00Z") },
};

export const SMALL = { commerce: { orders: 800 }, events: { rows: 15_000 }, consultation: { submissions: 600 }, tickets: { tickets: 800 } } as const;
