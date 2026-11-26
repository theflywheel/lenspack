# Troubleshooting

This page lists common problems, what causes them and what to check. It is for operators and admins. Each answer
links to the page that explains the behaviour.

## Starting up

| you see | cause | do this |
|---|---|---|
| the server stops with a list of pack problems | the pack has a mistake (an unknown key, a bad join, a fragment for the wrong source) | fix each line; `lenspack check --config lenspack.yaml` repeats the list. See [Pack file reference](../reference/pack.md) |
| "auth.proxy secret must be at least 16 characters" | the proxy sign-in's shared secret is too short | use a longer secret. See [Sign-in](../access/sign-in.md#proxy) |
| a state folder or password file is refused | the folder is a link or writable by everyone, or a file belongs to another user | fix the permissions; a group-shared folder (`fsGroup`) is fine |
| "budget set, but … has no price" | a provider has no `pricing`, so its spend cannot count toward the budget | add `pricing` to the provider. See [Costs](costs.md#what-a-call-costs) |
| warning lines about datasets, inside Superset | a metric or column Lenspack left out, or a column renamed `<name>_value` | usually nothing; see [Datasets and dashboards](../hosts/superset/datasets-and-dashboards.md#the-pack-from-datasets) |
| a warning at every start about `hostPolicy: off` | everyone reads every listed dataset in full | turn it back to `superset` once your roles are checked. See [Access inside Superset](../access/superset.md#turning-it-off-hostpolicy-off) |
| Superset's own app mutator stops working after adding the plugin | the plugin's import sets `FLASK_APP_MUTATOR` | call `lenspack_app_mutator(app)` from yours. See [Install](../hosts/superset/install.md#1-add-the-plugin-to-superset) |

## Signing in

| you see | cause | do this |
|---|---|---|
| lost the built-in admin's password | it was made at first start and written once | set `LENSPACK_ADMIN_PASSWORD`, or delete `admin-password.hash` to make a new one |
| signed out when a request reaches another copy | replicas do not share the session key | share the state directory, or set the same password and `sessionSecret` on every copy |
| sign-in tries wait longer and longer | five failures from one address or browser start a back-off (up to 15 minutes) | wait, or sign in from a browser that has signed in before. See [Sign-in](../access/sign-in.md#password) |
| 401 on every Lenspack request inside Superset | the signed identity is missing, wrong, or older than five minutes (often a clock difference between Superset and Lenspack) | check both clocks, and that the server fetched the key at start. See [Who is asking](../hosts/superset/identity.md) |
| 403 on one dashboard inside Superset | the request names a board Superset did not sign for, or the user may not open the dashboard | open the dashboard from Superset; check the user's rights there |

## Asking questions

| you see | cause | do this |
|---|---|---|
| "not available to you: your Superset access doesn't include it" | the person's Superset access keeps that dataset from them | give access in Superset; it reaches Lenspack within a minute. See [Access inside Superset](../access/superset.md) |
| a person sees nothing at all inside Superset | Lenspack could not ask Superset about their access, so it showed nothing | check the plugin is loaded and Superset is reachable from the server |
| a dataset is missing for one person although Superset shows it | a row-level security rule Lenspack cannot translate (`LIKE`, `!=`, a function) keeps the whole dataset from them; the log says which | write the rule with `=`, `IN`, `AND` or one-column `OR`. See [Access inside Superset](../access/superset.md#what-each-user-sees) |
| "today's budget is used up" (429) | the server's or the person's daily cap is reached | wait for 00:00 UTC, or raise `budget:`. See [Costs](costs.md#a-budget) |
| "Lenspack is too busy right now" | the queue is full, or a turn waited too long | raise `maxConcurrent` or `maxWaiting`. See [Busy hours](../features/busy-hours.md) |
| chats stall when many people use them, inside Superset | each streaming chat holds a Superset thread | raise Superset's `SERVER_THREADS_AMOUNT`. See [Install](../hosts/superset/install.md) |
| an answer looks stale | it came from a saved answer | press **Ask fresh**; see [Saved answers](../features/saved-answers.md) |
| a percentile is refused | the database has no percentile function (MySQL, SQLite) | use another measure, or a database that has one. See [SQL databases](../sources/sql.md#capability-matrix) |
| a series is refused in a pack with a time zone, inside Superset | the time column has a time of day, and Superset buckets without a zone | use a date column, or keep the pack in UTC. See [Datasets and dashboards](../hosts/superset/datasets-and-dashboards.md#numbers-from-superset) |
| a heatmap over weeks or months is refused | the source cannot keep a time axis in order (Superset over ClickHouse) | use a breakdown over a date label column |
| ClickHouse error 184 through Superset 6.1 | a saved metric named like the column it adds up | load the plugin (it fixes this), or rename the metric. See [Versions](../hosts/superset/versions.md#clickhouse-column-names-on-superset-61) |

## Changing dashboards

| you see | cause | do this |
|---|---|---|
| "you can view this dashboard but not edit it in Superset" | the person may not edit that dashboard in Superset | give them edit rights in Superset, or they can [make their own copy](../features/personal-dashboards.md) |
| edits are refused for everyone, admins included | the `boardEdits` switch is off | turn it on. See [Feature switches](switches.md) |
| undo history is gone after a restart, inside Superset | Lenspack's version history is kept in memory today | Superset's dashboard is unaffected. See [What survives a restart](state.md#what-survives-a-restart) |
| a chart is kept as "Superset's" and the assistant will not rewrite it | Lenspack cannot express it exactly (custom SQL, ad hoc metrics) | change it in Superset; the assistant can still move, resize or remove it |
| a computed chart is refused when saved to Superset | Superset's own arithmetic would give a different number | take the nearest chart offered. See [Computed charts](../hosts/superset/computed-charts.md) |

## Settings and voice

| you see | cause | do this |
|---|---|---|
| "Lenspack can't save settings: …" (503) | the state directory cannot be written | free disk space or fix the mount; nothing was changed |
| no mic in the chat | no transcription key, the `voice` switch is off, or the page is not https | set `LENSPACK_STT_API_KEY` or `OPENROUTER_API_KEY`; serve over https. See [Voice](../features/voice.md) |
| the mic returns nothing ("wrong script" or "unsure language") | the transcript came back in another language's script | pick the language in the chat's menu |
| no admin panel in the standalone server | `state:` is not set, or the person has no `admin` role | set `state:`; see [The admin panel](../features/admin-panel.md) |

---

**Next:** [Reference](../reference/README.md).

**Related:** [Operating Lenspack](README.md) · [Refusal codes](../reference/errors.md)
