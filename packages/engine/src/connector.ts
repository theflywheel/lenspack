import type { Pack } from "@lenspack/spec";

import type { WidgetData } from "./data";
import type { BoundPlan, Capabilities } from "./resolve";

// A connector is everything lenspack knows about one kind of backend. The
// engine resolves a query against the pack — keys, join paths, tenancy, time
// windows, capability refusals — and hands the connector a bound plan; the
// connector turns it into something native (SQL, a search request) and runs
// it. Nothing above this line knows which backend it is talking to.

export type Plan = {
  /** Human-readable form for explain and review: SQL text, or a search request. */
  text: string;
  /** Whatever the connector's execute needs. Opaque to the engine. */
  native: unknown;
  bound: BoundPlan;
  /** Some of the numbers will be estimates. */
  approximate?: boolean;
};

export type SourceField = { path: string; type: string; aggregatable?: boolean };
export type SourceSchema = { collections: { name: string; fields: SourceField[]; rows?: number }[] };

export interface Connector {
  /** "postgres", "duckdb", "elasticsearch", … — also the fragment key it reads. */
  readonly kind: string;
  readonly capabilities: Capabilities;
  compile(bound: BoundPlan, pack: Pack): Plan | Promise<Plan>;
  execute(plan: Plan, opts?: { timeoutMs?: number }): Promise<WidgetData>;
  /** Tables or indexes, fields and types: the input to drafting a pack. */
  introspect?(): Promise<SourceSchema>;
  close?(): Promise<void>;
}
