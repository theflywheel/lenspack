import type { Pack } from "@lenspack/pack";

import type { Connector, Plan } from "./connector";
import { type BoundPlan, ResolveError, type TimeWindow } from "./resolve";

// Query safety at the connector, for every caller alike (a board load, a chat tool, an eval): a query too heavy for
// the database is refused before it is compiled, with words the assistant can act on; the rest go on with the
// deployment's row cap, and a default time window where one is required. Which query is too heavy is the
// deployment's policy (@lenspack/policy checkQuery); this only applies the verdict, so the engine does not know it.

/** A host's verdict on one bound plan: refused, or what to change on the way (nothing, when null). */
export type QueryGuard = (bound: BoundPlan, pack: Pack) => { refuse: { message: string; key?: string; nearest?: string } } | { rowLimit?: number; time?: TimeWindow; note?: string; timeoutMs?: number } | null;

/** Places for queries running at once, across every caller of the connectors that share it (one copy of a server). */
export type QuerySlots = { acquire(): Promise<() => void>; running(): number; waiting(): number };

export function querySlots(max: () => number): QuerySlots {
  let running = 0;
  const waiting: (() => void)[] = [];
  const next = () => {
    while (running < Math.max(1, max()) && waiting.length) {
      running++;
      waiting.shift()!();
    }
  };
  return {
    acquire: () =>
      new Promise((resolve) => {
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          running--;
          next();
        };
        waiting.push(() => resolve(release));
        next();
      }),
    running: () => running,
    waiting: () => waiting.length,
  };
}

/**
 * The same connector, with the guard applied to every plan it compiles (a refusal is a ResolveError, so the engine
 * answers it as data, as any other refusal), its timeout on every execute, and at most `slots` executes at once.
 */
export function guardedConnector<C extends Connector>(connector: C, guard: QueryGuard, o: { slots?: QuerySlots } = {}): C {
  // What the guard said about a plan, for its execute: the note to add, the timeout.
  const said = new WeakMap<Plan, { note?: string; timeoutMs?: number }>();
  return {
    ...connector,
    // Read through, not copied: a connector's capabilities may change while it runs (a deployment's switches).
    get capabilities() {
      return connector.capabilities;
    },
    async compile(bound: BoundPlan, pack: Pack) {
      const v = guard(bound, pack);
      if (v && "refuse" in v) throw new ResolveError("TOO_HEAVY", v.refuse.message, v.refuse.key, v.refuse.nearest);
      const b: BoundPlan = v ? { ...bound, ...(v.rowLimit !== undefined ? { rowLimit: v.rowLimit } : {}), ...(v.time ? { time: v.time } : {}) } : bound;
      const plan = await connector.compile(b, pack);
      if (v && (v.note || v.timeoutMs)) said.set(plan, { ...(v.note ? { note: v.note } : {}), ...(v.timeoutMs ? { timeoutMs: v.timeoutMs } : {}) });
      return plan;
    },
    async execute(plan, opts) {
      const s = said.get(plan);
      const timeoutMs = s?.timeoutMs !== undefined ? Math.min(s.timeoutMs, opts?.timeoutMs ?? Infinity) : opts?.timeoutMs;
      const release = o.slots ? await o.slots.acquire() : () => {};
      try {
        const data = await connector.execute(plan, { ...opts, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
        return s?.note && !data.error ? { ...data, notes: [...(data.notes ?? []), s.note] } : data;
      } finally {
        release();
      }
    },
  };
}

/**
 * The same connector, sending at most `max` queries: one more is refused with `message` (a ResolveError, answered
 * as data). Made once per chat turn, so one question cannot fan out into hundreds of queries.
 */
export function budgetedConnector<C extends Connector>(connector: C, max: number, message: string): C {
  let sent = 0;
  return {
    ...connector,
    get capabilities() {
      return connector.capabilities;
    },
    async execute(plan, opts) {
      if (sent >= max) throw new ResolveError("TOO_HEAVY", message);
      sent++;
      return connector.execute(plan, opts);
    },
  };
}
