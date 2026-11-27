# Configuration reference

This page lists every key of `lenspack.yaml` and `superset.yaml`, and every environment variable Lenspack reads, with
defaults. It is for operators looking something up. How configuration works (what wins over what, secrets) is in
[Configuration](../operating/configuration.md).

A string `env:NAME` anywhere in either file reads that environment variable. Relative paths are read from the config
file's folder.

## `lenspack.yaml`

The standalone server's config. It is read at start; with `state:`, the admin panel changes the switches, the
assistant's name and the review's settings while the server runs, and everything else needs a restart. (In Superset
mode most options change while the server runs: see the "runtime?" column [below](#supersetyaml).) The blocks, in brief:

| key | what it is | more |
|---|---|---|
| `sources` | the databases and indexes, by name | [SQL databases](../sources/sql.md), [Elasticsearch](../sources/elasticsearch.md) |
| `packs` | each pack: its file, its source, its boards, its access rules | [Packs](#packs) below |
| `store` | where boards live: `memory` (the default), `duckdb` with a `path`, or `postgres` with a `url` | [Stores](../architecture/stores.md) |
| `ui` | the board app's folder, or `{ dir, mode, title, home, intro }` | [The standalone server](../hosts/serve.md#the-board-app) |
| `port`, `host` | where it listens: port 8787; host `0.0.0.0` with a sign-in, `127.0.0.1` with `auth: { kind: none }` | [CLI](cli.md#lenspack-serve) |
| <a id="auth"></a>`auth` | the sign-in: `password` (the default), `oidc`, `proxy`, `tokens` or `none` | [Sign-in](../access/sign-in.md) |
| `state` | a writable folder for switches, definitions, open questions, the review and the audit log; turns on the admin panel | [What Lenspack keeps on disk](../operating/state.md) |
| `audit` | an audit log file (JSON lines) | [Privacy](../operating/privacy.md) |
| `usage` | a usage file, one line per model call | [Costs](../operating/costs.md#where-calls-go) |
| `budget` | `{ usdPerDay, usdPerUserPerDay }` | [Costs](../operating/costs.md#a-budget) |
| `historyTurns` | how many recent turns the chat keeps (8) | [Answering](../features/answering.md#follow-ups-and-new-chats) |
| `cache` | saved answers: `{ file, enabled, ttlHours, router, maxEntries, freshMinutes, prewarm }` | [Saved answers](../features/saved-answers.md#the-switches) |
| `queue` | `{ maxConcurrent, maxWaiting, maxWaitSeconds }` | [Busy hours](../features/busy-hours.md) |
| `explain` | `false`, or `{ sql: false }` | [How this was worked out](../features/explain.md#the-switches) |
| `proposals` | the folder for each pack's `<name>.proposals.json` (default: the config's folder) | [Write a pack](../extending/write-a-pack.md#7-give-it-to-a-model) |
| `features` | starting values for switches | [Feature switches](../operating/switches.md) |
| `brand` | the assistant's name and button label: `{ name, buttonLabel, i18n, icon, poweredBy }` | [Naming the assistant](../features/naming.md) |
| `telemetry` | usage records: `{ dir, retentionDays, fields }` (`groups` and `items` are the older switches, still read; `questionText` is the older name of `fields.question-text`) | [Telemetry](../features/telemetry.md) |
| `context` | your own labels for a board, a dataset or `role:<name>` (the fields are named `campaign`, `campaignType` and `country`), for telemetry | [Telemetry](../features/telemetry.md#tagging-records-with-your-own-context) |

### Packs

| key | what it is |
|---|---|
| `pack` | the pack file, YAML or JSON |
| `source` | the name of a source under `sources` |
| `name` | the pack's name in the API (default: the pack's own `pack:`) |
| `boards` | a folder of board files the pack ships |
| `tenant` | pins the pack to one tenant |
| `now` | a fixed "now" for relative windows (for demos and tests) |
| `access` | the pack's access rules: see [Pack access rules](../access/pack-rules.md) |

### Every key

Generated from the schema by `pnpm docs:keys`; the text above is written by hand.

<!-- keys:lenspack.yaml -->

| key | type | required | default |
|---|---|---|---|
| `sources` | map of object | yes |  |
| `sources.<name> (kind: elasticsearch).kind` | `"elasticsearch"` | yes |  |
| `sources.<name> (kind: elasticsearch).url` | string | yes |  |
| `sources.<name> (kind: elasticsearch).apiKey` | string |  |  |
| `sources.<name> (kind: elasticsearch).username` | string |  |  |
| `sources.<name> (kind: elasticsearch).password` | string |  |  |
| `sources.<name> (kind: elasticsearch).timeoutMs` | number |  |  |
| `sources.<name> (kind: opensearch).kind` | `"opensearch"` | yes |  |
| `sources.<name> (kind: opensearch).url` | string | yes |  |
| `sources.<name> (kind: opensearch).username` | string |  |  |
| `sources.<name> (kind: opensearch).password` | string |  |  |
| `sources.<name> (kind: opensearch).timeoutMs` | number |  |  |
| `sources.<name> (form 3).kind` | string |  |  |
| `sources.<name> (form 3).url` | string | yes |  |
| `sources.<name> (form 3).timeoutMs` | number |  |  |
| `sources.<name> (form 3).maxRows` | number |  |  |
| `sources.<name> (form 3).cacheTtlMs` | number |  |  |
| `sources.<name> (form 3).optional` | boolean |  |  |
| `sources.<name> (kind: duckdb\|sqlite).kind` | `duckdb`, `sqlite` | yes |  |
| `sources.<name> (kind: duckdb\|sqlite).path` | string | yes |  |
| `sources.<name> (kind: duckdb\|sqlite).timeoutMs` | number |  |  |
| `sources.<name> (kind: duckdb\|sqlite).maxRows` | number |  |  |
| `sources.<name> (kind: duckdb\|sqlite).cacheTtlMs` | number |  |  |
| `sources.<name> (kind: duckdb\|sqlite).optional` | boolean |  |  |
| `packs` | list of object | yes |  |
| `packs[].pack` | string | yes |  |
| `packs[].source` | string | yes |  |
| `packs[].name` | string |  |  |
| `packs[].boards` | string |  |  |
| `packs[].tenant` | string |  |  |
| `packs[].now` | string |  |  |
| `packs[].access` | list of object |  |  |
| `packs[].access[].roles` | list of string | yes |  |
| `packs[].access[].hide` | list of string |  |  |
| `packs[].access[].only` | list of string |  |  |
| `packs[].access[].scope` | list of object |  |  |
| `packs[].access[].scope[].dimension` | string | yes |  |
| `packs[].access[].scope[].op` | `eq`, `neq`, `in`, `not_in`, `gte`, `lte`, `between`, `contains`, `subtree`, `segment` | yes |  |
| `packs[].access[].scope[].value` | string or number or boolean or list of string or number or boolean | yes |  |
| `store` | object |  | `{"kind":"memory"}` |
| `store (kind: memory).kind` | `"memory"` | yes |  |
| `store (kind: duckdb).kind` | `"duckdb"` | yes |  |
| `store (kind: duckdb).path` | string | yes |  |
| `store (kind: postgres).kind` | `"postgres"` | yes |  |
| `store (kind: postgres).url` | string | yes |  |
| `ui` | string or object |  |  |
| `ui (form 2).dir` | string |  |  |
| `ui (form 2).mode` | `demo`, `app` |  |  |
| `ui (form 2).title` | string |  |  |
| `ui (form 2).home` | string |  |  |
| `ui (form 2).intro` | string |  |  |
| `port` | number |  |  |
| `auth` | object |  |  |
| `auth (kind: none).kind` | `"none"` | yes |  |
| `auth (kind: password).kind` | `"password"` | yes |  |
| `auth (kind: password).password` | string |  |  |
| `auth (kind: password).passwordHash` | string |  |  |
| `auth (kind: password).dir` | string |  |  |
| `auth (kind: password).baseUrl` | string |  |  |
| `auth (kind: password).sessionSecret` | string |  |  |
| `auth (kind: password).sessionHours` | number |  | `8` |
| `auth (kind: password).editors` | list of string |  | `[]` |
| `auth (kind: password).maintainers` | list of string |  | `[]` |
| `auth (kind: password).usage` | list of string |  |  |
| `auth (kind: password).admins` | list of string |  |  |
| `auth (kind: password).users` | list of string |  |  |
| `auth (kind: tokens).kind` | `"tokens"` | yes |  |
| `auth (kind: tokens).users` | list of object | yes |  |
| `auth (kind: tokens).users[].user` | string | yes |  |
| `auth (kind: tokens).users[].token` | string | yes |  |
| `auth (kind: tokens).users[].edit` | boolean |  | `false` |
| `auth (kind: tokens).users[].maintain` | boolean |  | `false` |
| `auth (kind: tokens).users[].tenant` | string |  |  |
| `auth (kind: tokens).users[].scope` | list of object |  |  |
| `auth (kind: tokens).users[].scope[].dimension` | string | yes |  |
| `auth (kind: tokens).users[].scope[].op` | `eq`, `neq`, `in`, `not_in`, `gte`, `lte`, `between`, `contains`, `subtree`, `segment` | yes |  |
| `auth (kind: tokens).users[].scope[].value` | string or number or boolean or list of string or number or boolean | yes |  |
| `auth (kind: tokens).users[].packs` | list of string |  |  |
| `auth (kind: tokens).users[].roles` | list of string |  |  |
| `auth (kind: tokens).users[].usage` | boolean |  |  |
| `auth (kind: tokens).editors` | list of string |  | `[]` |
| `auth (kind: tokens).maintainers` | list of string |  | `[]` |
| `auth (kind: tokens).usage` | list of string |  |  |
| `auth (kind: tokens).admins` | list of string |  |  |
| `auth (kind: proxy).kind` | `"proxy"` | yes |  |
| `auth (kind: proxy).secret` | string | yes |  |
| `auth (kind: proxy).secretHeader` | string |  | `"x-lenspack-proxy-secret"` |
| `auth (kind: proxy).userHeader` | string |  | `"x-forwarded-user"` |
| `auth (kind: proxy).tenantHeader` | string |  |  |
| `auth (kind: proxy).rolesHeader` | string |  |  |
| `auth (kind: proxy).editors` | list of string |  | `[]` |
| `auth (kind: proxy).maintainers` | list of string |  | `[]` |
| `auth (kind: proxy).usage` | list of string |  |  |
| `auth (kind: proxy).admins` | list of string |  |  |
| `auth (kind: proxy).users` | list of string |  |  |
| `auth (kind: proxy).signOutUrl` | string |  |  |
| `auth (kind: oidc).kind` | `"oidc"` | yes |  |
| `auth (kind: oidc).issuer` | string | yes |  |
| `auth (kind: oidc).clientId` | string | yes |  |
| `auth (kind: oidc).clientSecret` | string |  |  |
| `auth (kind: oidc).baseUrl` | string | yes |  |
| `auth (kind: oidc).sessionSecret` | string | yes |  |
| `auth (kind: oidc).sessionHours` | number |  | `8` |
| `auth (kind: oidc).scopes` | list of string |  | `["openid","profile","email"]` |
| `auth (kind: oidc).userClaim` | string |  | `"preferred_username"` |
| `auth (kind: oidc).rolesClaims` | list of string |  | `["groups"]` |
| `auth (kind: oidc).tenantClaim` | string |  |  |
| `auth (kind: oidc).editors` | list of string |  | `[]` |
| `auth (kind: oidc).maintainers` | list of string |  | `[]` |
| `auth (kind: oidc).usage` | list of string |  |  |
| `auth (kind: oidc).admins` | list of string |  |  |
| `auth (kind: oidc).users` | list of string |  |  |
| `host` | string |  |  |
| `audit` | string |  |  |
| `telemetry` | object |  |  |
| `telemetry.dir` | string | yes |  |
| `telemetry.retentionDays` | number |  | `90` |
| `telemetry.fields` | map of boolean |  |  |
| `telemetry.groups` | map of boolean |  |  |
| `telemetry.items` | map of boolean |  |  |
| `telemetry.questionText` | boolean |  |  |
| `context` | map of object |  |  |
| `context.<name>.campaign` | string |  |  |
| `context.<name>.campaignType` | string |  |  |
| `context.<name>.country` | string |  |  |
| `usage` | string |  |  |
| `budget` | object |  |  |
| `budget.usdPerDay` | number |  |  |
| `budget.usdPerUserPerDay` | number |  |  |
| `historyTurns` | number |  |  |
| `cache` | boolean or object |  |  |
| `cache (form 2).file` | string |  |  |
| `cache (form 2).enabled` | boolean |  |  |
| `cache (form 2).ttlHours` | number |  |  |
| `cache (form 2).router` | `on`, `off` |  |  |
| `cache (form 2).maxEntries` | number |  |  |
| `cache (form 2).freshMinutes` | number |  |  |
| `cache (form 2).prewarm` | map of any |  |  |
| `queue` | object |  |  |
| `queue.maxConcurrent` | number |  |  |
| `queue.maxWaiting` | number |  |  |
| `queue.maxWaitSeconds` | number |  |  |
| `explain` | boolean or object |  |  |
| `explain (form 2).sql` | boolean |  |  |
| `proposals` | string |  |  |
| `state` | string |  |  |
| `features` | map of boolean |  |  |
| `brand` | object |  |  |
| `brand.name` | string |  |  |
| `brand.buttonLabel` | string |  |  |
| `brand.i18n` | object |  |  |
| `brand.i18n.en` | object |  |  |
| `brand.i18n.en.name` | string |  |  |
| `brand.i18n.en.buttonLabel` | string |  |  |
| `brand.i18n.fr` | object |  |  |
| `brand.i18n.fr.name` | string |  |  |
| `brand.i18n.fr.buttonLabel` | string |  |  |
| `brand.i18n.hi` | object |  |  |
| `brand.i18n.hi.name` | string |  |  |
| `brand.i18n.hi.buttonLabel` | string |  |  |
| `brand.i18n.pt` | object |  |  |
| `brand.i18n.pt.name` | string |  |  |
| `brand.i18n.pt.buttonLabel` | string |  |  |
| `brand.icon` | string |  |  |
| `brand.poweredBy` | boolean |  |  |

<!-- /keys:lenspack.yaml -->

## `superset.yaml`

The Superset host's config. Most keys can be left out for their environment variable, then the default. The
"runtime?" column says whether an admin can change the key while the server runs, on the settings routes or with an
admin API key; see [What can change without a redeploy](../hosts/superset/runtime.md). "Narrows only" keys are the
deployment's data boundary: a change there may make it narrower, never wider than this file sets it.

| key | default | what it is | runtime? |
|---|---|---|---|
| `datasets` | (required) | the Superset datasets Lenspack may use, by id or by table name (`schema.table` or `table`) | narrows only: `settings/boundary` (fewer) |
| `dashboards` | `LENSPACK_DASHBOARDS` (comma-separated) wins | dashboard ids to read at start. Under `dashboardScope: listed`, also the only dashboards the assistant is on | narrows only: `settings/boundary` (fewer) |
| `dashboardScope` | `any` (`LENSPACK_DASHBOARD_SCOPE` wins) | which dashboards the assistant is on: `any` (every dashboard the person may open in Superset) or `listed` (only those in `dashboards`, and people's own copies of them). See [Which dashboards the assistant is on](../hosts/superset/datasets-and-dashboards.md#which-dashboards-the-assistant-is-on) | narrows only: `settings/boundary` (`any` to listed dashboards) |
| `superset.url` | `LENSPACK_SUPERSET_URL` (required one way or the other) | where this server reaches Superset | no |
| `superset.publicUrl` | | where browsers reach Superset, when that differs from `url` | no |
| `superset.publicPort` | | Superset's port as browsers see it, when `publicUrl` is not set | no |
| `superset.username` | `lenspack` | Lenspack's own Superset account | no |
| `superset.passwordEnv`, `superset.password` | `LENSPACK_SUPERSET_PASSWORD` | an account you manage instead: its password's variable, or the password | no |
| `editPolicy` | `superset` (`LENSPACK_EDIT_POLICY` wins) | who may change dashboards through the chat: `superset` or `signed-in` | narrows only: `settings/boundary` (`signed-in` to `superset`) |
| `hostPolicy` | `superset` (`LENSPACK_HOST_POLICY` wins) | whose access narrows what each user sees: `superset` or `off` | narrows only: `settings/boundary` (`off` to `superset`) |
| `accessFallback` | `none` (`LENSPACK_ACCESS_FALLBACK` wins) | what happens when Superset answers 404 for the plugin's access route: `none` refuses that request; `rls-only`, only for an old plugin without the route, applies Superset's row-level security rules alone and treats every dataset as readable. See [Access inside Superset](../access/superset.md#when-access-cant-be-checked) | narrows only: `settings/boundary` (`rls-only` to `none`) |
| `auth.admins` | `["Admin"]` (`LENSPACK_ADMIN_ROLES` wins) | Superset roles whose members are Lenspack admins. See [Who is asking](../hosts/superset/identity.md#who-may-administer) | narrows only: `settings/boundary` (fewer roles) |
| `auth.usage` | the same roles as `auth.admins` (`LENSPACK_USAGE_ROLES` wins) | Superset roles that also see user names on the usage pages | narrows only: `settings/boundary` (fewer roles) |
| `auth.users` | everyone signed in (`LENSPACK_USER_ROLES` wins) | Superset roles that may use the assistant at all; admins always may. See [Who is asking](../hosts/superset/identity.md#who-may-use-the-assistant) | narrows only: `settings/boundary` (fewer roles; people are let in on the Access page) |
| `auth.adminAccess` | `superset-role` (`LENSPACK_ADMIN_ACCESS` wins) | who is an admin: `superset-role`, `superset-users` or `password`, or `password` with one of the others (`superset-role,password`). See [Who can use and administer the assistant](../access/admin-access.md) | narrows only: `settings/boundary` (fewer modes) |
| `admin.surface` | `split` (`LENSPACK_ADMIN_SURFACE` wins) | where the admin pages are: `split`, `superset` or `separate`. See [Where the admin pages are](../features/admin-panel.md#where-the-admin-pages-are) | yes: `settings/admin-surface` |
| `auth.adminUsers` | none (`LENSPACK_ADMIN_USERS` wins) | the owners under `superset-users`: Superset user names or `id:<n>` | narrows only: `settings/boundary` (fewer owners; owners grant admins on the Access page) |
| `auth.userAccess` | `superset-role` (`LENSPACK_USER_ACCESS` wins) | who may use the assistant: `superset-role`, `granted`, `everyone`, or a combination like `superset-role,granted` | narrows only: `settings/boundary` (fewer modes) |
| `auth.seedUsers` | none (`LENSPACK_USERS` wins) | people always let in under `granted`: Superset user names or `id:<n>` | narrows only: `settings/boundary` (fewer) |
| `editScope` | `superset` (`LENSPACK_EDIT_SCOPE` wins) | where the chat may edit: `superset` (any dashboard Superset lets the person edit) or `own` (their own dashboards only); or `{ scope, adminsExempt }` (admins exempt by default). See [Personal dashboards](../features/personal-dashboards.md#where-the-chat-may-edit-editscope) | yes: `settings/edit-scope` |
| `personal` | `maxDashboardsPerUser: 20`, `maxSavedConfigsPerUser: 50` | limits for [personal dashboards and saved layouts](../features/personal-dashboards.md) | yes: `settings/personal` |
| `audit` | on, 90 days | `false`, or `{ retentionDays }` (`LENSPACK_AUDIT_RETENTION_DAYS`) | `retentionDays`: yes, `settings/audit` (30 days at least); `false`: no |
| `scope` | | the pack's own row scope: filters every answer carries, for everyone (one campaign: `[{ dimension: campaign, op: eq, value: 2026-spring }]`). See [Row scope and tenancy](../access/scope-and-tenancy.md#pinning-every-answer-in-superset) | narrows only: `settings/boundary` (more clauses) |
| `overlay` | | what Superset has no field for: `pack`, `description`, `instructions`, `timeZone`, `entities`, `hints`, `labels`, `hierarchies`, `examples`, `geo`, `mapStyle`, `panel` (`float` or `dock`). See [Datasets and dashboards](../hosts/superset/datasets-and-dashboards.md#the-overlay). The base for changes admins make while the server runs: `description`, `instructions`, `labels`, `hints`, `measures`, `examples`, `notDimensions`, `hierarchies` and more exclusions can change then; the rest stays in this file. See [Changing the pack while it runs](../hosts/superset/pack-runtime.md) | most parts: yes, `settings/pack`; `panel`: yes, `settings/panel`; `pack`, `entities`, `timeZone`, `geo`, `mapStyle`: no |
| `overlay.exclude` | | `{ columns, datasets }`: columns (by name, any case, on every dataset) and whole datasets the pack never uses. See [Columns the pack never uses](../hosts/superset/datasets-and-dashboards.md#columns-the-pack-never-uses). A change while the server runs may add exclusions, never remove one of these | more only: `settings/pack` |
| `overlay.notDimensions` | | columns Superset lets you group by that are not dimensions (amounts, counts) | yes: `settings/pack` |
| `overlay.measures` | | base measures from columns: `{ dataset, name, agg, column, where, label, hint, format }`, `agg` one of `sum`, `count`, `count_distinct`, `min`, `max`. See [Measures from columns](../hosts/superset/datasets-and-dashboards.md#measures-from-columns) | yes: `settings/pack` |
| `overlay.labels`, `overlay.hints` | | by key; text, or text per language (`{ en: …, fr: … }`) | yes: `settings/pack` |
| `querySafety` | on: 20,000 rows, 20,000 series points and 100 queries a turn; 8 at once, 30 s each | limits on the queries sent to Superset: `maxRows`, `maxGroups`, `maxSeriesPoints`, `maxWindowDays`, `requireTime`, `defaultWindowDays`, `maxQueriesPerTurn`, `timeoutSeconds`, `maxConcurrent`; `heavy` (what a dataset marked heavy starts from) and `datasets` (by table name, id or entity key: `heavy`, `highCardinality`, `cardinality` and any of the limits). An admin can tighten them on a running server. See [Query safety](../operating/query-safety.md) | yes: `settings/query-safety` (looser needs confirm) |
| `host` | `LENSPACK_HOST`, else `127.0.0.1` | where it listens | no |
| `port` | `LENSPACK_PORT`, else `8795` | | no |
| `publicPath` | `LENSPACK_PUBLIC_PATH`, else `""` | the path Superset forwards (`/lenspack`). A request through Superset's route says its own path, which wins, so Superset under a path (`/superset/lenspack`) needs no change. See [Superset under a path](../hosts/superset/install.md#superset-under-a-path) | no |
| `state` | `superset-boards.json` in `LENSPACK_STATE_DIR`, else `state/` | the board bookkeeping file; its folder holds the rest of the state | no |
| `budget` | `LENSPACK_BUDGET_USD_PER_DAY`, `LENSPACK_BUDGET_USD_PER_USER_PER_DAY` | daily caps | yes: `settings/budget` |
| `historyTurns` | 8 | how many recent turns the chat sends with each question | yes: `settings/history` |
| `speech` | `model: mistralai/voxtral-mini-transcribe-3-0`, `maxSeconds: 60`, `holdMs: 2000` | voice: `{ model, baseUrl, maxSeconds, holdMs }`. See [Voice](../features/voice.md) | yes: `settings/speech`, but not `baseUrl` |
| `language` | `default: auto`, `titles: board`, `board: en` | see [Languages](../features/languages.md) | yes: `settings/language` |
| `telemetry`, `context` | | as in `lenspack.yaml`; the telemetry sits in the state directory. See [Telemetry](../features/telemetry.md) | yes: `settings/telemetry`, `settings/context` |
| `features`, `cache`, `queue`, `explain`, `brand` | | as in `lenspack.yaml`. For `brand`, see [Naming the assistant](../features/naming.md) | yes: `settings/<name>`; `explain.sql` at `settings/explain` |

## Environment variables

In the "wins" column: **over the file** means the variable beats the config file's key; **fallback** means it is
read only when the file leaves the key out; **only source** means there is no key in the file.

| variable | read by | what it does | wins | runtime? |
|---|---|---|---|---|
| `LENSPACK_AUTH` | serve | overrides `auth.kind` (`none` for a quick local look) | over the file | no |
| `LENSPACK_ADMIN_PASSWORD` | serve | the built-in admin's password, at least 12 characters | fallback (when `auth` names no password or hash) | no |
| `LENSPACK_ADMIN_PASSWORD_HASH` | serve | a scrypt hash of it (`lenspack hash-password`) | fallback (as above) | no |
| `LENSPACK_STATE_DIR` | both | the state folder (`/data` in the image); the password sign-in's default `dir` | fallback (for `state:`, `auth.dir`) | no |
| `LENSPACK_UI` | serve | the board app's folder | between: `--ui`, then it, then `ui:` | no |
| `LENSPACK_HOST`, `LENSPACK_PORT` | superset | where it listens (the image sets `LENSPACK_HOST=0.0.0.0`) | fallback (for `host`, `port`) | no |
| `PORT` | serve | the port, when neither `--port` nor `port:` gives one | fallback (after `--port`, `port:`) | no |
| `LENSPACK_FEATURES` | both | switches: `voice=off,maps=on`, `-voice,+maps`, or a JSON object | over the file; an admin's setting wins over it | yes: `settings/features` |
| `LENSPACK_BUDGET_USD_PER_DAY`, `LENSPACK_BUDGET_USD_PER_USER_PER_DAY` | both | daily caps when the config sets none | fallback (only when the file sets no `budget`) | yes: `settings/budget` |
| `LENSPACK_LLM_PROVIDERS` | both | model providers, as a JSON array. See [Chat models](../operating/models.md) | only source | keys: no; which answer: `settings/models` |
| `LENSPACK_LLM_ROLES` | both | which provider plays `reviewer`, `escalate` and `router` | only source | yes: `settings/models` `roles` |
| `LENSPACK_LLM_BASE_URL`, `LENSPACK_LLM_API_KEY`, `LENSPACK_LLM_MODEL`, `LENSPACK_LLM_EXTRA_BODY`, `LENSPACK_LLM_PRICING` | both | a single OpenAI-compatible provider | only source | keys: no; which answer: `settings/models` |
| `LENSPACK_LLM_KEY_SOURCE` | both | what the settings page says the key came from | only source | no |
| `ANTHROPIC_API_KEY` | both | the `anthropic` adapter's key when a provider names none | fallback (when a provider names no key) | no |
| `LENSPACK_STT_API_KEY`, else `OPENROUTER_API_KEY` | both | speech to text | only source | no |
| `LENSPACK_SUPERSET_URL` | superset | `superset.url` | fallback | no |
| `LENSPACK_SUPERSET_PASSWORD` | superset | the password of an account you manage | fallback | no |
| `SUPERSET_ADMIN_USERNAME`, `SUPERSET_ADMIN_PASSWORD` | superset | the one-time admin sign-in that makes Lenspack's own account (`admin` by default) | only source | no |
| `LENSPACK_PUBLIC_PATH` | superset | `publicPath` | fallback | no |
| `LENSPACK_EDIT_POLICY` | superset | `editPolicy` | over the file | narrows only: `settings/boundary` |
| `LENSPACK_DASHBOARDS` | superset | `dashboards`, as dashboard ids separated by commas (`25,31`) | over the file | narrows only: `settings/boundary` |
| `LENSPACK_DASHBOARD_SCOPE` | superset | `dashboardScope` (`any` or `listed`) | over the file | narrows only: `settings/boundary` |
| `LENSPACK_HOST_POLICY` | superset | `hostPolicy` | over the file | narrows only: `settings/boundary` |
| `LENSPACK_ACCESS_FALLBACK` | superset | `accessFallback` | over the file | narrows only: `settings/boundary` |
| `LENSPACK_ADMIN_ROLES`, `LENSPACK_USAGE_ROLES`, `LENSPACK_USER_ROLES` | superset | `auth.admins`, `auth.usage`, `auth.users`, comma-separated Superset role names | over the file | narrows only: `settings/boundary` |
| `LENSPACK_ADMIN_ACCESS`, `LENSPACK_ADMIN_USERS` | superset | `auth.adminAccess` (one mode, or `password` with another: `superset-role,password`), `auth.adminUsers` (comma-separated) | over the file | narrows only: `settings/boundary` |
| `LENSPACK_ADMIN_PASSWORDS`, `LENSPACK_ADMIN_PASSWORDS_FILE` | superset | the named admin passwords when `auth.adminAccess` includes `password`: `name:password` pairs separated by commas, or a file with one per line (12+ characters each; a value starting `scrypt$` is a hash) | only source | no |
| `LENSPACK_ADMIN_PASSWORD`, `LENSPACK_ADMIN_PASSWORD_HASH` | superset | one more admin password, named `password` (signed in to with the name left empty), or its scrypt hash | only source | no |
| `LENSPACK_ADMIN_API_KEYS`, `LENSPACK_ADMIN_API_KEYS_FILE` | superset | admin API keys, a master override for the admin routes in every admin access mode: `name:key` pairs separated by commas, or a file with one per line (a plain key is 32+ characters; a value starting `scrypt$` is a hash). Sent as `Authorization: Bearer <key>`. See [The admin API key](../access/admin-api.md) | only source | no |
| `LENSPACK_ADMIN_SURFACE` | superset | `admin.surface`: where the admin pages are, `split` (default), `superset` or `separate` | over the file | yes: `settings/admin-surface` |
| `LENSPACK_ADMIN_SESSION_HOURS`, `LENSPACK_ADMIN_SESSION_SECRET` | superset | how long an admin's password sign-in lasts (8 hours), and the key that signs it (else a file in the state directory) | only source | no |
| `LENSPACK_USER_ACCESS`, `LENSPACK_USERS` | superset | `auth.userAccess`, `auth.seedUsers` (comma-separated) | over the file | narrows only: `settings/boundary` |
| `LENSPACK_EDIT_SCOPE`, `LENSPACK_EDIT_SCOPE_ADMINS_EXEMPT` | superset | `editScope` and its `adminsExempt` | over the file; an admin's setting wins over it | yes: `settings/edit-scope` |
| `LENSPACK_MAX_DASHBOARDS_PER_USER`, `LENSPACK_MAX_SAVED_CONFIGS_PER_USER` | superset | the `personal` limits | over the file; an admin's setting wins over it | yes: `settings/personal` |
| `LENSPACK_QUERY_MAX_ROWS`, `LENSPACK_QUERY_MAX_GROUPS`, `LENSPACK_QUERY_MAX_SERIES_POINTS`, `LENSPACK_QUERY_MAX_WINDOW_DAYS`, `LENSPACK_QUERY_MAX_PER_TURN`, `LENSPACK_QUERY_TIMEOUT_SECONDS`, `LENSPACK_QUERY_MAX_CONCURRENT` | superset | the `querySafety` limits (`none` for no `maxWindowDays`). See [Query safety](../operating/query-safety.md) | over the file; an admin may tighten them, and loosen them only with confirm | yes: `settings/query-safety` |
| `LENSPACK_HEAVY_DATASETS` | superset | datasets to treat as heavy (table names, ids or entity keys, comma-separated) | over the file | yes: `settings/query-safety` |
| `LENSPACK_AUDIT_RETENTION_DAYS` | superset | how long audit months are kept | over the file | yes: `settings/audit` |
| `LENSPACK_TELEMETRY_RETENTION_DAYS` | both | how long usage records are kept (90 days) | over the file; an admin's setting wins over it | yes: `settings/telemetry` |
| `LENSPACK_TELEMETRY_QUESTION_TEXT` | both | the older switch for keeping question text; see [Telemetry](../features/telemetry.md) | over the file's older `questionText`; an admin's setting wins over it | yes: `settings/telemetry` |
| `LENSPACK_SPEECH_KEEP_AUDIO`, `LENSPACK_SPEECH_AUDIO_RETENTION_DAYS`, `LENSPACK_SPEECH_MAX_STORED_MB`, `LENSPACK_SPEECH_CONSENT_NOTICE` | both | keeping recordings of spoken questions: whether (off by default), for how long (30 days), how much (1000 MB), and the notice shown | over the file; an admin's setting wins over it | yes: `settings/speech`, `settings/telemetry` |
| `LENSPACK_BRAND_NAME`, `LENSPACK_BRAND_BUTTON`, `LENSPACK_BRAND_ICON`, `LENSPACK_BRAND_POWERED_BY` | both | the assistant's name, button label, icon and "Powered by" line. See [Naming the assistant](../features/naming.md) | over the file; an admin's setting wins over it | yes: `settings/brand` |
| `LENSPACK_MCP_TOKEN` | mcp | the bearer token for `lenspack-mcp --http` | fallback (after `--token`) | no |
| `LENSPACK_DATA_DIR` | the demo | where `pnpm demo` looks for `<name>.duckdb` | only source | no |

Read by the Superset plugin, in Superset's environment:

| variable | default | what it does |
|---|---|---|
| `LENSPACK_INTERNAL_URL` | `http://lenspack:8795` | where Superset's server reaches Lenspack |
| `LENSPACK_SERVICE_USER` | `lenspack` | Lenspack's Superset account |
| `LENSPACK_PATH` | `/lenspack` | where browsers reach the assistant below Superset's path |
| `LENSPACK_BRAND_NAME` | | the settings page's menu entry and heading |
| `LENSPACK_MENU_REFRESH_SECONDS` | `300` | how often the menu entry asks the server for its name and who its admins are |
| `LENSPACK_TEMPLATES` | | a folder of replacement templates |
| `LENSPACK_CLICKHOUSE_LABEL_SUFFIX` | `on` | `off` keeps Superset 6.1's own ClickHouse column names |

The settings page's menu entry and heading take `LENSPACK_BRAND_NAME` from `superset_config.py`, then from
Superset's environment, then the server's own `brand.name`; see [Naming the assistant](../features/naming.md#superset).

---

**Next:** [Pack file reference](pack.md).

**Related:** [Configuration](../operating/configuration.md) · [Feature switches](../operating/switches.md)
