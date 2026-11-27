# Changelog

What changed in Lenspack, newest first. Read the entries since your version before you upgrade; the steps are in
[Upgrading](docs/operating/upgrading.md).

**Versions.** The packages are at version `0.1.0`, and no version has been released since. Everything below is on the
main branch and not yet in a release; it will become the next version's notes. Each entry links the change that
brought it.

## Not yet released

### 27 November 2026

- **Tabs: protected tabs, tabs made through the chat, limits, and playground tabs.** On a Superset dashboard in tabs, a
  deployment can protect tabs (`tabs.protected`, by tab id per dashboard) so the chat never changes them, for admins
  too, or let the chat change only tabs it made (`tabs.editable: own`). With the `chatTabs` switch, people who may
  edit a dashboard can ask for a new tab, rename it and delete it; with the `playground` switch, people who may only
  view it can have tabs of their own, named after them, and change only those. The chat makes at most 3 tabs per
  person and 20 per dashboard, and puts at most 1.5 times the fullest tab's widgets on one tab (all configurable).
  Every write is checked: the chat's tools, the board API, restores and saved layouts, and a last check before
  Superset is sent the layout. Everything is off by default; settings are in `superset.yaml`, the environment, the
  settings API (`PUT /_superset/settings/tabs`) and the start-up log; `GET /_superset/tabs` lists the tabs made through
  the chat with their makers. Superset has no per-tab permissions, so these rules bind the chat only. See
  [Tabs on dashboards](docs/features/tabs.md).
- **Limits on the queries sent to the database.** Lenspack now checks every query it sends to Superset before
  sending it, and refuses one that is too heavy with a plain message the assistant passes on or acts on ("use a
  coarser grain", "pick a coarser level"). On by default, with no change to any answer: at most 20,000 rows and
  20,000 series points a query, 100 queries a question, 8 at once, 30 seconds each. Mark a large row-level dataset
  `heavy: true` and its questions need a time range (the last 90 days when none is asked, at most 400 days), and list
  columns with a value per record in `highCardinality` so nothing groups by them. Set them under `querySafety:` in
  `superset.yaml` or `LENSPACK_QUERY_*`; admins see them in `GET /_superset/settings` and change them with
  `PUT /_superset/settings/query-safety`: tighter freely, looser only with `"confirm": true`. Ask your database team to
  limit Superset's reader user too. See [Query safety](docs/operating/query-safety.md).
- **Change the pack while it runs.** Admins can change the pack's description, instructions, labels, hints, measures,
  example questions, `notDimensions` and hierarchies, and add exclusions, with no redeploy and no restart: on the
  settings routes (`/_superset/settings/pack`), or with an admin API key at `…/lenspack/_admin/settings/pack`. The
  overlay in `superset.yaml` stays the base; the changes are a layer over it, kept as versions in `pack-layer.json` in
  the state directory (who, when, why and what changed), which can be listed, compared, gone back to, reset part by
  part, and exported as YAML to write back into `superset.yaml`. Each change is checked as at start-up against
  Superset's datasets as they are now, example questions included, and refused with nothing changed if it adds a
  problem. A change is in force from the next request; a question already being answered finishes on the old pack,
  and saved answers kept under the old pack are not served. Datasets, the row scope, dashboards, access, budgets,
  models, the pack's name, entity keys and time zone stay in `superset.yaml`, and an exclusion it makes can't be
  removed. Each change is audited as `pack edit`, `pack revert` or `pack reset` with who made it. Nothing changes
  until an admin makes a change. The admin pages have a **Pack** tab for it: the YAML with Validate and Save,
  problems shown inline, and the versions with Go back and Export. See
  [Changing the pack while it runs](docs/hosts/superset/pack-runtime.md).
- **An admin API key, for scripts and for deployments with no server access.** Set `LENSPACK_ADMIN_API_KEYS` (one
  `name:key` per key, or a mounted file with `LENSPACK_ADMIN_API_KEYS_FILE`; best as a `scrypt$` hash from
  `lenspack hash-password`, so the Secret holds only the hash) and send `Authorization: Bearer <key>` to
  `https://<your Superset>/lenspack/_admin/<route>`: no Superset session needed. A key is a master override: an admin
  in every admin access mode, who may also add admins, on the admin routes only; never the chat or data. Everything
  done with it is in the audit log as `api:<name>`, and the Access tab lists it as "API key <name>" once used.
  `GET …/_admin/whoami` checks a key without changing anything. Wrong keys are limited per caller and audited without
  the key. Off by default; update the plugin file with the server, since it now passes the header on for
  `/lenspack/_admin/` only. See [The admin API key](docs/access/admin-api.md).
- **The assistant can be limited to some Superset dashboards.** On a Superset shared by several projects, set
  `dashboardScope: listed` (or `LENSPACK_DASHBOARD_SCOPE=listed`) and list the dashboards in `dashboards:` (or
  `LENSPACK_DASHBOARDS=25,31`). The button then shows on those dashboards only, and every route that takes a
  dashboard (the chat, the board and its data, copying, saving layouts) refuses any other, for admins too. People's
  own copies of a listed dashboard, and blank ones made through the assistant, stay usable. The default, `any`, keeps
  today's behaviour. The start-up log and the settings API say the scope; an unknown value, or `listed` with no
  dashboards, stops the server at start. A refused dashboard now also hides a button or panel left open from the
  dashboard before. See [Which dashboards the assistant is on](docs/hosts/superset/datasets-and-dashboards.md#which-dashboards-the-assistant-is-on).

### 26 November 2026

- **Choose where the admin pages are.** `admin.surface` / `LENSPACK_ADMIN_SURFACE`: `split` (the default: Superset's AI
  assistant page holds what Superset needs, the panel the rest), `superset` (everything on Superset's page, in its own
  frame; the panel's address leads there) or `separate` (everything on the panel; Superset's page links to it). Both
  pages are now drawn by one script, with one look in light and dark and at phone width, sections you can jump to, and
  one pager on every list. Superset's page opens for anyone Lenspack calls an admin, not only Superset Admins.

- **Choose who is an admin and who may use the assistant.** In Superset, admins can now be Superset roles (the
  default, as before), named Superset users (`superset-users`: owners from `LENSPACK_ADMIN_USERS`, who add other
  admins on the admin panel's new **Access** tab; Superset's own Admin role then grants nothing), or named
  passwords on a sign-in page of their own (`password`, reached at `/lenspack/_admin/`: one `name:password` per
  person in `LENSPACK_ADMIN_PASSWORDS` or a mounted file, `LENSPACK_ADMIN_PASSWORDS_FILE`, each shown as
  `admin:<name>` in the audit log; `LENSPACK_ADMIN_PASSWORD` still works as one unnamed entry). `password` combines
  with either of the others (`superset-role,password`, `superset-users,password`). The **Access** tab lists every admin
  who has used admin rights and how they qualified, the audit log notes each one's first use, and the panel names anyone
  new since your last visit. The docs now recommend a role of its own, `Lenspack admin`, over Superset's `Admin`.
  Users can be Superset roles (the default), people admins add one by one (`granted`), everyone signed in, or a
  role and a grant together (`superset-role,granted`). Set with `auth.adminAccess` / `LENSPACK_ADMIN_ACCESS` and
  `auth.userAccess` / `LENSPACK_USER_ACCESS`; the start-up log and the Access tab say which modes are in force.
  Misconfigured modes let nobody in and say why; an unknown mode stops the server. Nothing changes until you set
  them. Update the plugin file with the server for the password sign-in. See
  [Who can use and administer the assistant](docs/access/admin-access.md).
- **Name boxes show the deployment's name.** On the admin panel's Name card, an empty box now shows what applies
  without it, from the boxes above it and the deployment's own name and button label, never the default name.
- **The spend file and a single-file audit log are private.** `usage.jsonl` (which names who asked) and an audit log
  written to one file are now created readable by the server's own user only, and an existing file is made so at
  start, like the saved-answers, telemetry and monthly audit files.
- **The Telemetry tab shows what is recorded, and what it tells you, apart.** What's recorded lists the facts a
  record carries (who asked, how it ended, what it cost, how long it took, and so on) in plain categories, each with
  its switch, how many records from the last 7 days carry it, which figures on the board read it, and its privacy
  note. What it tells you is a Lenspack board over the usage pack, with the same renderer and chat as Overview: a
  section per question (users, volume and cost, quality, what people ask, speed, voice, trust and reuse), each figure
  worked out from the records with simple measures and compute steps. A widget that needs a field that is off says so,
  with a link to that field's switch. Boards anywhere can do the same: a host passes `ctx.unavailable` and the widget
  shows its `notice` in place of a figure (refusal code `UNAVAILABLE`). Switches are now on fields
  (`telemetry.fields.<field>`); a category's switch turns all its fields off, or all but the privacy-sensitive ones
  on. A locked switch says why on its row. Older `telemetry.items` and `telemetry.groups` values keep their meaning;
  scripts that switched items through the route need the new names. See [Telemetry](docs/features/telemetry.md) and [Upgrading](docs/operating/upgrading.md#telemetry-switches-by-field).
  ([#100](https://github.com/theflywheel/lenspack/pull/100))
- **Access checks fail closed, every time.** Inside Superset, when Superset answered 404 for the plugin's access
  route even once (a pod without the plugin during a rollout, or a path prefix sending the request elsewhere), the
  server switched for good, until restart, to Superset's row-level security rules alone, with every dataset readable.
  Now any request whose access can't be checked is refused ("Your Superset access could not be checked just now"),
  and the next request asks Superset again. The old fallback is there only for a Superset still running a plugin
  without the route, as the explicit `accessFallback: rls-only` (`LENSPACK_ACCESS_FALLBACK`), with a warning at
  every start. See [When access can't be checked](docs/access/superset.md#when-access-cant-be-checked). ([#104](https://github.com/theflywheel/lenspack/pull/104))
- **Fixes from a read-only test on a real Superset 6.1.**
  - When the chat cannot change the dashboard (the `boardEdits` switch is off, or the person may not edit), the
    assistant's instructions now say so plainly, and it never offers or suggests a change ("you can remove the
    filter"). The prompt version goes to 31, so saved answers are made afresh once.
  - In a pack outside UTC, each Superset dataset whose time column has a time of day is named at start-up, in the log
    and in the settings API's `warnings`, with what to do (a date column, or a pack kept in UTC). The refusal the
    model gets for such a series says plainly that none can be drawn, so it stops trying.
  - A chart made in Superset whose metric is one plain ad hoc aggregate (`SUM(quantity)`, `COUNT(*)`,
    `COUNT(DISTINCT customer_id)`, `MIN`, `MAX`, `AVG`) is read as the pack measure that says the same, so the chat
    can answer about the tile. Its `NOT IN` filters on a dimension are read too: queries take a new filter operator,
    `not_in`, on every source.
  - The eval runner applies the Superset config's `scope:` as the server does, so evals send the filters production
    sends.

- **One name everywhere.** Once the assistant has its own name (`brand.name`), the word Lenspack shows nowhere
  people look: the admin panel, Superset's settings page and menu entry, messages and refusals, and the assistant's
  own replies (asked what it is or what it runs on, it gives only its name). The only exception is the "Powered by
  Lenspack" credit, which `brand.poweredBy` turns off. Superset's menu now follows the name set on the server, and
  `LENSPACK_PATH` in Superset's environment moves the route from `/lenspack` (for example to `/assistant`). The
  prompt version goes to 30, so saved answers are made afresh once. Update the plugin file with the server. See
  [Naming the assistant](docs/features/naming.md). ([#102](https://github.com/theflywheel/lenspack/pull/102))
- **Spend and the daily budget survive a restart inside Superset.** Every model call is now kept as one line in
  `usage.jsonl` in the state directory, and today's calls are read back at start, as the standalone server does with
  `usage:`. Before, a restart (every deploy, or a crash loop) started the day's spend at zero, so the daily budget
  could be overspent. Under a path (`/superset`), the check that the open page matches the saved dashboard after a
  chat edit now reads the dashboard below Superset's path; it did nothing there before. The docs no longer say that
  the chat on Superset receives the viewer's dashboard filters: it does not yet. ([#107](https://github.com/theflywheel/lenspack/pull/107))
- **Superset under a path.** Superset 6.1 running below a path of its host (`SUPERSET_APP_ROOT=/superset`) now
  gets the button, the chat, the settings page and its menu entry, and links to dashboards, all below that path,
  with no new setting. At the root nothing changes. Update the plugin file and the server image together. See
  [Superset under a path](docs/hosts/superset/install.md#superset-under-a-path).
  ([#99](https://github.com/theflywheel/lenspack/pull/99))
- **Inside Superset, a missing identity key no longer needs a restart.** A server that started before Superset (or
  before the plugin was loaded there) used to refuse every request until it was restarted, while `/healthz` stayed
  green. It now keeps asking Superset for the key, with backoff up to once a minute, and signs people in as soon as it
  has it. A new `GET /readyz` answers 503 until then, for a readiness probe; `/healthz` stays the liveness check. See
  [Health and shutdown](docs/operating/deploying.md#health-and-shutdown).
- **Excluded columns are not named to the model.** With `overlay.exclude`, the descriptions of Superset charts the
  assistant keeps as they are, the board notes, and filters on an excluded column no longer name the column (a map
  of excluded coordinates, a chart split or filtered by an excluded column, a filter called after it). ([#110](https://github.com/theflywheel/lenspack/pull/110))
- **After a chat edit in Superset, the open page shows the dashboard as saved, even when the reply is cut off.** A
  reply can be cut off after the change was made, for example when a phone changes networks. The chat panel now finds
  out what happened before offering Retry: "Your change was made: removed …", and the page drops the chart without a
  reload. Retry never makes a change twice. If the page still draws a chart the saved dashboard no longer has, it
  reloads, keeping the chat open and your tab. Asked about a chart that was removed, the assistant says when it was
  removed and that a reload shows the board as it is. Nothing changes in Superset: the panel comes from Lenspack. See
  [Dashboard edits](docs/features/dashboard-edits.md#when-the-reply-is-cut-off).
  ([#101](https://github.com/theflywheel/lenspack/pull/101))
- **Who is an admin, and who may use the assistant, are Lenspack's rules.** `auth.admins` says who gets the admin
  pages and `auth.users` who may use the assistant at all. Both work the same for every sign-in, Superset included,
  where they list Superset role names. Left out, nothing changes: admins are a role named `admin` (Superset's `Admin`
  role under Superset), and everyone signed in may use the assistant. Under Superset, Lenspack no longer turns the
  signed "Superset admin" flag straight into its admin role, and people the `users` rule leaves out see no Ask
  button. Personal dashboards now need Superset's right to write dashboards, and an admin deletes only dashboards
  made through Lenspack. Update `lenspack_superset.py` with the server. See [Rights](docs/access/rights.md) and
  [Upgrading in Superset](docs/hosts/superset/upgrading.md#changes-that-need-attention).
- **Saved layouts in Superset behave as expected.** Applying a layout fits it to the dashboard as it is now, so a
  chart removed in Superset is not brought back, and Undo after an apply goes back to the right version. Charts made
  in Superset that Lenspack can't redraw stay with their own dashboard: the panel says so when saving, the reply says
  how many charts a layout carried, and it suggests your own copy when most would stay behind. A new blank dashboard
  starts with a layout Superset can draw. See [Personal dashboards](docs/features/personal-dashboards.md).
  ([#97](https://github.com/theflywheel/lenspack/pull/97))
- **The quick start works as written, `lenspack sources` runs before a pack exists, and text widgets draw no
  links.** `pnpm demo` finds the data in the folder you ran it from. `lenspack sources` reads only `sources:`. A link
  in a note shows as its text, in the board app and on Superset dashboards, and a markdown block written in Superset
  keeps its text, however long. The chat's prompt changed, so saved answers from before are not reused. See
  [Boards and widgets](docs/concepts/boards.md#what-a-board-can-never-contain).
  ([#96](https://github.com/theflywheel/lenspack/pull/96))
- **Name the assistant.** A deployment can call the assistant by its own name and give its button its own label, in
  each language, from the config, the environment or the admin panel. See
  [Naming the assistant](docs/features/naming.md). ([#91](https://github.com/theflywheel/lenspack/pull/91))
- **Personal dashboards and saved layouts in Superset.** Someone who can only view a dashboard can make their own
  copy and change it through the chat, or save a layout by name and apply it later. `editScope: own` limits chat
  edits to people's own dashboards. See [Personal dashboards](docs/features/personal-dashboards.md).
  ([#89](https://github.com/theflywheel/lenspack/pull/89))
- **Chat edits work on Superset dashboards with tabs.** New charts go on the tab the person is looking at, or the one
  they name, and the layout is checked before every save. ([#94](https://github.com/theflywheel/lenspack/pull/94))
- **Usage telemetry.** One record per chat turn, a thumbs up or down under answers, and a switch for each item
  recorded. Question text, recordings and device detail start off. See [Telemetry](docs/features/telemetry.md).
  ([#86](https://github.com/theflywheel/lenspack/pull/86))
- **Superset's dashboard roles count.** With `DASHBOARD_RBAC` on, a person who opens a dashboard through its roles
  reads its data through the chat too, on that dashboard only. ([#93](https://github.com/theflywheel/lenspack/pull/93))
- **The admin panel loads under Superset's Content-Security-Policy.**
  ([#92](https://github.com/theflywheel/lenspack/pull/92))
- **Each person's Superset access is the default** (`hostPolicy: superset`), with a test suite that runs real
  Superset 6.1 and 5.0 and checks what each kind of user sees. Upgrading from an older default needs a look: see
  [Upgrading in Superset](docs/hosts/superset/upgrading.md#changes-that-need-attention).
  ([#88](https://github.com/theflywheel/lenspack/pull/88))
- **The admin panel shows the cards on its Open questions and Proposals tabs.**
  ([#90](https://github.com/theflywheel/lenspack/pull/90))
- **Open questions, definitions, the daily review and the admin panel.** Questions with two readings are logged
  for an admin to settle, definitions are added without a pack release, and an optional daily review proposes
  changes. See [Open questions and definitions](docs/features/open-questions.md).
  ([#82](https://github.com/theflywheel/lenspack/pull/82))
- **Saved answers.** A repeated question is answered again on today's data without the model, only for someone
  with the same access, and busy hours get a queue. See [Saved answers](docs/features/saved-answers.md).
  ([#85](https://github.com/theflywheel/lenspack/pull/85))
- **How this was worked out.** Under each answer: each data call in plain words, the measure behind each figure, its
  SQL and its rows. See [How this was worked out](docs/features/explain.md).
  ([#81](https://github.com/theflywheel/lenspack/pull/81))
- **Evals:** an answer of "none of them" is scored ([#84](https://github.com/theflywheel/lenspack/pull/84),
  [#87](https://github.com/theflywheel/lenspack/pull/87)); runs can apply Superset's access and run as a given
  user ([#83](https://github.com/theflywheel/lenspack/pull/83)).

### 25 November 2026

- **A reviewed turn's edits are drafts until the turn ends**, in the chat panel and in the audit log, so nothing
  half-checked is saved. ([#78](https://github.com/theflywheel/lenspack/pull/78))
- **A bad dataset column no longer stops Lenspack starting in Superset.**
  ([#77](https://github.com/theflywheel/lenspack/pull/77))
- **Superset 6.1 is supported**, alongside 5.0. See [Versions](docs/hosts/superset/versions.md).
  ([#74](https://github.com/theflywheel/lenspack/pull/74))
- **Averages over time run over the measure's own days**, and the answer says which days; a fixed edit is reported
  once. ([#70](https://github.com/theflywheel/lenspack/pull/70))
- **Calendar-date columns group by day correctly in any time zone.**
  ([#66](https://github.com/theflywheel/lenspack/pull/66))
- **Evals:** suites run with the same reviewer as production and record its cost
  ([#67](https://github.com/theflywheel/lenspack/pull/67)); `--reviewer` and `--escalate` pick those models
  ([#69](https://github.com/theflywheel/lenspack/pull/69)); more ways of writing numbers are read
  ([#68](https://github.com/theflywheel/lenspack/pull/68), [#79](https://github.com/theflywheel/lenspack/pull/79)); a
  turn the database failed counts as an error ([#73](https://github.com/theflywheel/lenspack/pull/73)); question
  sets for the registry example data ([#72](https://github.com/theflywheel/lenspack/pull/72)); the speech-to-text
  benchmark runs from the repository ([#71](https://github.com/theflywheel/lenspack/pull/71)).

### 24 November 2026

- **Numbers:** a ratio keeps its empty days, one rule decides what may be added up, and a cut-off result says so.
  ([#65](https://github.com/theflywheel/lenspack/pull/65))
- **The model sees only what the person asking may see**, and a widget update can clear a field.
  ([#64](https://github.com/theflywheel/lenspack/pull/64))
- **`lenspack-mcp` is safer by default:** read-only data, no file access from SQL, and HTTP on this machine only
  unless a token is set. ([#62](https://github.com/theflywheel/lenspack/pull/62))
- **In Superset, a signed right only works on the dashboard it was signed for.**
  ([#63](https://github.com/theflywheel/lenspack/pull/63))
- **Edits are saved all together or not at all**, and a KPI's summary of a series is a compute step.
  ([#61](https://github.com/theflywheel/lenspack/pull/61))
- **The packages sit in folders by job** (kernel, sources, packs, hosts), and the pack loader `@lenspack/spec` is
  now `@lenspack/pack`. Code that imports it needs the new name: see
  [Upgrading](docs/operating/upgrading.md#code-using-the-packages).
  ([#60](https://github.com/theflywheel/lenspack/pull/60))
- **The Superset dashboard's own filter bar becomes board filters** the chat can read and change.
  ([#59](https://github.com/theflywheel/lenspack/pull/59))
- **A problem the reviewer finds is fixed, or the change is undone, before the reply.**
  ([#58](https://github.com/theflywheel/lenspack/pull/58))
- **The compute step:** rates, changes, rolling averages and averages per day over simple measures, worked out
  after the source answers ([#55](https://github.com/theflywheel/lenspack/pull/55)); summaries per group save as
  Superset pivot tables that agree with the chat ([#57](https://github.com/theflywheel/lenspack/pull/57)). See
  [The compute step](docs/features/compute.md).
- **One policy package decides access** for every host, and Superset's roles and row-level security go through it.
  ([#54](https://github.com/theflywheel/lenspack/pull/54), [#56](https://github.com/theflywheel/lenspack/pull/56))
- **Replies keep to the writing systems the person used or picked**, and Portuguese replies keep the data's own terms.
  ([#53](https://github.com/theflywheel/lenspack/pull/53), [#48](https://github.com/theflywheel/lenspack/pull/48))
- **One server runtime for the standalone server and Superset**, with the Superset plugin kept in this repository.
  ([#50](https://github.com/theflywheel/lenspack/pull/50), [#51](https://github.com/theflywheel/lenspack/pull/51))
- **The board tools are their own package**, and `lenspack-mcp` is only the MCP server; its built package exports
  the tools again. ([#45](https://github.com/theflywheel/lenspack/pull/45),
  [#52](https://github.com/theflywheel/lenspack/pull/52))
- **Portuguese in the Superset chat panel.** ([#39](https://github.com/theflywheel/lenspack/pull/39))
- **Sign-in for the standalone server:** a password by default, OIDC, roles, and pack access rules.
  See [Sign-in](docs/access/sign-in.md). ([#13](https://github.com/theflywheel/lenspack/pull/13))
- **Apache Superset as a host:** its datasets as the source, its dashboards as boards, and the chat on every dashboard.
  See [Apache Superset](docs/hosts/superset/README.md). ([#16](https://github.com/theflywheel/lenspack/pull/16)) It
  brought these with it:
  - **Voice.** A mic in the chat panel: click or hold it to talk, or hold Space, even while typing. The audio is turned
    into text on the server, which keeps the key, and the text lands in the input to check before sending. See
    [Voice](docs/features/voice.md). ([#17](https://github.com/theflywheel/lenspack/pull/17),
    [#21](https://github.com/theflywheel/lenspack/pull/21))
  - **French and Hindi** beside English in the chat panel, with a language menu, and suggested questions written in each
    language. See [Languages](docs/features/languages.md). ([#17](https://github.com/theflywheel/lenspack/pull/17),
    [#21](https://github.com/theflywheel/lenspack/pull/21), [#26](https://github.com/theflywheel/lenspack/pull/26))
  - **Heatmaps:** one measure over two dimensions as a grid of shaded cells, drawn the same under every chart library
    and saved as Superset's own heatmap. See [Heatmaps](docs/features/charts.md#heatmaps).
    ([#24](https://github.com/theflywheel/lenspack/pull/24))
  - **Maps:** a pack can say where an entity's rows are (`geo: { lat, lon }`), a `points` query lists them and a `map`
    chart draws them, with no tile server unless you add one. In Superset a map is a deck.gl scatter chart. See
    [Maps](docs/features/charts.md#maps). ([#31](https://github.com/theflywheel/lenspack/pull/31))
  - **Feature switches:** turn parts of the assistant off for a deployment (the mic, the language menu, board edits,
    heatmaps, maps, the reviewer and more) from the config, `LENSPACK_FEATURES` or the settings page. Every switch
    starts on. See [Feature switches](docs/operating/switches.md).
    ([#34](https://github.com/theflywheel/lenspack/pull/34))
  - **Storage resilience:** with a full or read-only disk, dashboards still open and answer, a settings change is
    refused with `503` and changes nothing, and files are written whole so a crash never leaves half a file. Query
    errors no longer show the deployment's host names and ports. See
    [When Lenspack cannot save](docs/hosts/superset/settings.md#when-lenspack-cannot-save).
    ([#35](https://github.com/theflywheel/lenspack/pull/35))
  - **The chat survives a Lenspack restart:** the button waits in a "Reconnecting" state and comes back by itself, and
    an answer cut off by the restart offers Retry. ([#32](https://github.com/theflywheel/lenspack/pull/32),
    [#33](https://github.com/theflywheel/lenspack/pull/33))
  - **Superset says who is asking.** Edits follow Superset's dashboard rights, people who can only view a dashboard can
    still ask questions, Lenspack makes its own Superset account, and every turn goes in an audit log. See
    [Who is asking](docs/hosts/superset/identity.md). ([#29](https://github.com/theflywheel/lenspack/pull/29))
  - **Each answer's cost** under the reply, speech to text included, and recent turns with their cost for admins. See
    [Costs and budgets](docs/operating/costs.md). ([#38](https://github.com/theflywheel/lenspack/pull/38))
  - **Evals:** `pnpm eval:suite` scores answers against figures worked out once in SQL, and a benchmark compares
    speech-to-text models. See [Evals](docs/reference/evals.md).
    ([#20](https://github.com/theflywheel/lenspack/pull/20), [#19](https://github.com/theflywheel/lenspack/pull/19))
- **Tables page and sort, text widgets take formatting, and replies carry their cost.**
  ([#36](https://github.com/theflywheel/lenspack/pull/36))
- **Cleanups with no change in behaviour:** shared helpers and dead code out across the kernel, the engine, the
  React components, the examples, the server and the importers; the demo is the app only.
  ([#40](https://github.com/theflywheel/lenspack/pull/40), [#41](https://github.com/theflywheel/lenspack/pull/41),
  [#42](https://github.com/theflywheel/lenspack/pull/42), [#43](https://github.com/theflywheel/lenspack/pull/43),
  [#44](https://github.com/theflywheel/lenspack/pull/44), [#46](https://github.com/theflywheel/lenspack/pull/46),
  [#47](https://github.com/theflywheel/lenspack/pull/47), [#49](https://github.com/theflywheel/lenspack/pull/49))

### 23 November 2026

- **Widgets added one at a time line up as a batch would.** On a packed board (`grid.fill`), three KPIs asked for one by
  one now make one row. A widget that grows pushes what it now covers down instead of overlapping it. Boards gain an
  optional layout field, `fw`; stored boards without it are unchanged.
  ([#18](https://github.com/theflywheel/lenspack/pull/18))
- **"Move X after Y" moves X.** X goes beside Y, and Y's row makes room if it can; otherwise X starts a new row straight
  after Y's. A move that changes nothing is an error instead of a false success, and `below:<id>` places a widget on a
  new row under another. A resize keeps its row together, board reads wait for edits still in the queue, and a turn
  stopped by the step limit still replies. See [Dashboard edits](docs/features/dashboard-edits.md).
  ([#22](https://github.com/theflywheel/lenspack/pull/22))
- **Layout notes give widths in words and columns, and row numbers,** so replies describe the board correctly. The
  assistant never addresses the person by name. ([#27](https://github.com/theflywheel/lenspack/pull/27))

### 16 November 2026

Sources:

- **A SQL source is a connection URL, and its scheme picks the driver:** Postgres, DuckDB, SQLite, MySQL, MariaDB and
  ClickHouse. Every driver is read-only, runs exactly one statement, stops at a timeout and refuses a result over its
  row cap. MySQL, MariaDB and SQLite have no percentiles, so `median` and `p90` are refused there. See
  [SQL databases](docs/sources/sql.md). ([#2](https://github.com/theflywheel/lenspack/pull/2),
  [#9](https://github.com/theflywheel/lenspack/pull/9))
- **Needs a look on upgrade:** a `{ kind: duckdb, path }` source is now opened read-only, like every source, so keep the
  board store in a different file. `kind:` is still accepted beside `url:` and must agree with it. On DuckDB, ids with
  `_` in a subtree tenant or filter, and `contains` filters on values with `%` or `_`, now match as they do on Postgres.
  ([#2](https://github.com/theflywheel/lenspack/pull/2), [#9](https://github.com/theflywheel/lenspack/pull/9))
- **ClickHouse settings are pinned for each session**, resource limits can go in the URL, statements in flight are
  capped, and its errors are readable. See [ClickHouse](docs/sources/sql.md#clickhouse).
  ([#9](https://github.com/theflywheel/lenspack/pull/9))
- **An optional query cache per source** (`cacheTtlMs`) answers a repeated statement from memory.
  ([#9](https://github.com/theflywheel/lenspack/pull/9))

Packs and questions:

- **Two-stage measures** (`per`): one value per key, then an aggregate over those, such as the median items per order.
  See [Measures](docs/concepts/measures.md#other-kinds-of-measure).
  ([#9](https://github.com/theflywheel/lenspack/pull/9))
- **Breakdowns take `compare`, `share` and `other`:** each group beside the period before, its share of the whole, and
  one row for everything outside the top groups. See [Queries](docs/concepts/queries.md).
  ([#9](https://github.com/theflywheel/lenspack/pull/9))
- **Calendar periods and the pack's time zone.** A time range can be "this month" or "last week", and series buckets cut
  at local midnight, Monday and the first of the month when the pack sets `timeZone`. MySQL and SQLite refuse a series
  in any zone but UTC. See [Dimensions](docs/concepts/dimensions.md#time).
  ([#9](https://github.com/theflywheel/lenspack/pull/9))
- **Clearer refusals:** a filter that cannot narrow every counted part of a measure is refused instead of applied to
  some of it, and an answer says what it leaves out. ([#9](https://github.com/theflywheel/lenspack/pull/9))
- **The model's tools** take named and absolute periods, a filters string, a breakdown split, a lookup of a dimension's
  values, and partial widget updates; an empty answer suggests the value the data has. **Changed for MCP clients:** the
  query tool's `total` is now `records`, the number of records behind the rows shown.
  ([#9](https://github.com/theflywheel/lenspack/pull/9))

The server:

- **Model adapters:** `openai-compatible` and `anthropic`, with prompt caching and a reasoning effort per turn. See
  [Chat models](docs/operating/models.md). ([#9](https://github.com/theflywheel/lenspack/pull/9))
- **Every model call is metered**, with an optional daily budget checked before each call and a usage report at
  `/api/_usage`. See [Costs and budgets](docs/operating/costs.md).
  ([#9](https://github.com/theflywheel/lenspack/pull/9))
- **Boards have owners.** A board someone makes is hidden until they share it, others may save a copy, and a pack's own
  boards need the maintain right to change. Each pack keeps its boards apart, so packs sharing a database no longer see
  each other's. See [Rights](docs/access/rights.md#boards-have-owners).
  ([#9](https://github.com/theflywheel/lenspack/pull/9))
- **Needs action on upgrade:** a SQL board store made by 0.1.0 is refused at start. Rename `lenspack_boards` and
  `lenspack_board_versions` aside; the boards from board files are made again, and boards people made stay in the old
  tables. ([#9](https://github.com/theflywheel/lenspack/pull/9))
- **The chat sees what the person changed by hand** since the last turn, follows the pack's description and rules, and
  runs at most three build-and-review rounds per turn. ([#9](https://github.com/theflywheel/lenspack/pull/9))
- **Restore a board from the chat:** "start over" or "undo my last change" returns the board to where it began or to an
  earlier version, saved as a new version so it can be undone too. See
  [Versions and undo](docs/features/dashboard-edits.md#versions-and-undo).
  ([#10](https://github.com/theflywheel/lenspack/pull/10))

The board app and the image:

- **The board app:** the boards open at `/` without the demo's extras, `ui.intro` adds a deployment's own intro, and a
  profile menu has light and dark themes, sign-out, a page of metrics and a page of AI usage. Widgets can be dragged,
  resized and removed with undo; the chat can be resized and hidden, and its replies show formatting. Chart tooltips are
  readable, series have a real time axis, and pie slices show their counts. See [The board
  app](docs/hosts/serve.md#the-board-app). ([#9](https://github.com/theflywheel/lenspack/pull/9))
- **A container image,** `ghcr.io/theflywheel/lenspack`, built from the main branch only and tagged with the short
  commit hash and `latest`. See [Deploying](docs/operating/deploying.md#the-image).
  ([#9](https://github.com/theflywheel/lenspack/pull/9))

### 29 September to 2 October 2026

- **Elasticsearch and OpenSearch as a source**, beside SQL. Packs gain field paths,
  structured filters and epoch time units for it. See [Elasticsearch](docs/sources/elasticsearch.md).
  ([4e62129](https://github.com/theflywheel/lenspack/commit/4e62129))
- **The `lenspack` command:** `serve` runs a server over the sources a `lenspack.yaml` names, with secrets only as
  `env:` references; `check` draws every board and fails on any error; `sources` lists what each source holds. See
  [Command line](docs/reference/cli.md) and [The standalone server](docs/hosts/serve.md).
  ([ed1b697](https://github.com/theflywheel/lenspack/commit/ed1b697))
- **Callers, row scope, edit rights and an audit trail.** The deployment says who a caller is; their scope narrows every
  query, and a query the scope cannot reach is refused rather than answered in full. Viewers cannot change boards, and
  each change, refusal and denial is logged with the user. With no sign-in set, the server listens on this machine only.
  See [Row scope and tenancy](docs/access/scope-and-tenancy.md).
  ([f90b7c8](https://github.com/theflywheel/lenspack/commit/f90b7c8))
- **Measures built from measures:** a `derived` measure is arithmetic over other measures, which may live on different
  entities. A widget can show several measures over the same groups, as table columns, chart series or lines under a
  KPI. See [Measures](docs/concepts/measures.md#other-kinds-of-measure).
  ([e50b071](https://github.com/theflywheel/lenspack/commit/e50b071),
  [872fd3d](https://github.com/theflywheel/lenspack/commit/872fd3d))
- **Hierarchies and drill-down.** A pack declares dimensions that nest; a click on a bar, slice or row steps one level
  down, and a breadcrumb goes back up. A `levels` measure keeps one number per level. See
  [Hierarchies](docs/concepts/dimensions.md#hierarchies).
  ([78b36f9](https://github.com/theflywheel/lenspack/commit/78b36f9),
  [0469df9](https://github.com/theflywheel/lenspack/commit/0469df9))
- **More breakdowns:** a second dimension for stacked and grouped bars, ordering by the group itself, larger limits, and
  tenants that read everything under them (`match: subtree`). A board's date range filter sets the window of the widgets
  it covers. See [Filters](docs/concepts/filters.md).
  ([eac254e](https://github.com/theflywheel/lenspack/commit/eac254e),
  [f580f70](https://github.com/theflywheel/lenspack/commit/f580f70))
- **Importers** that compile DIGIT DSS chart configs and CCRS analytics KPI catalogues into a pack and boards, with a
  report of what did not translate. See [Importers](docs/extending/importers.md).
  ([f492787](https://github.com/theflywheel/lenspack/commit/f492787),
  [f580f70](https://github.com/theflywheel/lenspack/commit/f580f70))
- **Packages can be published to GitHub Packages** as `@theflywheel/lenspack-<name>` when a version is tagged; the
  source keeps the `@lenspack/*` names. See [Packages](docs/reference/packages.md#installing-from-github-packages).
  ([#1](https://github.com/theflywheel/lenspack/pull/1))

### 22 to 28 September 2026

- **Chart libraries are adapters:** svg, Recharts, ECharts and shadcn draw the same board, chosen at run time. See
  [React](docs/hosts/react.md#chart-libraries-are-adapters).
  ([afe3777](https://github.com/theflywheel/lenspack/commit/afe3777))
- **A chat that edits the board,** with any OpenAI-compatible model and a choice of model in the chat.
  ([32e61ad](https://github.com/theflywheel/lenspack/commit/32e61ad),
  [1a8c0fe](https://github.com/theflywheel/lenspack/commit/1a8c0fe))
- **The reviewer:** a second model checks each turn's changes against the request, and the builder gets a round to fix
  what it finds. Builder, reviewer and fix-round models can differ. See
  [The reviewer](docs/features/dashboard-edits.md#the-reviewer) and [Roles](docs/operating/models.md#roles).
  ([bfeb56c](https://github.com/theflywheel/lenspack/commit/bfeb56c),
  [574ed83](https://github.com/theflywheel/lenspack/commit/574ed83))
- **Edits are checked before the reply:** a failed tool call comes back with its reason, edits in one step apply in
  order, and the chat never says "saved" for a change that did not apply.
  ([5235d2c](https://github.com/theflywheel/lenspack/commit/5235d2c))
- **Compact and packed layouts** (`grid.density`, `grid.fill`). See [Board reference](docs/reference/board.md).
  ([5235d2c](https://github.com/theflywheel/lenspack/commit/5235d2c))
- **Awkward schemas:** an entity's time can be an expression (such as epoch milliseconds), and an entity can carry a
  filter applied to every query (such as leaving out soft-deleted rows).
- **Board-building evals** score models on editing tasks. See [Evals](docs/reference/evals.md).
  ([1a8c0fe](https://github.com/theflywheel/lenspack/commit/1a8c0fe))
- **Smaller fixes:** the chat stays connected behind proxies while the reviewer works, boards fit a phone screen, and
  chart axes no longer clip their labels. ([416c456](https://github.com/theflywheel/lenspack/commit/416c456),
  [d3f8ffe](https://github.com/theflywheel/lenspack/commit/d3f8ffe))

## 0.1.0 (22 September 2026)

The first version: the board as data, a closed query format with four shapes (value, breakdown, series, rows), eight
edit operations, packs, the compiler for Postgres and DuckDB, the board tools with the `lenspack-mcp` MCP server, the
React components, and four example packs.
