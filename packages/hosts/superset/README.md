# @lenspack/superset

Apache Superset as a lenspack backend, without forking Superset.

This package is a bundle: everything Lenspack needs to work with one outside system, Superset. It reads the pack
from Superset's datasets, gets numbers from Superset, keeps boards in step with Superset dashboards, takes the
signed-in user from Superset and puts the chat inside Superset's pages. It sits with the other hosts under
`packages/hosts/` because Superset is an app Lenspack runs inside, not a separate product.

- **Catalogue from Superset.** `packFromDatasets` turns datasets into a pack: a dataset is an entity, its saved
  metrics are measures (`sql: { superset: <metric_name> }`), its groupable columns are dimensions (a column on
  several datasets becomes one conformed dimension). Hints come from Superset's descriptions; an `Overlay` adds
  what Superset has no field for (instructions, examples, hierarchies, entity names). Something in a dataset the
  pack can't use never stops Lenspack starting: a metric with no name or SQL, or a column with no name, is left
  out; a groupable column with the same name as a saved metric becomes `<name>_value` (the metric keeps the name).
  Each change is one warning line in the log and in the settings API (`warnings`).
- **Numbers from Superset.** `supersetConnector` compiles a resolved query into Superset query objects and runs
  them through `/api/v1/chart/data`, so a metric means the same in both and Superset's row-level security applies.
  No joins (a chart reads one dataset); share, Other and further measures are composed by the engine as usual.
- **Time zones.** Superset cuts time into days with no time zone. A dataset whose time column holds calendar dates
  (`DATE`, or ClickHouse's `Date` and `Date32`) needs none: the catalogue marks it `type: date`, its days, weeks and
  months are drawn in a pack with any `timeZone`, and a window is sent as the dates it holds in that zone ("the last
  7 days" ends today in the pack's zone). In a pack outside UTC, a series over a time column with a time of day is
  refused, and the refusal says what works: a date column, or a pack that keeps UTC.
- **Dashboards are boards.** `dashboardToBoard` reads a dashboard: charts become widgets, markdown becomes text,
  `position_json` becomes the grid. A chart lenspack cannot say exactly (custom SQL filters, ad hoc metrics, a
  heatmap shaded per row or column) is kept as Superset's: a text widget the model can move, resize or remove but
  not rewrite.
- **The filter bar is the board's filters.** A dashboard's native filters (`json_metadata.native_filter_configuration`)
  are read as board filters: a value filter (`filter_select`) on a column the pack has as a dimension becomes a
  select, a time range (`filter_time`) becomes a date range, each with the charts its scope covers and the value it
  is set to by default, so the chat can say what the dashboard is filtered to. Every other filter stays exactly as
  Superset has it and is shown to the model as "Superset-only filter: <name>" with what it does: a numeric range,
  a time grain or time column picker, a value filter on a column outside the pack, one that excludes the values
  picked or picks its first value, one reading several datasets, or a time range default other than "last N days
  or months". The chat can add, change (label, charts, default) and remove filters, and remove a Superset-only one,
  but never rewrite one. Writing back changes only the filters the board changed; every other key, section
  heading and filter is kept as it was. What a viewer has picked in their browser is not seen.
- **Heatmaps.** A heatmap widget is Superset's `heatmap_v2`: a breakdown's dimension on `x_axis`, its split as
  `groupby`, one saved metric, rows A to Z, one scale across the grid. A heatmap over time is refused before the
  change (capability `timeHeatmap: false`): Superset sorts a time axis by the raw column while grouping by its
  weeks or months, which ClickHouse refuses (Postgres accepts it), so use a breakdown over a day or date label
  column instead.
- **Maps.** A dataset with one numeric `latitude`/`lat` column and one `longitude`/`lon`/`lng`/`long` column
  becomes an entity with a location (`overlay.geo` names other columns per entity, dataset id or table, or turns
  detection off with `false`). A `map` widget is Superset's `deck_scatter`: `spatial` latlong on those columns,
  `dimension` for the colour, a saved metric as `point_radius_fixed` for the size (Superset groups by location),
  the label in `js_columns`, `row_limit`, and `mapbox_style` from `overlay.mapStyle`. The default is Superset's
  own for its version: OpenStreetMap streets on Superset 6 (no key needed), `mapbox://styles/mapbox/light-v9` on
  Superset 5, which takes Mapbox styles only and draws them only with Superset's `MAPBOX_API_KEY`. The query that
  draws the points is saved with the chart, so Superset's reports and `GET /api/v1/chart/<id>/data` get the same
  points as the dashboard; Lenspack reads them through `/api/v1/chart/data`. A `deck_scatter` made in Explore
  reads back as a map when every
  setting maps: latlong on the entity's location columns, a fixed or saved-metric radius, a dimension colour, at
  most one dimension in `js_columns`, no time grain and no JavaScript; otherwise it stays Superset's. Shaded areas
  (`deck_polygon`) are not done: they need boundary shapes in a dataset column.
  `pushBoard` sends only what changed: `POST`/`PUT /api/v1/chart`, then the dashboard's layout, title and filters.
- **Tabs.** A dashboard's layout is read from the top down, through tabs (top-level, inside the grid, or inside
  other tabs) and columns, so the board lists every chart Superset draws, tab after tab. The chat is told what is
  on each tab and which tab the viewer has open (the overlay sends it with each message). On a dashboard with tabs
  or columns Lenspack keeps the layout and changes it in place (`layout.ts`):
  - a new chart goes on the tab of the widget its placement names (`after:` or `below:`), else at the top or
    bottom of the viewer's tab, else where Superset puts charts that have no place: the first top-level tab, or the
    grid when the tabs sit inside it. Never under the grid that top-level tabs leave behind, where Superset draws
    nothing;
  - a resize changes the chart where it is (a row then wider than 12 columns wraps onto a new row in place);
  - a removal takes out that one placement (a chart placed in two tabs keeps the other) and any row it empties;
  - a restore puts a removed chart back where it was: the same chart, unless Lenspack made it, in its tab and row;
  - **a move is refused**, with a message saying to move the chart in Superset. Moving charts between rows and tabs
    needs a board that knows tabs, which is not built yet. Tabs themselves are made, renamed and removed in Superset.

  Before every save the whole layout is checked (`layoutProblems`): each component listed by one parent, every
  child present and allowed in its parent, `parents` matching the tree, `ROOT_ID` holding one grid or tabs, every
  chart reachable. A layout that fails a check it passed before is not saved, and the chat says so. Problems the
  dashboard already had are logged and left as they are. `placeCharts` puts charts a layout doesn't draw where
  Superset draws them; use it whenever a layout gains charts outside Lenspack's edits (a copy of a dashboard).
- **Superset stays the record.** `supersetBoards` wraps any `BoardStore`: reads pick up edits made in Superset,
  every lenspack change is sent to Superset before it counts, and a change Superset refuses is undone. Lenspack's
  version history is the undo Superset lacks.

## Superset versions

**Superset 6.1** is the version this package is built for. **Superset 5.0** still works, and is tested the same
way. Superset 6.0 sits between the two and has not been tested.

Lenspack reads Superset's version when it starts and prints it (`Superset 6.1.0; maps drawn on …`). It asks the
plugin first (`/api/v1/lenspack/version`), then Superset 6.1's own `/version`; with neither, it assumes 5.

What is different between the two, as far as Lenspack is concerned:

| | Superset 6.1 | Superset 5.0 |
|---|---|---|
| Maps' default basemap | OpenStreetMap streets, no key needed. `overlay.mapStyle` may name a Mapbox style, a `tile://` URL or an OpenStreetMap URL | Mapbox light, which needs Superset's `MAPBOX_API_KEY`. `overlay.mapStyle` must be a Mapbox style |
| How Superset draws a map | through the chart-data API, from the chart's settings | through its older `explore_json` path, from the chart's settings |
| Settings → AI assistant | its own page frame, with a link back to Superset, light or dark as Superset is (Superset 6 has no server-drawn pages left to borrow) | inside Superset's server-drawn page |
| Dark theme | the chat button, window and settings page follow it | Superset 5 has none |
| Charts as Superset returns them | each setting's keys in alphabetical order; Lenspack compares settings by value, so this changes nothing | as saved |
| ClickHouse | needs `clickhouse-connect` 0.13 or later. The plugin puts back the short suffix Superset 5 and 6.0 added to column names in ClickHouse queries (below) | `clickhouse-connect` 0.8 or later |
| Filter bar | also keeps "chart customizations" and a timestamp switch beside the filters; Lenspack leaves both untouched | |

Everything else Lenspack uses is the same on both: the chart-data requests and their post-processing steps,
the chart settings for every chart type it writes, native filters, dashboard layouts, row-level security and
dataset permissions, and the content security policy (the button's script carries the page's nonce, which
Superset 6.1's stricter policy requires). Lenspack's admin panel works with Superset's default
Content-Security-Policy too: the plugin stamps the page's nonce on the panel's scripts as it passes the page on. Flask-AppBuilder's shared-filter fault (below) is still there in
Superset 6.1, so the plugin keeps its fix.

**ClickHouse column names on Superset 6.1.** Up to 6.0, Superset gave every column in a ClickHouse query a short
suffix (`SUM(x) AS x_9dd4e4`) and renamed the results back. Superset 6.1 dropped the suffix
([apache/superset#38280](https://github.com/apache/superset/pull/38280), in
`superset/db_engine_specs/clickhouse.py`). ClickHouse lets one column of a query refer to another by its name, so
a saved metric named like the column it adds up (`SUM(x)` saved as `x`) now hides that column: another metric in
the same chart that uses `x`, such as `SUM(x) / COUNT(*)`, adds up the first metric instead, and ClickHouse
refuses the query (error 184, an aggregate function inside another). The plugin puts the suffix back when
Superset starts. Results keep their names, so charts and Lenspack see no change. With
`LENSPACK_CLICKHOUSE_LABEL_SUFFIX=off`, Superset 6.1's own names stay; then rename such metrics (`x_total`, say) so
that no metric is named like a column. One thing 6.1's change had made work goes back to how it was on 5.0: in
Superset's own Explore, a heatmap with weeks or months on its axis fails on ClickHouse (Lenspack never writes one).

What Superset 6 adds that the assistant could use next, and what each would take:
[docs/superset-6.md](../../../docs/superset-6.md).

## Running it

`lenspack superset --config superset.yaml` runs the board API and the chat inside Superset (`/overlay.js`, loaded
by one script tag in Superset's documented-overridable `tail_js_custom_extra.html`). It is the same server as
`lenspack serve` (`@lenspack/serve`'s runtime: models, metering, budget, audit, `/healthz`, a clean exit on
SIGTERM), with Superset as its host: the pack comes from Superset's datasets, boards are kept in its
dashboards, and Superset's signed header is the sign-in. The root image runs it:

```sh
docker run -v "$PWD/config:/config:ro" -v lenspack-data:/data -p 8795:8795 \
  -e LENSPACK_SUPERSET_URL=http://superset:8088 -e ANTHROPIC_API_KEY \
  lenspack superset --config /config/superset.yaml
```

From the source tree, `npx tsx --tsconfig tsconfig.base.json packages/hosts/superset/bin/serve.ts superset.yaml` does
the same. Superset's side is one Python file, [`plugin/lenspack_superset.py`](plugin/lenspack_superset.py)
(below).

```yaml
# superset.yaml: a string "env:NAME" anywhere reads that variable
datasets: [visits, public.households]   # by id, or by table name
overlay: { instructions: "…", examples: [] }
# Each of these may be left out for its environment variable, then the default:
superset: { url: http://superset:8088 }  # LENSPACK_SUPERSET_URL (required one way or the other)
publicPath: /lenspack                    # LENSPACK_PUBLIC_PATH, "" (where a proxy mounts this server)
host: 0.0.0.0                            # LENSPACK_HOST, 127.0.0.1 (0.0.0.0 in the image)
port: 8795                               # LENSPACK_PORT, 8795
state: /data/superset-boards.json        # LENSPACK_STATE_DIR/superset-boards.json, state/superset-boards.json
budget: { usdPerDay: 20 }                # LENSPACK_BUDGET_USD_PER_DAY, LENSPACK_BUDGET_USD_PER_USER_PER_DAY
hostPolicy: superset                     # LENSPACK_HOST_POLICY, superset: each user's own Superset access (see "What each user sees")
```

Models: `LENSPACK_LLM_PROVIDERS` as for `lenspack serve` ([docs/llm.md](../../docs/llm.md)). With only
`ANTHROPIC_API_KEY` set, the chat offers Claude Sonnet 5.5 (the default), Opus 5.5 and Haiku 5.5, and the
settings page says the key came from `ANTHROPIC_API_KEY`.

## Superset's side: `plugin/lenspack_superset.py`

One file, loaded by Superset's own config. It needs no fork, no custom image and no second web server. It adds:

- `/lenspack/...` on Superset's own host, forwarded to this server for signed-in users with the signed identity
  header (below). Chat replies stream through unbuffered, and a change sent from another site is refused.
  Browsers never reach Lenspack's port.
- the **Ask Lenspack** button on every page, through `tail_js_custom_extra.html`;
- **Settings → Manage → AI assistant** for admins: chat and speech models, languages, off switches, spend, cost
  per answer and the audit log, all through `/_superset/*` on this server;
- `GET /api/v1/lenspack/identity-key` and `POST /api/v1/lenspack/bootstrap`, which this server calls on start
  to fetch the signing key and to make its own account (below);
- `GET /api/v1/lenspack/access?user=&datasets=&dashboards=`, which this server calls with `hostPolicy: superset`
  (the default): for one user, whether they may read each dataset and the row-level security clauses on it,
  whether they may open each dashboard, and with dashboard roles on, which datasets they may read only on each
  dashboard (below);
- `GET /api/v1/lenspack/version`, Superset's version, which this server reads on start (admins and its own
  account);
- a fix for Flask-AppBuilder (4.x in Superset 5, 5.x in Superset 6.1), whose list endpoints share filters between
  concurrent requests;
- on Superset 6.1, the ClickHouse fix described under "Superset versions".

To load it, put the file on Superset's Python path (for example, mounted into `/app/pythonpath/`) and import
it at the end of `superset_config.py`:

```python
# superset_config.py
from lenspack_superset import *  # noqa: F401,F403
```

On the Helm chart, a `configOverrides` entry holding that line does the same. The import sets
`FLASK_APP_MUTATOR`. If your config already sets one, call `lenspack_app_mutator(app)` from yours and set
`FLASK_APP_MUTATOR` back to yours after the import.

| Superset's environment | default | |
|---|---|---|
| `LENSPACK_INTERNAL_URL` | `http://lenspack:8795` | where Superset's server reaches this one |
| `LENSPACK_SERVICE_USER` | `lenspack` | this server's Superset account (`superset.username` here) |
| `LENSPACK_TEMPLATES` | none | a folder whose `tail_js_custom_extra.html` or `lenspack/settings.html` replaces the built-in one |
| `LENSPACK_CLICKHOUSE_LABEL_SUFFIX` | `on` | `off` keeps Superset 6.1's own ClickHouse column names (see "Superset versions") |

On this server, set `publicPath: /lenspack` (or `LENSPACK_PUBLIC_PATH=/lenspack`) so its pages and scripts
use the path Superset forwards. A chat turn holds one of Superset's gunicorn threads while it streams (30 to 60 s),
so raise `SERVER_THREADS_AMOUNT` for more than about ten chats at once.

## Who is asking

Browsers never reach this server directly. Superset forwards `/lenspack/...` to it for signed-in users and adds
`x-lenspack-identity`: base64url JSON `{u, i, a, r, d, b, p, e, v, t}` (user, their Superset user id, Superset admin,
their Superset role names, the dashboard the request is about, its board `superset-<d>` and the pack in the path,
whether Superset lets them edit and view it, signed-at) and an HMAC-SHA256 of it. The key is derived from
Superset's `SECRET_KEY` on the Superset side; this server fetches it on start
(`GET /api/v1/lenspack/identity-key`, allowed to admins and its own account). A request without a valid
signature less than five minutes old is not signed in (401). Only `overlay.js`, `chat.js`, `mine.js`, `chat.css` and
`/healthz` are public.

- **One dashboard per request.** The plugin reads the dashboard from the place where this server reads a board
  (`api/<pack>/superset-<id>/...`) and checks the user's rights on that dashboard. This server reads the board
  from its own route and refuses the request (403) when it is not the board Superset signed for. The same happens
  when the pack differs, or when the path names a `superset-<id>` board that Superset signed nothing for. Both
  sides refuse a path with a `.` or `..` segment or an encoded slash (`%2e`, `%2f`, `%5c`; 400). Binding a
  dashboard (`/_superset/bind`), and the own-dashboard and saved-layout routes (`/_superset/my...?dashboard=<id>`),
  work only for the dashboard Superset checked. A plugin from before `b` and `p`
  signs only `d`, and this server then checks `superset-<d>` against its route.
- **Edits** follow `LENSPACK_EDIT_POLICY` (or `editPolicy` in the config). `superset`, the default: whoever
  Superset lets edit that dashboard, its owners with `can_write` on Dashboard and admins. That right counts on
  that dashboard's board only. Everyone else who can view it may still ask questions; the chat's edit tools then
  answer "you can view this dashboard but not edit it in Superset", which the model passes on. `signed-in`:
  anyone signed in may edit (the behaviour before). The `boardEdits` off switch (below) comes first: off, nobody
  edits through the chat, admins included. Someone who can only view a dashboard can make their own copy and change that: see
  [your own dashboards and saved layouts](../../../docs/my-dashboards.md). `editScope: own` (or
  `LENSPACK_EDIT_SCOPE=own`) narrows chat edits further, to each person's own dashboards, so shared ones stay as
  they are; admins are exempt unless `adminsExempt: false`.
- **Settings** writes, the audit log and the usage page (`GET /api/_usage`, which names every user's spend) need
  a Superset admin. Owning a dashboard does not give them.
- **Its own account.** On first start it signs in once as a Superset admin (`SUPERSET_ADMIN_USERNAME`, default
  `admin`, and `SUPERSET_ADMIN_PASSWORD`) and calls `POST /api/v1/lenspack/bootstrap`, which makes the
  `lenspack` user (Admin role: it edits dashboards it doesn't own, which Superset allows only owners and admins).
  The generated password stays in `superset-account.json` (mode 600) in the state directory; after that the admin
  password can be removed. `LENSPACK_SUPERSET_PASSWORD` (with `superset.username`) uses an account you manage
  instead.
- **Audit log.** Board changes, refused and denied requests, chat turns and settings changes, each with the
  Superset user, one JSON line each in `audit.jsonl` in the state directory. On the first write of a month the
  previous month moves to `audit-YYYY-MM.jsonl`; months older than 90 days are deleted (`audit.retentionDays`,
  `LENSPACK_AUDIT_RETENTION_DAYS`; `audit: false` turns it off). It is the durable record: the usage figures
  (`GET /api/_usage`) are kept in memory and reset on restart. Admins read it with
  `GET /_superset/audit?month=YYYY-MM&limit=N`, and on the AI assistant page.

## What each user sees

Lenspack reads data through its own Superset account, an Admin. By default (`hostPolicy: superset`) it narrows
every answer to what the person asking may see in Superset: their own dataset permissions and row-level security
(RLS), and the dashboards they may open. When it cannot tell, it shows less, never more.

> **Changed:** before this release the default was `hostPolicy: off`. A deployment that left `hostPolicy` unset
> now applies each user's Superset access when it upgrades. Users without access to a dataset stop seeing its
> numbers through the chat, and RLS narrows their answers. Check your Superset roles before upgrading, or set
> `hostPolicy: off` to keep the old behaviour while you do.

- **Datasets.** A dataset the user may not read in Superset (no `datasource_access`, `schema_access`,
  `database_access` or `all_datasource_access` through their roles) is kept from them. Its metrics, the columns
  only it has, and its name leave the catalogue and the chat's vocabulary, and any query that reads it is refused.
  A column shared by name with a dataset they may read stays.
- **Row-level security.** Each RLS clause that applies to the user (Regular rules for their roles, Base rules
  unless they have one of its roles; one group key's clauses ORed) narrows every query Lenspack runs on that
  dataset, chat tools and filter menus included, and no other dataset. A clause becomes a filter when it is
  simple: `col = value`, `col IN (...)`, `AND`, brackets, and `OR` over one column. The column must be one of
  the pack's dimensions.
- **Fails closed.** Anything else (`LIKE`, `!=`, functions, subqueries, a column the pack doesn't have, a
  template that wasn't rendered) keeps the whole dataset from that user, and the log says which clause and why.
  If Superset can't be asked, every dataset and dashboard is kept from that user until the next try.
- **Dashboards.** The dashboards list (`/_superset/dashboards`) and the boards list (`GET /api/<pack>`) show
  only the dashboards the user may open in Superset (owners, admins, dashboard roles with `DASHBOARD_RBAC`, or
  access to one of its datasets). The dashboard a request is about is still checked on every request (see "Who is
  asking").
- **Dashboard roles.** With `DASHBOARD_RBAC` on, a user who opens a dashboard through its dashboard roles can ask
  about the data of that dashboard's charts there, with their RLS, as Superset shows it to them, and nowhere else
  (update the plugin for this; see [docs/access.md, "Dashboard roles"](../../../docs/access.md#dashboard-roles-dashboard_rbac)).
- **What users are told.** A question about data their access keeps from them is answered with "not available to
  you: your Superset access doesn't include it. A Superset admin can give you access.", not with "the pack doesn't
  have it". The chat is told some data is kept from this user, so it doesn't guess what. A user who may read none
  of the datasets sees that message when the chat opens, and no model is asked. While Superset can't be asked, the
  message says Lenspack could not check their access.
- **Where it comes from.** The plugin's `/api/v1/lenspack/access` asks Superset's security manager as that user
  (`can_access_datasource`, `get_rls_filters`, `can_access_dashboard`), with Jinja such as
  `{{ current_username() }}` rendered as Superset renders it (with `ENABLE_TEMPLATE_PROCESSING` on). Only admins
  and Lenspack's own account may call it. Answers are kept for 60 seconds per user, so a change in Superset reaches
  Lenspack within a minute. Without that endpoint (an older plugin), this server reads the RLS rules from
  Superset's REST API (`/api/v1/rowlevelsecurity/`) and matches them to the roles in the identity header. That
  route can't read dataset permissions, dashboard access or render templates: every dataset counts as readable, a
  templated clause keeps its dataset from the user, and only the dashboard a request is about is listed.

**`hostPolicy: off`** (or `LENSPACK_HOST_POLICY=off`) is still there, as an explicit choice. Every answer then uses
the service account's access. **Anyone signed in to Superset can read every dataset listed in `datasets:` in full,
with no row-level security, even datasets Superset keeps from them**, through the chat, the filter menus and the
board API, on any dashboard they can open. Lenspack prints a warning saying so at every start. Use it only when
everyone who can sign in to Superset may see all of those datasets in full.

The roles in the header also become the user's roles in Lenspack's policy, beside `admin` for a Superset admin.
A Superset role literally named `admin` grants nothing here; Lenspack's admin comes from the signed admin flag.
What a Superset dashboard shows natively is unchanged: Superset applies its own security there.

The plugin's tests run in Superset's image, once for each supported version:
[`plugin/test_lenspack_superset.py`](plugin/test_lenspack_superset.py) has the command for each. The access
suite runs Lenspack against real Superset 6.1 and 5.0 containers and checks what each kind of user can see and
change: `pnpm test:access` ([docs/access.md, "How access is tested"](../../../docs/access.md#how-access-is-tested)).

Inside Superset the chat opens as a floating window or as a side panel; the gear chooses. The window opens at
the top right, below Superset's menu bar, with room under it: drag it by its header, and resize it with the
grip in its bottom-left corner (down and left, the top-right corner staying put) or from its left and top
edges. Size and position are remembered per browser.

## Voice and languages

The chat panel has a mic and a language menu (Auto, English, Français, हिन्दी, Português), remembered per browser. The
overlay's own words (its button, gear menu and grip) and the suggested questions follow the same language. A
suggested question may be written per language, with one query for all of them:

```yaml
overlay:
  examples:
    - question: { en: Zero-dose share by LGA, fr: Part des enfants zéro dose par LGA }
      query: { kind: breakdown, dimension: lga, measure: zero_dose_pct, limit: 10 }
```

The model sees the English wording (else the first) as a worked example; a language an example doesn't have
shows its English. `/_superset/info` returns `examplesByLang`, and `examples` for `?lang=` (English by default).

- **Mic.** Click to start and click again to stop, or hold the button and release to stop. Holding Space for
  2 s (`speech.holdMs`, 500–3000; each user can pick their own in the menu) also talks, even while typing
  in the panel: a shorter press types a space, and the mic button fills up to show the hold. Space is left
  alone in Superset's own fields, on buttons and other controls, during IME composition and with a modifier. Recording shows a timer and a level meter and stops at `speech.maxSeconds`
  (60). The clip goes to `POST /api/_stt` on this server, which sends it to an OpenAI-style transcription
  endpoint (OpenRouter by default); the text lands in the input to check before sending. Browsers allow the
  mic only on https pages or localhost.
- **Language.** Auto sends no language hint (the model detects it) and the chat replies in whatever language
  the user wrote or spoke. A picked language is the speech hint, the reply language and the panel's own
  words. Without a pick, the panel follows Superset's language when one was chosen there (Superset's
  bootstrap `common.locale`; its default, English, does not count), else the deployment default. A locale
  counts by its first two letters, so Superset's `pt` and `pt_BR` both give Portuguese.
- **Portuguese** is written once for both sides of the Atlantic: the panel's words and the reply instruction
  aim at Portuguese that reads naturally in Mozambique, Angola and Portugal as well as Brazil (noun forms
  where the two split their verb forms, words both use). Write example questions the same way.
- **New chat.** The pencil button in the header clears the conversation for this board (the board itself,
  settings and language prefs are untouched). The model starts over but still hears of later edits, and an
  Undo note brings the conversation back for five seconds. It is disabled while a turn or the mic is busy.
- **Titles.** New board and widget titles are written in the board's language (`language.board`, English by
  default) whatever language the user speaks, or in the reply's language with `language.titles: speaker`.
- **Key.** `LENSPACK_STT_API_KEY`, else `OPENROUTER_API_KEY`, on this server only. Without one the mic is
  hidden and `/api/_stt` answers 503. Transcriptions are metered (role `speech`) and count against the budget.

`speech.model` (default `mistralai/voxtral-mini-transcribe-3-0`), `speech.holdMs` (2000) and `language.{default,titles,board}` in the
config are defaults. An admin can change them on a running server from Superset's Settings → AI assistant
page, which calls:

| | |
|---|---|
| `GET /_superset/settings` | includes `speech` {enabled, keyFrom, model, defaultModel, source, holdMs, defaultHoldMs, holdMsRange, writable} and `language` {default, titles, board, options, defaults, source, writable} |
| `GET /_superset/settings/speech/models` | the provider's transcription models with a per-minute price (cached an hour) |
| `PUT /_superset/settings/speech` | any of `{model, holdMs}`; a field left out is kept, `null` puts it back to the default |
| `PUT /_superset/settings/language` | any of `{default, titles, board}`; `null` resets a field |
| `PUT /_superset/settings/features` | any of `{<switch>: true \| false \| null}` (below); `null` drops the admin's value |
| `PUT /_superset/settings/cache` | any of `{enabled, ttlHours, router, maxEntries, freshMinutes, prewarm}` for saved answers; `null` resets a field |
| `PUT /_superset/settings/queue` | any of `{maxConcurrent, maxWaiting, maxWaitSeconds}` for busy hours ([docs/caching.md](../../../docs/caching.md#busy-hours-the-queue)) |
| `GET /_superset/cache` and below | saved answers: stats, queue, last refresh, entries, pin, unpin, evict, suggestions, chart candidates, settled boards ([docs/caching.md](../../../docs/caching.md#the-admin-api)) |
| `POST /_superset/cache/prewarm`, `POST /_superset/cache/data-changed` | refresh the most-asked saved answers now, or a few seconds after a data load ([docs/caching.md](../../../docs/caching.md#pre-warming-ready-before-the-peak)) |
| `PUT /_superset/settings/personal` | any of `{maxDashboardsPerUser, maxSavedConfigsPerUser}`; `null` resets ([docs/my-dashboards.md](../../../docs/my-dashboards.md)) |
| `PUT /_superset/settings/edit-scope` | any of `{scope: "superset" \| "own", adminsExempt}`; `null` resets |

Reads and writes need a Superset admin's signed identity (above). Settings persist in `settings.json` beside
the board state.

When the state directory can't be written (disk full, read-only mount), the assistant keeps working: dashboards
still bind and answer, with the links between widgets and charts kept in memory (the log says so once) until a
save works again. A settings write changes nothing and gets `503` with the reason ("Lenspack can't save
settings: the disk is full. Nothing was changed."). Files are written whole (a temporary file renamed into
place), and an unreadable board-state file is set aside as `*.unreadable-<time>` instead of stopping the server.

When a query fails, the model hears the reason, not the deployment's addresses: an unreachable data source
becomes "The data source is unreachable (connection refused | host not found | no connection | connection
dropped | sign-in refused | Superset is unavailable)", a slow one "did not answer in time", and any other error
keeps its wording with URLs, hosts, ports and IP addresses taken out. The raw error goes to the server log.

## Off switches

Each part of the assistant can be turned off; all are on by default except the daily review, which costs money.
A switch's value comes from, lowest first: the default, `features:` in the config, `LENSPACK_FEATURES`, then an admin on the settings page. The page
can turn a switch the environment set back on; `null` hands it back to the environment.

```yaml
features: { voice: false, reviewer: false }      # in the config
```
```sh
LENSPACK_FEATURES="voice=off,maps=on"             # or "-voice,+maps", or a JSON object
```

| switch | off means | enforced by |
|---|---|---|
| `overlay` | no Ask Lenspack button or panel on any dashboard | the page |
| `voice` | no mic; `/api/_stt` answers 503 | the server (the key is withheld) |
| `spaceHold` | holding Space doesn't talk; the mic button still does | the page |
| `languageMenu` | no language picker; the deployment's default language applies, and a pick saved earlier is ignored | the page |
| `markdown` | replies as plain text | the page |
| `inPlaceRefresh` | after a change the page reloads instead of redrawing the dashboard | the page |
| `newChat` | no New chat button | the page |
| `boardEdits` | the chat answers questions only, for everyone, admins included; edit tools say edits are turned off | the server |
| `heatmap` | new heatmaps are refused (existing ones stay) | the server |
| `maps` | map queries are refused (existing deck_scatter charts stay in Superset) | the server |
| `reviewer` | no second model call checking each change: edits are saved as they are made, and a wrong one is not caught before the reply | the server |
| `cache` | no saved answers: every question goes to the model, even one answered a minute ago ([docs/caching.md](../../../docs/caching.md)) | the server |
| `personalDashboards` | no My dashboards or Saved layouts menus; the chat can't make, copy or delete dashboards or save or apply layouts (dashboards already made stay) | the server |
| `explain` | no "How this was worked out" under answers, and none in the audit log; `explain: { sql: false }` in the config keeps it without the SQL ([docs/explain.md](../../../docs/explain.md)) | the server |
| `telemetry` | no usage records, no thumbs under answers; `/api/_telemetry` answers 404 ([docs/telemetry.md](../../../docs/telemetry.md)) | the server |
| `clarify` | the assistant never asks which reading is meant and logs no open questions | the server |
| `review.daily` | (off by default) no daily review of the day's questions | the server |
| `review.compare` | open questions' readings are not run on the data after a review | the server |

The admin panel (open questions, definitions, the daily review, a board of how the assistant is used) is at
`/lenspack/_superset/admin/`, for Superset admins, linked from the settings page: see [docs/review.md](../../../docs/review.md).

`/_superset/info` returns `features` (the effective booleans) for the page. `GET /_superset/settings` returns
`features: {values, defaults, source, options, writable}`: `defaults` is what the deployment says without the
admin, `source` is `default`, `config`, `env` or `settings` per switch, and `options` gives each switch's label
and help text. A page holding an old copy picks up a change on its next dashboard load.

Gaps: a previous-period KPI is drawn by Superset
without its comparison; tabs and columns in a dashboard are kept, and new widgets are added below them.

## Usage telemetry

Each chat turn, transcription and client event (a thumbs up or down, an answer left early) leaves a record in
`telemetry.jsonl` in the state directory. The record holds the user and the role names the plugin signs. The
deployment's `context:` section maps boards, datasets and roles to a campaign, campaign type and country:

```yaml
context:
  superset-12: { campaign: Round 2 }
  "role:Supervisor-North": { country: Country A }
```

Admins read the records at `/_superset/telemetry`. What is recorded is switched item by item on the admin panel's
Telemetry tab (`/lenspack/_superset/admin/#telemetry`), which is also the checklist at
`/_superset/telemetry/checklist`. Question text, transcript text, kept recordings and device detail start off. The
AI assistant settings page keeps how long records and recordings are kept and the consent notice. What is recorded,
and the privacy choices, are in [docs/telemetry.md](../../../docs/telemetry.md).

