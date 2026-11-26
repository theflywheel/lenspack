# Write a host

This page shows how to run Lenspack inside an app of your own: what you must hand the kernel, what you get back, and
the rules your host must keep. It is for developers. The contract is described in
[How a host plugs in](../architecture/hosts.md); this page is the how-to.

## Choose how much to build

| you want | build | reuse |
|---|---|---|
| Lenspack's server, with your sign-in | an `access(request)` hook | `createApp` from `@lenspack/serve`: board API, chat, metering, budget, audit |
| boards in your own front end | host callbacks | `@lenspack/react` over the board API, or over your own server |
| a model in your own agent loop | nothing: call the tools | `boardTools()` from `@lenspack/agent`, with `toVercelAI()` or `createMcpServer()` |
| a whole new host (another BI tool) | identity, store, connector, UI | the kernel, as the Superset host does |

## 1. Say who is asking

Turn your app's signed-in user into an `Identity` and settle it into a principal:

```ts
import { principalOf, decide, boardRights } from "@lenspack/policy";

const identity = {
  user: "someone",
  roles: ["analyst"],
  tenant: "acme",                                                  // narrows every query to this tenant
  scope: [{ dimension: "country", op: "eq", value: "PT" }],        // rows they may see
  hiddenEntities: ["payroll"],                                     // tables your app keeps from them
  readOnly: "you can view this board but not edit it",            // they may ask, not change
};
const who = principalOf(identity, { editors: [], maintainers: ["role:analyst"], usage: [] });
```

Everything your app already limits goes in the identity. Lenspack's rules can only narrow it. When your app cannot
tell what someone may see, keep it from them: put the table in `hiddenEntities`, and explain why in `hiddenReason`.

## 2. Decide, for each pack and board

```ts
const d = decide(who, pack, { name: "shop", rules: packRules, board: boardId });
if (!d) return notFound();                       // they may not open this pack
const { pack: theirPack, ctx } = d;              // the pack as they see it, and the context every query carries
const rights = boardRights(who, board);          // { view, edit }
```

Pass `ctx` to every call that reads data: `resolveBoard`, `run`, `explain`, `boardTools`. Never build a query
without it.

## 3. Read data and run tools

```ts
import { resolveBoard } from "@lenspack/engine";
import { boardTools, toVercelAI } from "@lenspack/agent";

const data = await resolveBoard(board.config, { pack: theirPack, connector, ctx }, selections);
const tools = toVercelAI(boardTools({ pack: theirPack, connector, store, boardId, ctx }));
```

For a chat, also consider the kernel's host-neutral parts: `reuseLayer` for saved answers, `localTurnGate` for the
queue, `answerCard` for "How this was worked out" and `clarifyTool`. See [The kernel](../architecture/kernel.md#agent).

## 4. Keep boards

Implement `BoardStore` from `@lenspack/core`, or use one that ships: `memoryStore()`, `sqlStore(db)` (DuckDB or
Postgres) from `@lenspack/sql`. Wrap it to mirror another system, as the Superset host's `supersetBoards` does: send
every change to the other system before it counts, and undo it if refused.

## Rules your host must keep

- **Every caller goes through `decide()`.** A host with more than one caller never reads data outside it.
- **Only narrow.** Nothing in your config should widen what your app allows.
- **Fail closed.** When you cannot tell, show less.
- **Keep boards apart from data.** The board store is never a source.
- **Audit and meter.** Pass an audit hook; wrap model calls with `withMeter` so they are counted and budgeted.
- **Test outcomes, not mechanics.** Write cases that sign in as each kind of user and check what they can see and
  change, the way the [access suite](../access/testing.md) does for Superset.

**Planned:** the turn and its runtime (models, metering, budget, audit) move into shared packages, so a new host
calls one function per turn instead of reusing the standalone server. See
[The life of a turn](../architecture/life-of-a-turn.md#planned-one-turn-in-the-kernel).

---

**Next:** [Add a model provider](model-adapter.md).

**Related:** [How a host plugs in](../architecture/hosts.md) · [Policy](../concepts/policy.md) · [React](../hosts/react.md)
