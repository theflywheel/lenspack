# Dashboard edits, versions and undo

This page describes how a board is changed through the chat, how each change is checked, and how any change can be
undone. It is for people who build dashboards and for admins deciding who may.

## Change a board by asking

"Add a KPI of revenue for the last 30 days at the top." "Make the country chart a pie." "Move the orders table
below the trend." "Add a filter by channel." The assistant turns each request into
[edit operations](../concepts/boards.md#changed-only-by-edit-operations), and each one is checked against the pack
and the source before it lands. A refused operation comes back with the reason and the nearest key, and the
assistant tries again or explains.

Edits can also come from:

- **the board itself**: drag a widget to move it, drag its corner to resize it, or remove it; each is saved as a
  version of its own ("moved Total");
- **the board API**: `POST /api/<pack>/<board>/ops` with `{ "ops": [ … ] }`, from any program. See
  [HTTP API](../reference/http-api.md#the-board-api).

## Who may edit

A person who may only view a board can still ask questions. The edit tools then refuse, and the assistant says
why. Who may edit is decided by the host:

- **in Superset**, whoever Superset lets edit that dashboard (its owners and admins), by default;
- **in the standalone server**, a board's owner (who needs the editor right), and, for the boards that ship with
  the pack, anyone with the maintainer right.

The `boardEdits` switch turns edits through the chat off for everyone, admins included. See
[Rights](../access/rights.md).

## The reviewer

With the `reviewer` switch on (the default), every edit a turn makes is held as a draft. A second model call
compares the change with the request and with the board before it, and marks each problem it finds:

- **material**: the board would mislead whoever reads it (a wrong measure, a title that says something else);
- **minor**: worth a sentence, not a fix.

A material finding gets one fix round, then a second check. If the change is still wrong, nothing from the turn is
saved and the reply says the board was left as it was. Words after an edit wait for the reviewer, so a reply never
claims a change that was then undone. Turning the reviewer off saves a model call per change; a wrong change is
then saved as made. See [The life of a turn](../architecture/life-of-a-turn.md#the-steps).

## Versions and undo

Every accepted change makes a new version: an edit by the assistant, a drag, a rename, a restore. The version
history lists each with who made it, when, and what it did in words. Restoring an earlier version is itself a new
version, so nothing is ever lost. The assistant can list and restore versions too ("undo the last two changes").

Inside Superset, Lenspack's version history is the undo Superset lacks. Today that history is kept in memory and
starts again when Lenspack restarts; Superset's dashboard itself is always kept. **Planned:** history in a
database, so undo survives a restart. See [Stores](../architecture/stores.md).

## Two changes at once

Two requests to change the same board do not run at the same time: the second waits for the first, then starts
from the board as the first left it. See [Busy hours](busy-hours.md).

## Superset specifics

Inside Superset, every change is sent to Superset before it counts, and a change Superset refuses is undone. A
chart Lenspack cannot express exactly is kept as Superset's: the assistant can move, resize or remove it, but not
rewrite it. On a dashboard with tabs or columns, charts inside tabs are read, the assistant is told which tab the
viewer has open, and widgets are added, resized, removed and restored in place inside their tab. Moving a widget on
such a dashboard is refused: move it in Superset.

See [Datasets and dashboards](../hosts/superset/datasets-and-dashboards.md).

---

**Next:** [Charts, maps and heatmaps](charts.md).

**Related:** [Boards and widgets](../concepts/boards.md) · [Board format](../reference/board.md)
