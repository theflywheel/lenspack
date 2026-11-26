# The kernel

The kernel is the five packages every deployment uses. This page says what each one owns, so you know where to
look for a behaviour and where a change belongs. It is for developers.

The kernel depends on no database client, no model provider and no web framework. Its only outside dependency of
note is `zod`, which defines every document's schema.

## core

`@lenspack/core` owns the **board** and the **query** as documents.

- The board schema (widgets, filters, layout, grid) and the query schema (the five shapes, filters, time ranges,
  compute steps). See [Board format](../reference/board.md) and [Query format](../reference/query.md).
- The ten **edit operations** and `applyOps`, which checks each one against the catalogue and refuses with the
  nearest key (`nearest()`).
- **Placement and packing**: turning "top, half width" into grid positions, so widgets never overlap.
- The `BoardStore` interface and an in-memory store, with versions, revert and staged copies (`stagedStore`, which
  holds a turn's edits until it ends).
- Summaries of a board and of what changed between versions, in words, for the model and the version history.

## pack

`@lenspack/pack` owns the **pack**.

- `loadPack` and `parsePackText` read YAML or JSON, check it with zod and with cross-reference checks
  (`checkPack`), and throw one error listing every problem.
- `catalogueFrom` builds the catalogue the model and the board app see.
- `packBuilder` lets an importer build a pack in code.
- The **definitions** document: admins' instructions, hints, synonyms and readings, its size budget, and how it is
  merged into the pack for a turn.

## engine

`@lenspack/engine` is the backend-neutral half of answering a query.

- **Resolve** (`resolve.ts`): bind every key, find join paths, refuse fan-out, push the tenant condition, work out
  time windows, apply the caller's scope and hidden keys, and refuse what the source cannot do. A failure is a
  `ResolveError` with a code, the key and the nearest key. See [Refusal codes](../reference/errors.md).
- The **`Connector`** interface every source implements: `capabilities`, `compile`, `execute`, and optionally
  `introspect`. See [Write a source](../extending/write-a-source.md).
- `run`, `explain`, `resolveBoard` (data for a whole board, one scan per distinct query) and `checkOps` (whether an
  edit's queries would run).
- **Compute**: the steps run after the source answers, with the rules for zeros and gaps written once for every
  source. See [The compute step](../features/compute.md).
- Ratios across entities: two aggregates joined on the group, never a row-level join.
- `describeQuery`: a query in plain words, for "How this was worked out".

## agent

`@lenspack/agent` owns what a model can do.

- `boardTools()`: the tools, with no tie to any model provider. Edits are queued and checked before they land.
  `toVercelAI()` adapts them to the Vercel AI SDK. See [Turns](../concepts/turns.md#the-tools).
- `assembleQuery`: turns the tools' simple arguments (filters and compute steps written as short strings) into a
  checked query.
- The **answer card** (`answerCard`): the record behind "How this was worked out".
- **Saved answers** (`reuseLayer`) and the **turn gate** (`localTurnGate`, the queue and one-edit-at-a-time per
  board). Both know nothing of HTTP, so any host can use them.
- `clarify`, the tool that asks which reading was meant, and the open-questions log.
- Proposals: where `propose_measure` writes, as unverified.
- The personal-dashboard tools (`list_my_dashboards`, `create_dashboard`, `copy_dashboard`, `delete_dashboard`,
  `save_layout`, `apply_layout`, `rename_layout`, `delete_layout`), which a host offers by implementing
  `PersonalPort` from `@lenspack/core`. The Superset host is the only one that does today.

## policy

`@lenspack/policy` decides who may see and change what. Its functions are pure: they take what the host says and
return a decision; the engine enforces it.

- `principalOf`: an identity from the host, settled into a principal with rights.
- `decide`: what a caller may use of one pack: the pack and catalogue as they see it, their row scope, their
  hidden keys and kept entities.
- `boardRights`: whether a caller may view or edit a board. It also applies `editScope` and hides people's own
  dashboards from everyone but their owner and admins (`hiddenPersonalBoards`).
- `adminRights` and `mayAdminister`: whether a caller may use the admin pages and see user names.
- `answerView` and `showsStatement`: what the answer card may show a caller.
- The rules for [personal dashboards and saved layouts](../features/personal-dashboards.md) (making, copying,
  deleting, saving and applying, and the limits), in `personal.ts`. The data a person reads on a dashboard is
  `decide()` with that dashboard, so dashboard roles count there and only there.

See [Policy](../concepts/policy.md) and [Who sees what](../access/README.md).

## Planned changes

Two moves are planned, and new work should fit them:

- **The turn moves into `agent`** as one function (`runTurn`), with a mode for questions and a mode for edits.
  Today the turn lives in the standalone server's package. See [The life of a turn](life-of-a-turn.md).
- **Policy becomes a document** of its own, versioned like a pack or a board, holding rules, rights and per-role
  feature grants, loaded by every host and edited from the admin panel. The engine's `Capabilities` splits into
  what the source can compute, what the board's host can store, and what the deployment allows.

---

**Next:** [The life of a query](life-of-a-query.md).

**Related:** [Packages](../reference/packages.md) · [How a host plugs in](hosts.md)
