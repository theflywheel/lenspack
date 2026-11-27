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

"Changes here" means any value. "Deploy config" means it can only be changed in `superset.yaml` or the environment,
then a restart.

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
| `datasets`, `scope`, `dashboards`, `dashboardScope` | deploy config | |
| `hostPolicy`, `accessFallback`, `editPolicy` | deploy config | |
| `auth`: admin and user access modes, roles, owners, seeded people | deploy config | |
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

## The audit log's floor

The audit log can be kept longer or shorter, but never less than 30 days (or the deploy config's own retention, when
that is shorter). Whoever holds an admin key could otherwise shorten it to hide what they did. Switching it off is for
the deploy config only.

---

**Next:** [Settings and switches](settings.md).

**Related:** [The admin API key](../../access/admin-api.md) · [Changing the pack while it runs](pack-runtime.md) ·
[Configuration reference](../../reference/config.md)
