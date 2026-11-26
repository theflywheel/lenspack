# Boards and widgets

A board is a dashboard written as a document. This page explains what a board holds, how it changes, and why it
can never hold code. It is for anyone building boards or reading their JSON.

## What a board holds

- a **title**;
- **widgets**, each with a title and, except text, one [query](queries.md):
  - **kpi**: one number, optionally with its trend and the previous period;
  - **chart**: `bar`, `line`, `area`, `pie`, `heatmap` or `map`;
  - **table**: rows or groups, a page at a time;
  - **text**: a short note, with a little formatting (bold, italics, lists, code). It is never drawn as HTML,
    and a link in it shows as its text only;
- **filters**: the board's filter bar (see [Filters](filters.md#2-a-boards-filter-bar));
- a **layout** on a 12-column grid.

## Changed only by edit operations

Nothing writes a board directly, not even the model. Every change is one of ten operations, each checked before it
lands:

`add_widget`, `update_widget`, `remove_widget`, `move_widget`, `resize_widget`, `set_title`, `add_filter`,
`update_filter`, `remove_filter`, `set_layout_mode`.

```json
{ "op": "add_widget", "id": "revenue_30d",
  "widget": { "kind": "kpi", "title": "Revenue, last 30 days",
    "query": { "kind": "value", "measure": "revenue", "compare": "previous_period", "time": { "last": "30d" } } },
  "placement": { "place": "top", "width": "quarter" } }
```

An operation that names a key the pack lacks, or a query the source would refuse, is refused with the reason and,
where one exists, the nearest key. The same operations come from the model, from the board API
(`POST /api/<pack>/<board>/ops`) and from the board app's drag and drop.

## Placement is intent

The model never gives coordinates. It says where a widget should go (`top`, `bottom`, `after:<id>`,
`below:<id>`) and how wide (`full`, `half`, `third`, `quarter`, or a number of columns). Lenspack packs the grid,
so two widgets can never overlap.

## Every change is a version

Each accepted change makes a new version of the board. Any earlier version can be restored, which is itself a new
version, so nothing is lost. The chat can list and restore versions too. See
[Dashboard edits, versions and undo](../features/dashboard-edits.md).

## What a board can never contain

- **No SQL and no table names.** Widgets name pack keys only.
- **No URLs.** Widgets have no sources of their own; the pack does. A link written in a note shows as its text, not
  as a link.
- **No markup.** A note's formatting is built as page elements, never as HTML from the text.
- **No colours.** A widget names a scheme (`default` or `sequential`); the renderer maps it to its palette.

So any renderer can draw any board, and a board copied between deployments carries no code with it.

## Who owns a board

The pack can ship boards of its own, which everyone may read and only maintainers change. A board someone makes is
theirs: hidden until they share it, and read-only to others after, who may save a copy. Inside Superset, boards are
Superset dashboards and follow Superset's own rights. See [Rights](../access/rights.md#boards-have-owners).

---

**Next:** [Turns](turns.md).

**Related:** [Board format reference](../reference/board.md) · [Charts, maps and heatmaps](../features/charts.md)
