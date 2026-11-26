# Access inside Superset

This page explains what each person sees when Lenspack runs inside Superset: how their dataset access, row-level
security and dashboard rights carry over, what happens when Lenspack cannot tell, and the one setting that turns it
off. It is for Superset admins and security reviewers.

## The rule

Lenspack reads data through its own Superset account, an Admin. By default (`hostPolicy: superset`) it narrows every
answer to what the person asking may see in Superset: their own dataset permissions and row-level security (RLS),
and the dashboards they may open. **When it cannot tell, it shows less, never more.**

So Lenspack hides from each person the datasets and dashboards Superset hides from them, and adds their row-level
security rules to every query. It uses the same rules as every other host (see
[Who sees what](README.md#how-the-layers-combine)).

`hostPolicy` is `superset` by default. A deployment upgraded from a release that defaulted to `off` should read
[Upgrading](../hosts/superset/upgrading.md#changes-that-need-attention).

## What each user sees

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
- **Dashboards.** The dashboards list (`/_superset/dashboards`) and the boards list (`GET /api/<pack>`) show only the
  dashboards the user may open in Superset (owners, admins, dashboard roles with `DASHBOARD_RBAC`, or access to one of
  its datasets). The dashboard a request is about is still checked on every request (see [Who is
  asking](../hosts/superset/identity.md)).
- **Dashboard roles.** With `DASHBOARD_RBAC` on, a user who opens a dashboard through its dashboard roles can ask
  about the data of that dashboard's charts there, with their RLS, as Superset shows it to them, and nowhere else.
  See [Dashboard roles](#dashboard-roles-dashboard_rbac) below.
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

## Dashboard roles (DASHBOARD_RBAC)

Superset can give a dashboard its own roles (the `DASHBOARD_RBAC` feature flag). A user in one of those roles can open
the dashboard and see its charts, even without access to the datasets behind them. Lenspack follows the same rule, as
Superset decides it:

- **On that dashboard**, the user can ask about the data of the dashboard's charts: the chat, the board's own data and
  its filter menus read those datasets for them. Row-level security still applies, as it does in Superset, so they get
  the same rows the dashboard's charts show them.
- **Only the datasets behind the dashboard's charts.** A dataset that only a dashboard filter reads is not opened:
  Superset lets that filter list its values, and nothing more.
- **Nowhere else.** On another dashboard, in the list of everything they can ask about, and in compiled queries outside
  a dashboard, those datasets stay closed to them, with the usual "your Superset access doesn't include it".
- **Who counts.** Superset's own check decides: dashboard roles must be on and the dashboard must have roles; the user
  must be in one of them and the dashboard published, or be its owner, or an admin.
- **Saved answers** made on a dashboard this way are kept apart: they are never used on another dashboard, or for a user
  who reads the dashboard's data some other way.
- **When Lenspack can't tell**, nothing opens. If Superset can't be asked, or its plugin is older than this change, a
  dashboard role opens the dashboard but none of its data in the chat. With `DASHBOARD_RBAC` off, Superset grants
  nothing through a dashboard, and neither does Lenspack.

Superset 5.0 and 6.1 grant the same here. 6.1 also lets a dashboard's users drill into its data (drill to detail, drill
by); that reads the same datasets, so it adds nothing to the list. The plugin asks Superset's own check
(`raise_for_access`, for one of the dashboard's charts) as the user, so a Superset change to the rule follows by itself.

## Admins and roles

The roles in the identity header also become the user's roles in Lenspack's policy, beside `admin` for a Superset
admin. A Superset role literally named `admin` grants nothing here; Lenspack's admin comes from the signed admin flag.
What a Superset dashboard shows natively is unchanged: Superset applies its own security there. Who may edit and
administer is in [Who is asking](../hosts/superset/identity.md).

## Turning it off: `hostPolicy: off`

`hostPolicy: off` (or `LENSPACK_HOST_POLICY=off`) is still there, as an explicit choice. Every answer then uses
the service account's access. **Anyone signed in to Superset can read every dataset listed in `datasets:` in full,
with no row-level security, even datasets Superset keeps from them**, through the chat, the filter menus and the
board API, on any dashboard they can open. Lenspack prints a warning saying so at every start. Use it only when
everyone who can sign in to Superset may see all of those datasets in full.

## Planned: Superset runs each query as the person

Today Lenspack asks Superset what each person may see and applies it itself. **Planned:** each query runs as the
person asking, through Superset's own security, so Superset applies its rules
directly, and edits appear in Superset's history under the person's name. The access suite checks outcomes rather
than mechanics so that its cases keep holding after this change; the `LIKE` case would get stronger, as Superset would
apply that rule itself.

---

**Next:** [Operating Lenspack](../operating/README.md).

**Related:** [Who is asking](../hosts/superset/identity.md) · [Row scope and tenancy](scope-and-tenancy.md) ·
[Saved answers](../features/saved-answers.md)
