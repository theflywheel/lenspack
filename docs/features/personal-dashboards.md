# Personal dashboards and saved layouts

This page covers what a person can do inside Superset when they want to change a dashboard they can only view, or
keep a layout they like. It is for people using Lenspack in Superset and for admins setting the limits.

When Lenspack runs inside Apache Superset, the dashboards a team shares are kept as they are: only the people
Superset lets edit a dashboard can change it through the chat. Everyone else can still ask questions about it.

- **Your own dashboards.** Anyone can make a dashboard of their own, blank or as a copy of one they can view,
  and change it freely through the chat. It is a real Superset dashboard, owned by them.
- **Saved layouts.** Anyone can save the widgets, filters and arrangement of a dashboard under a name, and apply
  it later to a dashboard they can edit.

## Why

A shared dashboard is often the one a whole team reads, so changing it is limited to its owners (see
[Who is asking](../hosts/superset/identity.md#who-may-edit)). Someone who can only view it still has somewhere to try
a change: the chat offers them their own copy, makes it, and makes the change there. The shared dashboard stays as
it was.

## Who may do what

Lenspack talks to Superset through its own admin account, so the rules below are Lenspack's, checked on every
request before anything is written to Superset. They never allow more than Superset does. They live in
`@lenspack/policy`, as plain functions that the chat tools and the panel's routes both call, like the rest of
Lenspack's [access rules](../access/README.md): who counts as an admin is `adminRights()`, what a person may do on a
dashboard is `boardRights()` (which also applies the edit scope below), and the data a person reads on a dashboard
is `decide()` with that dashboard, so dashboard roles count there and only there. The rules for making, copying,
deleting, saving and applying are in `packages/kernel/policy/src/personal.ts`.

| | who may | |
|---|---|---|
| Ask about a dashboard | everyone who can view it in Superset | unchanged |
| Change a shared dashboard | whoever Superset lets edit it: its owners with `can_write` on Dashboard, and admins | unchanged (`editPolicy: superset`) |
| Make a blank dashboard | anyone signed in, up to the limit | it is owned by them in Superset |
| Open someone's own dashboard | its owner, and admins | narrower than Superset, which opens a draft with no roles for anyone who has its address |
| Copy a dashboard | anyone who can view it, up to the limit | the copy and its charts are new and owned by them |
| Delete a dashboard | its owners in Superset, and admins | never anyone else's, whatever else they may edit |
| Save a layout | anyone who can view the dashboard, up to the limit | saving under a name they already used replaces it |
| Apply a layout | the layout's owner (or an admin), on a dashboard they may edit | otherwise: make your own copy first |
| Rename or delete a layout | its owner, and admins | |
| See everyone's | admins | `GET /_superset/personal` |

Some details:

- **Owners are real people.** A new dashboard, a copy and every chart made for them are given the person's own
  Superset user as owner, not Lenspack's account. That person can then also edit them in Superset itself.
- **Deleting** checks the owners Superset has for the dashboard at that moment. Charts that were made for the
  dashboard (copied, or added by Lenspack) are deleted with it, unless another dashboard also uses them.
- **Applying** a layout checks each widget again, for the person and the dashboard it lands on: a widget that
  uses something they can't see (a dataset or field hidden from them under `hostPolicy: superset`) is left out,
  and the reply names it. Filters the target can't have are left out the same way. The dashboard keeps its own
  title.
- **A copy keeps every chart.** Superset's copy keeps only the charts its layout places, so a chart that is on
  the original but missing from its layout is placed first, where Superset draws such charts: the first tab of a
  dashboard with tabs, else the end of the grid. The layout is checked before the copy is made; one Superset
  could not draw is refused, unless the original already had the same problem.
- **Your own dashboards are yours.** Superset lets anyone open a draft dashboard that has no dashboard roles if
  they know its address. Lenspack doesn't: a dashboard made or copied through Lenspack is hidden from everyone but
  its owner and admins (`hiddenPersonalBoards()` in policy, applied through `boardRights()`), in the chat, the board
  API, the dashboard lists and the copy menu. Sharing one isn't built yet.
- **A copy starts private.** A new dashboard or a copy is a draft (not published) with no dashboard roles. A copy
  of a dashboard that some people open through its dashboard roles (Superset's `DASHBOARD_RBAC`) does not carry
  those roles, so it does not give them, or its owner, the access the original's roles gave. The owner reads on it
  only what their own Superset access allows.
- **The Superset plugin** must be the version that signs the user's Superset id (claim `i`). With an older
  plugin, making or copying a dashboard is refused with a message saying to update it.

## In the panel

The Ask Lenspack panel has two buttons beside New chat. Both open a small menu that works with a keyboard
(Escape closes it) and a screen reader, in English, French, Portuguese and Hindi, in light and dark, and at phone
width.

- **My dashboards** (the grid icon): *New dashboard* asks for a name and makes it. *Make my own copy of this
  dashboard* copies the one that is open. Below them is the list of the person's dashboards (with how many of
  the limit are used): open one, or delete it after a confirmation that says its charts go with it.
- **Saved layouts** (the bookmark icon): *Save this layout* asks for a name. Each saved layout can be applied,
  renamed or deleted (after a confirmation). On a dashboard the person can only view, Apply is greyed out with
  "You can't edit this dashboard. Make your own copy first", and a *Make my own copy* button. After an apply the
  panel shows how many widgets were left out and an *Undo* button.

## In the chat

The chat understands the same requests, through tools that check the same rules:

- "Add a chart of orders by week" on a dashboard the person can only view: the edit is refused, and the reply
  offers their own copy. The panel shows a *Make my own copy* button too. If they say yes, the
  chat copies the dashboard, opens the copy and makes the change there.
- "Make me a new dashboard called Weekly sales", "Delete my Weekly sales dashboard".
- "Save this layout as Morning briefing", "Apply my Morning briefing layout", "Rename it to Daily", "Delete
  the Daily layout".

The tools are `list_my_dashboards`, `create_dashboard`, `copy_dashboard`, `delete_dashboard`, `save_layout`,
`apply_layout`, `rename_layout` and `delete_layout` (in `packages/kernel/agent/src/personal.ts`). A host gives
the chat its own way to do these things through a small interface, `PersonalPort` in `@lenspack/core`; the
Superset host is the only one that does today.

## Saved layouts and version history

Every change to a dashboard through Lenspack is a new version of its board, and the chat (`list_versions`,
`restore_version`), the board API (`GET .../versions`, `POST .../revert`) and the panel's Undo can go back to an
earlier one. In Superset this history is kept in memory by the server and starts again when it restarts. It has no
screen of its own in Superset; it is the undo that Superset itself doesn't have. See [Dashboard edits, versions and
undo](dashboard-edits.md#versions-and-undo).

Saved layouts are a different thing: named copies of a whole board that a person keeps, in a file, until they
delete them, and can apply to any dashboard they may edit. Applying one is a single change, so it is a single
version: Undo, "restore the previous version" or `POST .../revert` take the dashboard back to how it was. A
saved layout records the dashboard it came from, when it was saved, and the pack and pack version it was made
with.

## Where the chat may edit: `editScope`

By default (`editScope: superset`) the chat changes any dashboard Superset lets the person edit.
With `editScope: own`, the chat changes only the person's own dashboards: the ones they made or copied through
Lenspack. On any other dashboard, even one Superset lets them edit (an owner of a shared dashboard, say), the
chat refuses the change and offers "make my own copy". In the panel, the copy item and the saved-layout note then
read "Make my own copy to edit". Admins are still allowed unless `adminsExempt` is false.

Use `own` when many people use the same shared dashboards: the official dashboards stay as they are, everyone still asks
questions about them, and anyone who wants something different makes a copy of their own. Changes to the official ones
are then made in Superset, or through the chat by an admin.

```yaml
editScope: own                                   # or: { scope: own, adminsExempt: false }
```
```sh
LENSPACK_EDIT_SCOPE=own                          # and LENSPACK_EDIT_SCOPE_ADMINS_EXEMPT=false
```

An admin can change it on a running server with `PUT /_superset/settings/edit-scope` (below); it applies from
the next request, and the change goes to the audit log. It only ever narrows what Superset allows. With the
other switches:

| `boardEdits` | `personalDashboards` | `editScope` | who edits through the chat |
|---|---|---|---|
| off | any | any | nobody, admins included |
| on | any | `superset` | whoever Superset lets edit the dashboard |
| on | on | `own` | each person on their own dashboards; admins anywhere Superset allows (unless not exempt) |
| on | off | `own` | nobody but exempt admins: Lenspack warns about this at startup and on the settings page |

A dashboard someone made directly in Superset, not through Lenspack, counts as shared under `own`.

How it is decided: when `own` is on, the Superset host tells policy which dashboards are the person's own (from
the list of dashboards made or copied through Lenspack), and `boardRights()` narrows the edit on every other one,
with the reason the chat gives. The board API and the chat both ask `boardRights()`, so they always agree.

## Settings

| | default | set by |
|---|---|---|
| `personalDashboards` switch | on | `features:` in the config, `LENSPACK_FEATURES`, or an admin on the settings page (like the other [switches](../operating/switches.md)) |
| most dashboards per person | 20 | `personal.maxDashboardsPerUser` in the config, `LENSPACK_MAX_DASHBOARDS_PER_USER`, or an admin |
| where the chat may edit | `superset` | `editScope` in the config, `LENSPACK_EDIT_SCOPE` and `LENSPACK_EDIT_SCOPE_ADMINS_EXEMPT`, or an admin |
| most saved layouts per person | 50 | `personal.maxSavedConfigsPerUser` in the config, `LENSPACK_MAX_SAVED_CONFIGS_PER_USER`, or an admin |

Switched off, the two buttons are hidden, the chat tools refuse, and the routes answer 409. Dashboards already
made stay in Superset.

## Routes

All are under Superset's `/lenspack/` and need the signed identity Superset adds (see
[Who is asking](../hosts/superset/identity.md)). Routes about the open dashboard take
`?dashboard=<id>`, and the plugin signs the person's rights on that dashboard. A request for a different
dashboard than the one signed is refused (403).

| | |
|---|---|
| `GET /_superset/my?dashboard=<id>` | the person's dashboards and saved layouts (an admin: everyone's layouts), the limits, and what they may do on this dashboard |
| `POST /_superset/my/dashboards` | `{title}`: a new blank dashboard. With `?dashboard=<id>` and `{copy: true, title?}`: a copy of that one |
| `POST /_superset/my/dashboards/delete` | `{dashboard}`: delete one (its owners and admins only) |
| `POST /_superset/my/layouts?dashboard=<id>` | `{name}`: save the open dashboard's layout |
| `POST /_superset/my/layouts/<id>/apply?dashboard=<id>` | apply it to the open dashboard; returns `{previous, version, skipped}` (`previous` is what Undo reverts to) |
| `POST /_superset/my/layouts/<id>/rename` | `{name}` |
| `POST /_superset/my/layouts/<id>/delete` | |
| `GET /_superset/personal` | admins: everyone's dashboards and layouts, by person: `{limits, users: [{user, dashboards, layouts}]}` |
| `PUT /_superset/settings/personal` | admins: any of `{maxDashboardsPerUser, maxSavedConfigsPerUser}`; `null` hands a value back to the config |
| `PUT /_superset/settings/edit-scope` | admins: any of `{scope: "superset" \| "own", adminsExempt}`; `null` hands a value back to the config. `GET /_superset/settings` shows `editScope` with a `warning` when nobody could edit |

Refusals answer 403 (not allowed), 404 (no such dashboard or layout), 409 (switched off, or at the limit) or 400,
with `{ok: false, code, error}`; `error` is a sentence to show the person.

## Where it is kept

- `personal-dashboards.json` in the state directory: which Superset dashboards are someone's own, made through
  Lenspack (who, when, copied from which dashboard, and the charts made for it).
- `saved-layouts.json`: the saved layouts, each with its owner's Superset username, name, source dashboard, time,
  pack and pack version, and the board. A `sharing` field is reserved for sharing a layout with others later;
  nothing reads it yet.

Both files are behind a small store interface (`RecordStore` in `@lenspack/core`), read fresh on each use and written
whole, so two server processes on one disk see each other's changes. Several copies of the server on separate disks need
a database-backed store with the same interface (see [Stores](../architecture/stores.md)). A dashboard deleted in
Superset is dropped from the list the next time its owner opens the menu.

## Audit and telemetry

Each create, copy, delete, save, apply, rename and delete of a layout, and each change to the limits or the edit
scope, is written to the audit log with the Superset user and the outcome (`ok`, `refused` or `denied`).

### Usage telemetry

With [usage telemetry](telemetry.md) on, each action that succeeds is also one telemetry event, kept by the item
`personal-dashboards` ("Own dashboards made, copied and deleted; saved layouts used", in the Trust and reuse
section, on by default, and off whenever `personalDashboards` is off):

| event | `how` | `data` |
|---|---|---|
| `personal-dashboard` | `create`, `copy`, `delete` | the dashboard's id; for a copy, also the original's id and how many charts were copied |
| `saved-layout` | `save`, `apply`, `rename`, `delete` | the layout's id; for an apply, how many widgets were left out |

Events carry ids and counts only, never titles or layout names. Like other events, each records the user and
their Superset role names (shown to admins with the usage right) and the dashboard it was on.

---

**Next:** [Open questions and definitions](open-questions.md).

**Related:** [Rights](../access/rights.md) · [Access inside Superset](../access/superset.md) ·
[Dashboard edits, versions and undo](dashboard-edits.md)
