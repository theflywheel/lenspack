import type { Connector, SourceStatement } from "./connector";

// What a source actually ran, for "how this was worked out" under a chat answer. Recorded at the
// connector, as meteredConnector counts there, so every way a query reaches a source (a plain
// query, both sides of a cross-entity ratio, a computed query's base, a share's whole) is seen,
// and nothing runs twice to be explained: the statements are the ones that answered.

/** One source call: what ran, in the order the source answered. */
export type SourceCall = SourceStatement;

/** The language a connector's plan text is in when it says nothing itself. */
const languageOf = (kind: string): SourceStatement["language"] => (kind === "elasticsearch" ? "json" : "sql");

/**
 * The same connector, with what every execute ran pushed onto `out`: what the connector reports
 * through `ran`, else its plan's text. A call that fails is recorded too, since it ran.
 */
export function tracedConnector<C extends Connector>(connector: C, out: SourceCall[]): C {
  return {
    ...connector,
    get capabilities() {
      return connector.capabilities;
    },
    async execute(plan, opts) {
      const own: SourceCall[] = [];
      try {
        return await connector.execute(plan, {
          ...opts,
          ran: (s) => {
            own.push(s);
            opts?.ran?.(s);
          },
        });
      } finally {
        out.push(...(own.length ? own : [{ language: languageOf(connector.kind), text: plan.text }]));
      }
    },
  };
}
