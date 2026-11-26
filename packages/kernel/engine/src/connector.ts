import type { Pack } from "@lenspack/pack";

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

/**
 * What a source ran for one execute, as the source itself reports it: the statement with its
 * values, or a search request. A connector that knows more than its plan's text (Superset's
 * compiled SQL, a SQL source's bound values) hands it to `ran`; the rest are read from the plan.
 */
export type SourceStatement = {
  /** "sql" for SQL; "json" for a search request or any other request body. */
  language: "sql" | "json";
  text: string;
  /** The bound values, in placeholder order. */
  params?: unknown[];
  /** The source answered from its own cache, with data as of this time (ISO). */
  cachedAt?: string;
  /** Said when the text is not the statement itself (a request a source did not compile back). */
  note?: string;
};

export type ExecuteOptions = {
  timeoutMs?: number;
  /** Told what ran, once per statement, by connectors that know it. Never changes the answer. */
  ran?: (statement: SourceStatement) => void;
};

export type SourceField = { path: string; type: string; aggregatable?: boolean };
export type SourceSchema = { collections: { name: string; fields: SourceField[]; rows?: number }[] };

export interface Connector {
  /** "postgres", "duckdb", "elasticsearch", … — also the fragment key it reads. */
  readonly kind: string;
  readonly capabilities: Capabilities;
  compile(bound: BoundPlan, pack: Pack): Plan | Promise<Plan>;
  execute(plan: Plan, opts?: ExecuteOptions): Promise<WidgetData>;
  /** Tables or indexes, fields and types: the input to drafting a pack. */
  introspect?(): Promise<SourceSchema>;
  close?(): Promise<void>;
}
