# Changing the pack while it runs

This page explains how an admin changes the pack (labels, hints, measures, example questions and the rest of the
overlay) on a running Lenspack, with no redeploy and no restart, and what stays in the deploy config. It is for
admins of a deployment whose `superset.yaml` they can't change quickly: it sits in another team's repository, or
nobody has access to the server.

## What it is

The pack is built from Superset's datasets and the `overlay:` in `superset.yaml` (see
[Datasets and dashboards](datasets-and-dashboards.md#the-overlay)). The overlay in the file stays the **base**. What an
admin changes while the server runs is a **layer over it**, kept in the state directory (`pack-layer.json`, readable by
the server's own user only). Each part the layer sets replaces the file's part whole; a part it doesn't set follows the
file. On a fresh state directory there is no layer, and the file alone decides, as before.

Every change is a **version**, with who made it, when, why and which parts it changed. Any version can be shown,
compared with another, gone back to, or exported as YAML to write back into `superset.yaml` later.

## What can change, and what can't

| can change while it runs | stays in the deploy config |
|---|---|
| `description` | `pack` (the pack's name) |
| `instructions` | `entities` (each dataset's key) |
| `labels`, `hints` (text, or text per language) | `timeZone` |
| `measures` (base measures from columns) | `geo`, `mapStyle` (maps) |
| `examples` (the suggested questions and their checked queries) | `panel` (how the chat opens: a setting of its own, `settings/panel`) |
| `notDimensions` | `datasets`, `scope`, `dashboards`, `dashboardScope` |
| `hierarchies` | who is an admin or a user (`auth`); the budget caps and the models offered are settings of their own ([What can change without a redeploy](runtime.md)) |
| `exclude`: **more** exclusions only | `exclude`: the file's own exclusions can't be removed |

Why the right-hand side stays in the file:

- **The data boundary.** Which datasets Lenspack reads, the pack's row scope, which dashboards it works on, who may
  use it and what it may spend decide what data anyone can reach and at what cost. They change only with a reviewed
  change to the deploy config.
- **Exclusions only grow.** A change here can exclude more columns or datasets, never fewer than the file does. You can
  take back an exclusion added here; you can't take away one the file makes.
- **`entities`** gives each dataset its key. The file's `scope` names those keys, and row-count measures are named after
  them (`orders_count`), so renaming one at runtime could leave a scope clause applying to nothing or break boards,
  saved answers and definitions that use the old keys.
- **`timeZone`** says where the deployment is. It decides what "today" and "last month" mean for everyone, and the
  daily review and saved-answer refresh schedules are set from it at start. It is set once, when the deployment is
  made, and is not a matter of wording.
- **`pack`** is the name the definitions, saved answers and addresses (`/api/<pack>/…`) are kept under.
- **`geo` and `mapStyle`** say which columns are people's locations and which outside server draws the map tiles.
  `panel` is a setting of the chat window, not the pack.

Synonyms and readings ("when someone asks about sales this month, use…") are the pack's
[definitions](../../concepts/definitions.md), which admins already change on the admin panel's Definitions tab or with
`…/admin/api/definitions`. Labels written in several languages also become words the chat knows a key by.

## How a change is checked

Every change is checked the way the pack is checked at start-up, against Superset's datasets **as they are now**
(Lenspack reads them again from Superset first):

- each measure's dataset, column, aggregate and conditions (a column that is not there, an excluded column, a sum of a
  text column, a key already taken);
- every hierarchy level is a dimension;
- the deploy config's `scope` still has its dimensions, so no question that should be narrowed is answered for all rows;
- every example question's query is checked against the new pack, as the chat would run it under the pack's scope,
  and its other languages are kept as wordings of the same checked query;
- the overlay parts have the right shape, and nothing outside the runtime part is changed.

A change that adds a problem is **refused, with nothing changed**, and the answer lists each problem. Problems the
pack already had (from the file) don't block a change; a change may fix them. Warnings that don't block (a column left
out, a dataset whose series can't be drawn outside UTC) are returned with the result.

**Validate** runs the same check and changes nothing.

## What happens when a change is saved

1. The new version is written to `pack-layer.json` (whole or not at all). If the disk refuses, the answer is `503`
   and nothing changes.
2. The new pack is put in place at once. The next question, board load, filter menu and saved-answer refresh use it.
   **A question already being answered finishes on the pack it started with.** A dashboard edit in flight at that very
   moment may be refused, and can be asked again.
3. Saved answers kept under the old pack are not served: each one's key includes the pack's fingerprint, and those
   kept under another pack are dropped, as at start-up.
4. Every dashboard Lenspack has read is read again under the new pack in the background, so a chart that now matches a
   measure (or no longer does) shows that way.
5. The suggested questions in the chat change on the next page load.

The audit log gets one line per change: `pack edit`, `pack revert` or `pack reset`, with who made it (a user name, or
`api:<name>` for an [admin API key](../../access/admin-api.md)), the version and what changed. Refused changes are
logged as `refused`, with why.

## After a restart

The layer is read back and laid over the file's overlay. If the saved changes no longer build against Superset's
datasets (a column they use was removed in Superset), Lenspack starts with the file's pack alone, says so in the log,
and `GET …/settings/pack` shows the version that was set aside and why (`notApplied`). Fix it with a new change, or reset. A
`pack-layer.json` that can't be read is set aside as `pack-layer.json.unreadable-<time>`; the server still starts.

When you change the file's overlay, the layer still applies over it. A part the layer sets keeps winning over the
file's until it is reset.

## On the admin pages

The **Pack** tab, beside Definitions, shows the pack as it runs: the version in force and who made it, where each part
comes from (the deploy config, or changed here) with a **Back to the config** button for each changed part, and the
parts set in the deploy config only. Its box holds the runtime parts as YAML: **Validate** checks them and changes
nothing, **Save** makes them a new version; a refused change lists each problem under the box. Below are the versions,
each with what it changed, **Go back to this** and its YAML, and **Export as YAML** for the whole overlay. The tab is
on whichever admin pages hold the Lenspack sections: Superset's own page, or Lenspack's panel (see
[Where the admin pages are](../../features/admin-panel.md#where-the-admin-pages-are)).

## The routes

Admins only, decided by Lenspack's policy as for every setting (any Lenspack admin, or an admin API key). On the
Superset host they are under `/_superset/settings/pack`. Through Superset's address with an admin API key, use
`https://<superset>/lenspack/_admin/settings/pack…`; with the named-password sign-in, `/lenspack/_admin/settings/pack…`.

| route | what it does |
|---|---|
| `GET …/settings/pack` | the pack as it runs: `version`, the runtime parts as `yaml` and `overlay`, the `layer`, each part's `sources` (`config`, `settings`, `config and settings`, `none`), the `configOnly` parts with why, `warnings`, and `notApplied` when saved changes were set aside at start |
| `POST …/settings/pack/validate` | checks `{ yaml }` or `{ fields }` as Save would; changes nothing. Answers `{ ok, problems, changed, warnings }` |
| `PUT …/settings/pack` | saves a change. `{ yaml }`: the runtime parts as the pack should use them (a part left out follows the file). `{ fields }`: only the parts named; `null` hands a part back to the file. Optional `why`, and `version` (the version you read: if the pack changed since, `409`) |
| `GET …/settings/pack/versions` | every version, newest first (`?limit=`, default 50); `current` is the one in force |
| `GET …/settings/pack/versions/<n>` | one version, with its layer and its runtime parts as YAML; `0` is the file alone |
| `GET …/settings/pack/diff?from=<a>&to=<b>` | what differs between two versions, part by part (default: the one in force and the one before it) |
| `POST …/settings/pack/revert` | `{ version, why }`: goes back to a version, as a new version, checked like any change |
| `POST …/settings/pack/reset` | `{ fields: [...], why }` hands those parts back to the file; `{}` hands back everything |
| `GET …/settings/pack/export` | the whole overlay as it runs, as YAML to paste under `overlay:` in `superset.yaml` (`?version=<n>` for an earlier one, `?download=1` to save it as a file). Values the file reads from the environment (`env:NAME`) stay written that way |

The settings API (`GET /_superset/settings`) also says `packLayer: { version, fields }`.

## With an admin API key

```sh
LP=https://superset.example.org/lenspack/_admin
AUTH="Authorization: Bearer $KEY"
JSON='content-type: application/json'
```

See the pack as it runs, and save its runtime parts to a file:

```sh
curl -s -H "$AUTH" $LP/settings/pack
curl -s -H "$AUTH" $LP/settings/pack | jq -r .yaml > pack.yaml
```

Change a label and add an example question, checking first:

```sh
curl -s -X POST -H "$AUTH" -H "$JSON" -d '{"fields": {"labels": {"region": {"en": "Sales region", "fr": "Région de vente"}}}}' $LP/settings/pack/validate
curl -s -X PUT -H "$AUTH" -H "$JSON" -d '{"why": "clearer word", "fields": {"labels": {"region": {"en": "Sales region", "fr": "Région de vente"}}}}' $LP/settings/pack
```

`fields.examples` replaces the whole list, so send the questions to keep with the new one:

```sh
curl -s -X PUT -H "$AUTH" -H "$JSON" -d '{"fields": {"examples": [
  {"question": "Items sold by region", "query": {"kind": "breakdown", "dimension": "region", "measure": "items_sold"}},
  {"question": {"en": "Largest basket by region", "fr": "Plus gros panier par région"},
   "query": {"kind": "breakdown", "dimension": "region", "measure": "largest_basket"}}]}}' $LP/settings/pack
```

Edit the YAML in a file and send it whole:

```sh
jq -Rs '{yaml: ., why: "measures from the stock team"}' pack.yaml | curl -s -X PUT -H "$AUTH" -H "$JSON" -d @- $LP/settings/pack
```

Exclude one more column (send the file's exclusions too; leaving one out is refused):

```sh
curl -s -X PUT -H "$AUTH" -H "$JSON" -d '{"fields": {"exclude": {"columns": ["customer_name", "phone"]}}}' $LP/settings/pack
```

List versions, compare two, go back, reset the labels, and export:

```sh
curl -s -H "$AUTH" $LP/settings/pack/versions
curl -s -H "$AUTH" "$LP/settings/pack/diff?from=1&to=3"
curl -s -X POST -H "$AUTH" -H "$JSON" -d '{"version": 1, "why": "the new labels confused people"}' $LP/settings/pack/revert
curl -s -X POST -H "$AUTH" -H "$JSON" -d '{"fields": ["labels"]}' $LP/settings/pack/reset
curl -s -H "$AUTH" $LP/settings/pack/export > overlay.yaml
```

A refused change answers `400` with `problems`, one line each:

```json
{ "error": "overlay.measures[1] (weight): column \"weight_kg\" is not a column of Superset dataset \"orders\"",
  "problems": ["overlay.measures[1] (weight): column \"weight_kg\" is not a column of Superset dataset \"orders\""] }
```

## Writing the changes back into the file

When the deploy config can be changed again, `GET …/settings/pack/export`, paste it as `overlay:` in `superset.yaml`,
deploy, then reset the changes (`POST …/settings/pack/reset` with `{}`) so the file decides again. Until you reset, the
layer keeps applying over the new file.

---

**Next:** [Computed charts](computed-charts.md).

**Related:** [Settings and switches](settings.md) · [The admin API key](../../access/admin-api.md) ·
[Datasets and dashboards](datasets-and-dashboards.md)
