# Your own dashboards and saved layouts (Superset)

When Lenspack runs inside Apache Superset, the dashboards a team shares are kept as they are: only the people
Superset lets edit a dashboard can change it through the chat. Everyone else can still ask questions about it.
This page covers what a person can do when they want to change a dashboard they can only view, or keep a
layout they like.

- **Your own dashboards.** Anyone can make a dashboard of their own, blank or as a copy of one they can view,
  and change it freely through the chat. It is a real Superset dashboard, owned by them.
- **Saved layouts.** Anyone can save the widgets, filters and arrangement of a dashboard under a name, and apply
  it later to a dashboard they can edit.

## Why

A shared dashboard is often the one a whole team reads, so changing it is limited to its owners (see
[Who is asking](../packages/hosts/superset/README.md#who-is-asking)). Before this, someone who could only view a
dashboard could ask questions about it but had nowhere to try a change. Now the chat offers them their own copy,
makes it, and makes the change there. The shared dashboard stays as it was.

## Who may do what

Lenspack talks to Superset through its own admin account, so the rules below are Lenspack's, checked on every
request before anything is written to Superset. They never allow more than Superset does. They live in
`packages/kernel/policy/src/personal.ts`, as plain functions that the chat tools and the panel's routes both
call.

| | who may | |
|---|---|---|
| Ask about a dashboard | everyone who can view it in Superset | unchanged |
| Change a shared dashboard | whoever Superset lets edit it: its owners with `can_write` on Dashboard, and admins | unchanged (`editPolicy: superset`) |
| Make a blank dashboard | anyone signed in, up to the limit | it is owned by them in Superset |
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
- **The Superset plugin** must be the version that signs the user's Superset id (claim `i`). With an older
  plugin, making or copying a dashboard is refused with a message saying to update it.

## In the panel

The Ask Lenspack panel has two new buttons beside New chat. Both open a small menu that works with a keyboard
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

- "Add a chart of visits by week" on a dashboard the person can only view: the edit is refused as before, and
  the reply now offers their own copy. The panel shows a *Make my own copy* button too. If they say yes, the
  chat copies the dashboard, opens the copy and makes the change there.
- "Make me a new dashboard called Stock check", "Delete my Stock check dashboard".
- "Save this layout as Morning briefing", "Apply my Morning briefing layout", "Rename it to Daily", "Delete
  the Daily layout".

The tools are `list_my_dashboards`, `create_dashboard`, `copy_dashboard`, `delete_dashboard`, `save_layout`,
`apply_layout`, `rename_layout` and `delete_layout` (in `packages/kernel/agent/src/personal.ts`). A host gives
the chat its own way to do these things through a small interface, `PersonalPort` in `@lenspack/core`; the
Superset host is the only one that does today.

## Saved layouts and version history

Every change to a dashboard through Lenspack is a new version of its board, and the chat (`list_versions`,
`restore_version`), the board API (`GET .../versions`, `POST .../revert`) and the panel's Undo can go back to an
earlier one. In Superset mode this history is kept in memory by the server and starts again when it restarts. It
has never had a screen of its own in Superset; it is the undo that Superset itself doesn't have.

Saved layouts are a different thing: named copies of a whole board that a person keeps, in a file, until they
delete them, and can apply to any dashboard they may edit. Applying one is a single change, so it is a single
version: Undo, "restore the previous version" or `POST .../revert` take the dashboard back to how it was. A
saved layout records the dashboard it came from, when it was saved, and the pack and pack version it was made
with.

## Settings

| | default | set by |
|---|---|---|
| `personalDashboards` switch | on | `features:` in the config, `LENSPACK_FEATURES`, or an admin on the settings page (like the other [off switches](../packages/hosts/superset/README.md#off-switches)) |
| most dashboards per person | 20 | `personal.maxDashboardsPerUser` in the config, `LENSPACK_MAX_DASHBOARDS_PER_USER`, or an admin |
| most saved layouts per person | 50 | `personal.maxSavedConfigsPerUser` in the config, `LENSPACK_MAX_SAVED_CONFIGS_PER_USER`, or an admin |

Switched off, the two buttons are hidden, the chat tools refuse, and the routes answer 409. Dashboards already
made stay in Superset.

## Routes

All are under Superset's `/lenspack/` and need the signed identity Superset adds (see
[Who is asking](../packages/hosts/superset/README.md#who-is-asking)). Routes about the open dashboard take
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

Refusals answer 403 (not allowed), 404 (no such dashboard or layout), 409 (switched off, or at the limit) or 400,
with `{ok: false, code, error}`; `error` is a sentence to show the person.

## Where it is kept

- `personal-dashboards.json` in the state directory: which Superset dashboards are someone's own, made through
  Lenspack (who, when, copied from which dashboard, and the charts made for it).
- `saved-layouts.json`: the saved layouts, each with its owner's Superset username, name, source dashboard, time,
  pack and pack version, and the board. A `sharing` field is reserved for sharing a layout with others later;
  nothing reads it yet.

Both files are behind a small store interface (`RecordStore` in `@lenspack/core`), read fresh on each use and
written whole, so two server processes on one disk see each other's changes. Several replicas on separate disks
need a database-backed store with the same interface. A dashboard deleted in Superset is dropped from the list
the next time its owner opens the menu.

## Audit and telemetry

Each create, copy, delete, save, apply, rename and delete of a layout is written to the audit log with the
Superset user and the outcome (`ok`, `refused` or `denied`). For a telemetry sink, `personalDashboards()` takes
a `telemetry` callback that receives one event per action (`dashboard.create`, `layout.apply` and so on).
Nothing is connected to it yet.
