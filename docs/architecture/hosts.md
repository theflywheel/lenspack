# How a host plugs in

This page describes the contract between a host and the kernel: what the host must give, what it gets back, and
how the two shipped server hosts fill it in. It is for developers writing a host or reading one.

## What the host gives

| the host gives | as | example |
|---|---|---|
| Who is asking | an `Identity`: user, roles, tenant, and anything the host already limits (a row scope, keys or entities kept from them, boards they may not open, read-only) | Superset's signed header; a session cookie |
| The pack | a loaded `Pack` | a file, or one built from Superset's datasets |
| The data | a `Connector` | `sqlConnector`, `elasticsearchConnector`, `supersetConnector` |
| Where boards live | a `BoardStore` | a SQL store; Superset's dashboards |
| The turn | models, metering, budget, audit, the stream | today, the standalone server's runtime |
| A user interface | anything | the board app, Superset's chat panel |

## What it gets back

- `decide(identity, pack, …)`: the pack and catalogue as this caller sees them, their context (`ctx`: scope,
  hidden keys, kept entities) and a notice when they may read nothing. See [Policy](../concepts/policy.md).
- `boardRights(principal, board)`: whether they may view and edit this board.
- `boardTools({ pack, connector, store, boardId, ctx, … })`: the model's tools, already narrowed.
- `resolveBoard`, `run`, `explain`, `checkOps`: data and checks, all through `resolve`.
- `answerCard`, `reuseLayer`, `localTurnGate`, `clarifyTool`: the answer card, saved answers, the queue and the
  clarify tool, none of which know HTTP.

## The standalone server

`lenspack serve` reads `lenspack.yaml`, opens each source and the board store, and binds each pack to its source.
Its sign-in adapters (password, OpenID Connect, proxy, tokens) produce the identity. It serves the board API, the
chat, the admin panel and, when given one, the board app. See [The standalone server](../hosts/serve.md).

## The Superset host

`lenspack superset` is the same server runtime with Superset in each slot:

- **identity**: a header Superset's plugin signs on every request, with the user, their roles, the dashboard the
  request is about and their rights on it. See [Who is asking](../hosts/superset/identity.md).
- **pack**: built at start-up from the configured datasets and an overlay.
- **connector**: Superset's chart-data API, through Lenspack's own Superset account.
- **store**: Superset's dashboards, with every change sent to Superset before it counts.
- **access**: each person's Superset dataset access, row-level security and dashboard rights, asked of the plugin.
  See [Access inside Superset](../access/superset.md).

## The MCP server

`lenspack-mcp` has one caller, the person who started it. It does not go through `decide()`, so access rules in
`lenspack.yaml` do not apply to it. See [MCP server](../hosts/mcp.md).

## Planned

- **A runtime package.** Today the Superset host imports the standalone server's package to reuse its runtime
  (models, metering, budget, audit, settings, speech and the turn). That runtime moves to a package of its own, and
  the turn into the kernel (see [The life of a turn](life-of-a-turn.md#planned-one-turn-in-the-kernel)), so each
  host is a thin layer.
- **A registry of sources**, like the one model adapters and SQL drivers already have, so a deployment can add a
  source the repository does not ship without changing the server.

---

**Next:** [Why the model cannot break things](safety.md).

**Related:** [Write a host](../extending/write-a-host.md) · [Hosts](../concepts/hosts.md)
