# What can change without a redeploy

This page lists every option of a Superset deployment and says whether an admin can change it while the server runs.
It is for admins of a deployment whose `superset.yaml` and environment they can't change quickly: the deploy config
sits in another team's repository, or nobody has access to the server. On such a deployment the admin pages and the
[admin API key](../../access/admin-api.md) are the only way in, so every option that is a choice, not a secret, can be
changed there.

## How it works

- A change is made on the admin pages or with `PUT /_superset/settings/<area>` (with a key:
  `https://<your Superset>/lenspack/_admin/settings/<area>`). It is in force from the next request. Nothing restarts.
- **The admin's value wins** over `superset.yaml` and the environment. Sending `null` for a field hands it back to
  the deploy config.
- Every change is in the audit log as `settings <area>`, with who made it: a Superset user name, a password admin's
  `admin:<name>`, or a key's `api:<name>`. A change that is refused is logged too.
- Values are kept in `settings.json` in the state directory, so they survive a restart. Changes to the pack are kept
  as versions in `pack-layer.json` (see [Changing the pack while it runs](pack-runtime.md)).
- `GET /_superset/settings` shows each option with its value now, the deploy config's value, and where the value
  comes from (`settings`, `config`, `env` or `default`). Its `runtime` field is the table below, as data.

## The table

"Changes here" means any value. "Narrows only" means it can be made narrower here, never wider than the deploy config
sets it (see [The boundary narrows only](#the-boundary-narrows-only)). "Deploy config" means it can only be changed in
`superset.yaml` or the environment, then a restart.

| option | without a redeploy? | where |
|---|---|---|
| `budget`: `usdPerDay`, `usdPerUserPerDay` | changes here (0 means no cap) | `settings/budget` |
| which models answer, among those the deployment has keys for | changes here | `settings/models` `{ offered }` |
| which model plays each role (`LENSPACK_LLM_ROLES`: reviewer, fix round, matching saved answers) | changes here, among the models offered | `settings/models` `{ roles }` |
| the default chat model and its effort | changes here, among the models offered | `settings/chat` |
| `historyTurns`: recent turns sent with each question (8) | changes here, 1 to 50 | `settings/history` |
| `audit.retentionDays` | changes here, from 30 days (or the deploy config's own, if shorter) to 3650 | `settings/audit` |
| `explain`: the switch, and whether the SQL shows | changes here | `settings/features`, `settings/explain` `{ sql }` |
| `speech`: `model`, `holdMs`, `maxSeconds`, kept recordings | changes here | `settings/speech` |
| `language` | changes here | `settings/language` |
| `features` (every switch) | changes here | `settings/features` |
| `brand` | changes here | `settings/brand` |
| `cache`, `queue` | changes here | `settings/cache`, `settings/queue` |
| `telemetry` (fields, retention) | changes here | `settings/telemetry` |
| `context` (telemetry labels) | changes here, as a whole | `settings/context` |
| `personal` (limits on people's own dashboards) | changes here | `settings/personal` |
| `editScope` | changes here | `settings/edit-scope` |
| `querySafety` | changes here: tighter at once, looser only with `"confirm": true` | `settings/query-safety` |
| `overlay.panel` (how the chat opens) | changes here | `settings/panel` |
| `admin.surface` (where the admin pages are) | changes here | `settings/admin-surface` |
| `overlay`: description, instructions, labels, hints, measures, examples, `notDimensions`, hierarchies | changes here, as versions | `settings/pack` |
| `overlay.exclude` | more exclusions only, never fewer than the deploy config's | `settings/pack` |
| people let in under `granted`, admins granted under `superset-users` | changes here | `settings/users`, `settings/admins` |
| `datasets` | narrows only: fewer of them. The pack is built again and checked first | `settings/boundary` |
| `scope` (filters every answer carries) | narrows only: more filters. The deploy config's always stay | `settings/boundary` |
| `dashboards`, `dashboardScope` | narrows only: fewer dashboards | `settings/boundary` |
| `hostPolicy`, `accessFallback` | narrows only: each person's own Superset access on, the `rls-only` fallback off | `settings/boundary` |
| `editPolicy` | narrows only: from `signed-in` to `superset` | `settings/boundary` |
| `auth`: admin and user access modes, admin, usage and user roles, owners, seeded people | narrows only: fewer of each | `settings/boundary` |
| `overlay.pack`, `overlay.entities` | deploy config: saved definitions, saved answers and addresses are kept under these names | |
| `overlay.timeZone` | deploy config: it decides what today means for every saved answer, and the daily schedules are set from it at start | |
| `overlay.geo` | deploy config: which columns are people's locations. The `maps` switch turns maps off at runtime | |
| `overlay.mapStyle` | deploy config: the map tile server browsers fetch from, outside the deployment | |
| `speech.baseUrl` | deploy config: where spoken questions are sent, which goes with the speech key | |
| `audit: false` | deploy config: switching the audit log off would hide what an admin, or a key, does | |
| `superset`: `url`, `publicUrl`, `publicPort`, `username`, password | deploy config: how the server reaches Superset and signs in there | |
| `host`, `port`, `publicPath`, `state` | deploy config | |
| model and speech keys, admin passwords, `LENSPACK_ADMIN_API_KEYS` | deploy config: secrets, and the keys that open these settings | |

## Examples

With a key, as in [The admin API key](../../access/admin-api.md#where-to-send-it):

```sh
curl -s -X PUT -H "$AUTH" -H 'content-type: application/json' -d '{"usdPerDay": 20, "usdPerUserPerDay": 2}' $LP/settings/budget
curl -s -X PUT -H "$AUTH" -H 'content-type: application/json' -d '{"offered": ["<a model>", "<another>"]}' $LP/settings/models
curl -s -X PUT -H "$AUTH" -H 'content-type: application/json' -d '{"retentionDays": 180}' $LP/settings/audit
curl -s -X PUT -H "$AUTH" -H 'content-type: application/json' -d '{"usdPerDay": null}' $LP/settings/budget
```

A bad value is refused with `400` and the reason, and nothing changes.

## The boundary narrows only

The deployment's data boundary is what the assistant may read and for whom: the datasets, the filters every answer
carries (`scope`), the dashboards it is on, whether each person's own Superset access applies (`hostPolicy`,
`accessFallback`), who may change dashboards through it (`editPolicy`), and who administers and uses it (`auth`).

**On a running server, the boundary can be made narrower, never wider than the deploy config.** You can keep fewer
datasets, add a filter, keep fewer dashboards, turn each person's own Superset access on, or keep fewer roles, owners
or access modes. To read a dataset the deploy config doesn't list, drop one of its filters, or let in a role it leaves
out, change the deploy config and restart.

The reason: a deployment's Superset can hold data that belongs to other teams or other countries. Whoever holds an
admin key could otherwise point the assistant at it. With this rule, a leaked key can make the assistant reach less,
never more. This is a deliberate choice, and the project owner can change it.

The fields, all on `PUT /_superset/settings/boundary` (send only the ones you narrow; `null` hands one back to the
deploy config):

| field | what you send | narrower means |
|---|---|---|
| `datasets` | a list of the deploy config's datasets (by id or table name, as it writes them) | fewer datasets; at least one |
| `scope` | filter clauses, as in `superset.yaml` | more filters, added to the deploy config's |
| `dashboards` | Superset dashboard ids | the assistant on these only. Under `dashboardScope: listed`, fewer of the listed ones |
| `hostPolicy` | `"superset"` | each person's own Superset access applies |
| `accessFallback` | `"none"` | no `rls-only` fallback |
| `editPolicy` | `"superset"` | only people Superset lets edit may change dashboards through the chat |
| `adminAccess`, `userAccess` | access modes | fewer of the deploy config's modes. When it lets everyone signed in use the assistant, any modes |
| `adminRoles`, `usageRoles`, `userRoles` | Superset role names | fewer of the deploy config's roles. When it lets everyone signed in use the assistant, any user roles |
| `adminUsers`, `seedUsers` | Superset user names or `id:<n>` | fewer owners, fewer seeded people |

```sh
curl -s -X PUT -H "$AUTH" -H 'content-type: application/json' -d '{"datasets": [11], "scope": [{"dimension": "campaign", "op": "eq", "value": "2026-spring"}]}' $LP/settings/boundary
curl -s -X PUT -H "$AUTH" -H 'content-type: application/json' -d '{"datasets": null, "scope": null}' $LP/settings/boundary
```

- A value that would widen the boundary is refused with `400` and the reason, and nothing changes. So is one that
  isn't a field's shape.
- A change to the datasets or the scope has the pack built again over them and checked like any change to the pack. If
  the new pack has a problem the old one didn't (a filter on a column it doesn't have, an example question on a dataset
  no longer kept), the change is refused with the problems, and nothing changes. If it passes, it is in force from
  the next question, and saved answers made under the old scope are no longer reused.
- The other fields apply from the next request.
- An admin API key works under any access mode, so narrowing the access never locks out the key that made the change.
- Each change is audited as `settings boundary`, with who made it. `GET /_superset/settings` shows `boundary`: the
  deploy config's, the narrowing and the boundary in force.
- The narrowing is kept in `settings.json` and applied again at start. If the deploy config changed so that part of it
  no longer narrows (a dataset it no longer lists), that part is set aside, said in the log and in `notApplied`.

## The audit log's floor

The audit log can be kept longer or shorter, but never less than 30 days (or the deploy config's own retention, when
that is shorter). Whoever holds an admin key could otherwise shorten it to hide what they did. Switching it off is for
the deploy config only.

---

**Next:** [Settings and switches](settings.md).

**Related:** [The admin API key](../../access/admin-api.md) · [Changing the pack while it runs](pack-runtime.md) ·
[Configuration reference](../../reference/config.md)
