# Stores, and running several copies

This page lists everything Lenspack keeps between requests, which interface each sits behind, and what that means
if you run more than one copy of the server. It is for anyone deploying Lenspack for many people.

## The stores

| what | interface | today | shared by several copies? |
|---|---|---|---|
| Boards and their versions (standalone server) | `BoardStore` | memory, a DuckDB file, or Postgres (`store:` in `lenspack.yaml`) | yes, with Postgres |
| Boards inside Superset | `BoardStore` wrapping Superset | Superset's dashboards are the record; Lenspack's own version history is held **in memory** and starts again on restart. Links between widgets and charts are kept in `superset-boards.json` | dashboards yes; version history no |
| A turn's draft edits | `stagedStore` | in memory, for the length of one turn | not needed |
| Switches, definitions, open questions, review runs, settings | a small document store: one file per named document, read fresh on each use and written only if unchanged since it was read | files in the state directory | yes, on one shared disk |
| Saved answers, board edit counts | `AnswerStore` | `reuse.json` in the state directory | no: each copy keeps its own |
| The queue and one-edit-at-a-time per board | `TurnGate` | `localTurnGate`, in memory | no: each copy limits only its own turns |
| Usage figures | the usage ledger | in memory, read back from the usage file at start when one is set | per copy |
| Audit log | append-only JSON lines | files | one file per copy, or a shared disk |
| The usage board's data | an in-process DuckDB | `usage.duckdb` in the state directory | per copy |

When the state directory cannot be written (a full disk, a read-only mount), Lenspack keeps answering. Settings
writes fail with a clear 503, and the links between widgets and charts are kept in memory until a save works
again. See [What Lenspack keeps on disk](../operating/state.md).

## Running several copies today

- **The standalone server** runs well as several copies when boards are in Postgres and every copy shares one
  state directory (or the same admin password and session secret). Each copy still runs its own queue and its own
  saved answers.
- **Inside Superset**, run one copy. Board bookkeeping and version history are per process.
- **Sessions**: under the built-in password sign-in, replicas need the same state directory, or the same password
  and `sessionSecret`, or a session made on one is unknown to the others.

## Planned

So that a deployment can run two or more copies behind a load balancer:

- **Boards, versions, chart links, usage and settings in Postgres.** Inside Superset, the existing SQL board store
  replaces the in-memory history, so undo survives a restart.
- **A shared turn gate** on database row locks or a small queue service, implementing the same `acquire`,
  `settings` and `stats` calls, so the queue and the one-edit-at-a-time rule hold across copies.
- **A database-backed answer store** with the same calls (`get`, `put`, `delete`, `entries` and a few counters),
  so every copy sees every saved answer.
- **Chat traffic routed to Lenspack directly**, rather than through Superset's web server, so chat streams stop
  holding Superset's threads.
- **Edits attributed to the person**, not to Lenspack's service account, in Superset's own history.

Every store above already sits behind an interface for this reason: a database-backed version implements the same
calls and nothing else changes.

---

**Next:** [How a host plugs in](hosts.md).

**Related:** [Deploying](../operating/deploying.md) · [What Lenspack keeps on disk](../operating/state.md)
