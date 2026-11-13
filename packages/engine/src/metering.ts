import type { Connector } from "./connector";

// What the backend was asked to do: how many queries, how long they took,
// how many rows came back. Counted at the connector, so every caller — a
// board load, a chat tool, an eval — is counted the same way whatever the
// backend is, and a new connector is metered without knowing it is.

export type QueryMeter = { queries: number; failed: number; ms: number; rows: number };

export const emptyQueryMeter = (): QueryMeter => ({ queries: 0, failed: 0, ms: 0, rows: 0 });

/**
 * The same connector, with every execute counted into each meter given. A
 * refusal never reaches execute, so it costs nothing and is not counted; an
 * answer that carries an error is a failed query.
 */
export function meteredConnector<C extends Connector>(connector: C, ...meters: QueryMeter[]): C {
  return {
    ...connector,
    async execute(plan, opts) {
      const started = performance.now();
      let failed = true;
      let rows = 0;
      try {
        const data = await connector.execute(plan, opts);
        failed = !!data.error;
        rows = data.records?.length ?? data.rows.length;
        return data;
      } finally {
        const ms = performance.now() - started;
        for (const m of meters) {
          m.queries += 1;
          m.failed += failed ? 1 : 0;
          m.ms += ms;
          m.rows += rows;
        }
      }
    },
  };
}
