# How access is tested

This page describes the test suite that proves what each kind of user can see and change inside Superset, and how to
run it. It is for security reviewers and contributors changing anything near access.

The access suite starts real Superset 6.1 and 5.0, each with a Postgres database of sample data and Lenspack in front of
it, and checks what each kind of user can see and change. It goes through Superset's own sign-in and its `/lenspack`
route, the way a browser does. The chat runs on a stand-in model that calls exactly the tool it is told to, so the suite
checks what the tools and routes let through, not what a model says. Nothing paid is called.

## Who is in it

| user | Superset roles | what Superset lets them do |
|---|---|---|
| `lp_admin` | Admin | everything |
| `lp_owner` | Gamma, both datasets | owns dashboard A, so may edit it |
| `lp_viewer` | Gamma, both datasets | views A, may not edit it |
| `lp_partial` | Gamma, `visits` only | no access to `stock` |
| `lp_north` | Gamma, both datasets | row-level security (RLS) `region = 'North'` on both datasets |
| `lp_inlist` | Gamma, both datasets | RLS `region IN ('North', 'East')` on `visits` |
| `lp_complex` | Gamma, both datasets | RLS `region LIKE 'N%'` on `visits`, which Lenspack can't translate |
| `lp_templ` | Gamma, both datasets | RLS `team = '{{ current_username() }}'` on `visits` |
| `lp_rbac` | Gamma and the roles of dashboards B and C | opens B and C through their dashboard roles, reads no dataset; RLS `region IN ('North', 'South')` on `stock` through B's role |
| `lp_rbac_off` | the same as `lp_rbac` | used only while dashboard roles are turned off |
| `lp_noroles` | none | signs in, nothing else |
| `lp_lensadmin` | Gamma, `visits` only, and a role called "Lenspack admin" with no permissions | no access to `stock`; an admin in Lenspack only once its `admins` rule names that role |
| `lp_lensuser` | Gamma, both datasets, and a role called "Lenspack user" with no permissions | views A; let in by Lenspack's `users` rule when it names that role |
| `lp_reader` | a copy of Gamma without `can_write` on Dashboard or Chart, both datasets | views dashboards, may not make or change any |
| `lp_alpha` | Alpha | reads every dataset and may make dashboards |

Dashboard A holds a chart of each dataset and has no dashboard roles. Dashboard B holds a stock chart and C a visits
chart; each opens only for its dashboard role (`DASHBOARD_RBAC`). The suite can turn `DASHBOARD_RBAC` off without
restarting Superset. Every number in the sample data is a different power of two, so a total shows exactly which rows
were counted.

## What each case proves

- **The default.** Lenspack started with no `hostPolicy` applies each user's Superset access.
- **Viewing.**
  - On a dashboard the user can't open, the chat and every board route answer 403. Superset refuses it first, and
    Lenspack refuses it again for a request Superset signed as "may not view".
  - A dashboard role opens its dashboard for its members only.
  - Binding (`/_superset/bind`) works only for a dashboard the user may open.
  - The boards list and the dashboards list name only dashboards the user may open.
  - A request signed for dashboard A and sent for dashboard B gets 403.
  - A missing, tampered, wrongly keyed, expired or future identity gets 401.
  - Paths with `..`, encoded dots or encoded slashes get 400, from Superset and from Lenspack.
- **Editing.**
  - The owner can edit, through the board API and the chat.
  - A viewer can't. The board API answers 403, and the chat's edit tools answer "you can view this dashboard but not
    edit it in Superset". Nothing changes in Superset.
  - An admin can edit a dashboard they don't own.
  - With the `boardEdits` switch off, nobody can, admins included.
- **Data.**
  - A dataset the user may not read is missing from the catalogue, the chat's `list_metrics` and the entity list, and
    every query on it is refused with "your Superset access doesn't include it". A measure that isn't in the pack keeps
    the pack's own message.
  - RLS narrows chat queries, filter menus and board widgets to the exact rows expected for each user, and a user's own
    filter never widens them.
  - The `LIKE` rule keeps `visits` from `lp_complex` entirely. The templated rule is rendered by Superset and narrows
    `lp_templ` to their own team's rows.
  - A user who may read nothing is told so before any model is asked.
  - While Lenspack can't reach Superset, a user it hasn't checked yet sees nothing. Once Superset is back, they see
    their data again.
- **Dashboard roles.**
  - On B, `lp_rbac` (no dataset access) gets B's stock data through the chat, the board and the filter menu: the same
    rows Superset's own chart data API serves them for B's chart, with B's role's RLS applied. A filter of their own
    never widens it.
  - Stock on C, visits on B, the list of everything they can ask about, and a compiled query outside a dashboard are all
    refused. Superset refuses B's chart asked for as if it were on C.
  - A saved answer `lp_rbac` gets on B is never given to an admin on B, to `lp_rbac` on C, or to a viewer on A.
  - With `DASHBOARD_RBAC` off, B no longer opens for them, Superset refuses its chart data, and Lenspack shows none of
    B's data even on a request signed as able to view B.
  - A personal copy of B does not carry B's dashboard-role access: stock is refused on it.
- **Personal dashboards and saved layouts.**
  - A viewer may create a personal dashboard, and copy one they can open.
  - A user may delete only their own personal dashboard. An admin may delete another person's, but not a dashboard
    that wasn't made through Lenspack: that stays its owners' to delete, in Superset.
  - A saved layout applies only to dashboards the user controls.
  - Another user's personal dashboard is neither listed, opened nor edited.
  - With `editScope: own`, the chat changes only people's own dashboards; admins are exempt unless told otherwise.
  - `lp_reader`, whose role can't write dashboards, is offered no create or copy. Making, copying (through the routes
    or the chat) and applying a layout are refused with the reason. Saving a layout, which writes nothing to Superset,
    still works. `lp_alpha` makes, copies and deletes its own. (Stock Gamma may write dashboards, so the refusal is
    tested with a viewer role made from Gamma without that permission.)
  - The suite leaves no personal dashboards behind.
- **Admin surfaces.** Under the default `admins` rule, settings, the admin panel, the audit log, cost per answer and
  usage are for Superset admins only. A dashboard owner gets 403, and so does Superset's own AI assistant page. So
  does `lp_lensadmin`: a role called "Lenspack admin" gives nothing until the rule names it.
- **Lenspack's own admins rule.** The suite restarts Lenspack with `auth: { admins: ["Lenspack admin"] }`.
  - `lp_admin`, a Superset Admin without that role, gets 403 from the admin panel, the settings, the audit log, cost
    per answer, usage, everyone's personal dashboards and every settings change, and Superset's own AI assistant page
    refuses them. Their dashboards and data are unchanged.
  - `lp_lensadmin`, a Gamma user with that role, gets all of those (Superset's AI assistant page, which lists
    Superset's databases, stays a Superset Admin's). Their data stays exactly `lp_partial`'s: the same catalogue,
    `stock` refused, the same boards, no edit on dashboard A, and no deleting it.
- **Lenspack switched on per person.** The suite restarts Lenspack again, with `auth: { users: ["Lenspack user"] }`.
  - `lp_viewer`, without the role, is served an overlay script that draws nothing (no button), and every chat, board
    and data route, the personal dashboards' routes and binding answer 403 "isn't turned on for your account".
  - `lp_lensuser`, with the role, gets the real overlay, their board and correct chat answers, and still can't edit
    dashboard A.
  - `lp_admin`, an admin without the role, gets the overlay, the chat and the settings.
- **Caching and saved answers.**
  - Two users with different RLS asking the same question, twice in a row, each get their own correct answer.
  - Five users with different access (all datasets, `visits` only, North only, North and East, their own team) ask the
    same question. Nobody is answered from another's saved answer: not when the same question comes again within minutes
    (sent as saved, no model), not when the saved queries run again on fresh data, and not when the question names
    another region (the region swapped into the saved queries). Each answer has exactly that user's rows.

These cases check outcomes, not how Lenspack gets them. They keep holding when queries move to running as the user
inside Superset. The `LIKE` case would then get stronger: Superset would apply the rule itself, so `lp_complex` would
see the North rows instead of no `visits` at all.

## Running it

```sh
pnpm install
pnpm test:access                 # Superset 6.1 and 5.0, and 6.1 under /superset, side by side
pnpm test:access superset-5.0    # one version
pnpm test:access app-root        # only Superset 6.1 under /superset
```

The `app-root` file runs Superset 6.1 below a path of its host (`SUPERSET_APP_ROOT=/superset`). It checks that the
button script, the chat, the links to dashboards, the settings page, its redirects and the menu entry all stay below
`/superset` (see [Superset under a path](../hosts/superset/install.md#superset-under-a-path)).

It needs Linux with Docker. Superset runs in the host's network and listens on 127.0.0.1 only. The first run pulls
`apache/superset:6.1.0`, `apache/superset:5.0.0` and `postgres:16-alpine`, and each Superset installs the Postgres
driver for the sample data. The secret key and passwords are made fresh for each run and never printed. The containers,
their volumes and the temporary folder are removed at the end, whether the cases pass or fail. If a run is killed,
`docker rm -f -v $(docker ps -aq --filter label=lenspack-access-suite)` clears what is left.

CI runs it on every pull request, in its own job beside the unit tests. The suite is in
[packages/hosts/superset/test-access](../../packages/hosts/superset/test-access): `stack.ts` starts everything,
`fixtures.py` makes the users, roles, rules and dashboards, `cases.ts` holds the cases, and
`superset-6.1-app-root.access.test.ts` holds the cases under a path.

## The other tests

- **Policy.** `packages/kernel/policy/test` checks `decide()`, `boardRights()` and the admin rights as pure functions.
- **The standalone server.** Its tests sign in with each kind (password, OpenID Connect against a stand-in provider,
  proxy, tokens) and check rights, pack rules, hidden keys and scope on every route.
- **Saved answers.** Their tests check that an answer is never given across access scopes.

---

**Next:** [Evals](../reference/evals.md).

**Related:** [Access inside Superset](superset.md) · [Who sees what](README.md) · [Evals](../reference/evals.md)
