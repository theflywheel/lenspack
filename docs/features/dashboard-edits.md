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

With the `reviewer` switch on (the default), every edit a turn makes is held as a draft. The reviewer is a second
model call. It compares the change with the request and with the board before it, and marks each problem it finds:

- **material**: the board would mislead whoever reads it. Examples: wrong or double-counted numbers, a title that
  claims what the query does not do, a required filter missing, the wrong widget changed.
- **minor**: worth a sentence, not a fix.

**When a turn is reviewed.** When the board gained a version, or when it gained none but the reply may say it did:
the model tried an edit that was refused, or its reply says it added, removed, renamed or moved something, in any of
the chat's languages. A question answered with no edit is not reviewed.

**What happens next.** A material finding gets one fix round on the escalation model (the builder, when no
[role](../operating/models.md#roles) names one), then a second check. If the change is still wrong, nothing from the
turn is saved and the reply says the board was left as it was. Minor findings are saved and mentioned in one
sentence in the reply.

**What the reader sees.** The reply describes the board as the turn left it. Words the model writes before its first
edit, and the whole answer to a question, appear as they are written. Words after an edit wait for the reviewer: they
appear when the edit stands, and are replaced by the fix round's words when it does not. So a reply never says "I
added the chart" and then "I removed the chart I added".

**What the audit log records.** While the reviewer is on, the chat panel shows each edit as a draft. The audit log
records each as a `chat-edit` line ending `→ draft v3` (the number it would have if saved). One `chat-save` line
then says which versions the turn saved, or that it saved none. The `chat-turn` line repeats this as `outcome`
(`saved`, `left unchanged` or `not saved`) and `saved` (the version numbers).

The reviewer also checks that an answer said which reading it used when a question could be read two ways; see
[Open questions](open-questions.md#open-questions).

Turning the reviewer off saves a model call per change; a wrong change is then saved as made. Where each step runs is
in [The life of a turn](../architecture/life-of-a-turn.md#the-steps).

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

## When the reply is cut off

A reply can be cut off on its way to the browser after the change was already made: a phone moving between networks
drops the connection, a proxy gives up, Lenspack restarts. The chat panel then finds out what happened before it offers
to ask again:

- Each question goes with a key the panel makes. Lenspack keeps what the turn did under that key for 15 minutes: the
  board's version before and after, the widgets it added, removed or changed by title, and its reply.
- On a cut-off reply the panel asks Lenspack about the key. If the turn changed the dashboard, the panel says so,
  for example "Your change was made: removed “Stock by product”. The connection dropped before the reply finished.",
  shows the reply, and brings the page in step. If the turn answered without a change, the panel shows the answer.
- If Lenspack has no record (it restarted, or the question never arrived), the panel compares the board's version
  with the one it last knew. If the board moved on, it says what changed and does not ask again.
- Otherwise it offers **Retry**. Retry checks again first, then sends the question with the same key. If the turn ran
  after all, Lenspack answers from what it did and makes no change twice.

When someone asks about a widget that is no longer on the board, the assistant can say what happened to it. Each turn
is told which widgets were removed in the last week, in which version, when and by whom, and `list_versions` names the
widgets each version added or removed by title. So it answers "That chart was removed at 10:15 (v3) in this chat. If
you still see it, reload the page." rather than "There is no such chart."

## Superset specifics

Inside Superset, every change is sent to Superset before it counts, and a change Superset refuses is undone. A
chart Lenspack cannot express exactly is kept as Superset's: the assistant can move, resize or remove it, but not
rewrite it. On a dashboard with tabs or columns, charts inside tabs are read, the assistant is told which tab the
viewer has open, and widgets are added, resized, removed and restored in place inside their tab. Moving a widget on
such a dashboard is refused: move it in Superset.

After every change the chat makes, the open page is brought in step with the saved dashboard without a reload: the
dashboard is redrawn in place, and a removed chart goes, a new one appears. The panel then compares the charts the page
draws with the dashboard Superset saved. If the page still draws a chart the saved dashboard no longer has, it reloads
the page instead, keeping the chat open and the tab the viewer had open. Superset's own "Refresh dashboard" doesn't do
this: it asks each chart for its data again, and a removed chart still answers, so it stays on the page until a reload.

See [Datasets and dashboards](../hosts/superset/datasets-and-dashboards.md).

---

**Next:** [Charts, maps and heatmaps](charts.md).

**Related:** [Boards and widgets](../concepts/boards.md) · [Board format](../reference/board.md)
