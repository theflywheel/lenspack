# Sign-in, roles and pack access

Who may sign in, what they may do in the app, and what of each pack's data they may see.

## Sign-in

`auth.kind` in `lenspack.yaml` picks the sign-in; the environment variable `LENSPACK_AUTH` overrides it (`LENSPACK_AUTH=none` for a quick local look). With neither, it is `password`. Every kind ends in the same principal: a user, their roles, and the rights below. The rights and the pack rules work the same whichever kind named the caller.

| kind | who the caller is | roles from |
|---|---|---|
| `password` (default) | the one built-in user, `admin`, with a password | `admin` |
| `oidc` | lenspack signs people in with an OpenID Connect provider (Keycloak, Entra ID, any issuer with discovery) | claims in the ID token |
| `proxy` | a login proxy in front names the user in a header, believed only with the proxy's shared secret | a header (`rolesHeader`), comma-separated |
| `tokens` | bearer tokens the deployment issues | `roles:` per token |
| `none` | open, for a local demo; listens on 127.0.0.1 unless `host:` says otherwise (opened by `LENSPACK_AUTH`, only `--host` moves it, so in a container pass `--host 0.0.0.0` too) | none: the one local user sees everything |

Superset mode (`lenspack superset`) takes none of these kinds: Superset signs who is asking on every request, and that signed identity, with Superset's own dashboard rights, is the only sign-in there. It is an adapter of its own kind, `superset`, which gives a Superset admin the role `admin`. By default (`hostPolicy: superset`) it also brings each user's Superset roles, dataset access, row-level security and the dashboards they may open (see [How the layers combine](#how-the-layers-combine)). See [packages/hosts/superset/README.md](../packages/hosts/superset/README.md).

### `password`

For a deployment with no identity provider. There is one user, `admin`, with every right (editor, maintainer, usage) and the role `admin`, which pack rules can match. lenspack keeps no other users and has no user management: for named people, use `oidc` or a login proxy.

```yaml
auth:
  kind: password            # the default; the block can be left out
  sessionHours: 8           # default 8
  baseUrl: https://lens.example.com   # optional: the address people use; see below
  dir: /var/lib/lenspack    # default LENSPACK_STATE_DIR, else .lenspack next to lenspack.yaml (relative: from lenspack.yaml's folder)
```

The password comes from the block if it names one (`password: env:NAME` or `passwordHash:`), else from the environment:

1. `LENSPACK_ADMIN_PASSWORD`, at least 12 characters;
2. `LENSPACK_ADMIN_PASSWORD_HASH`, a scrypt hash. `read -rs P; printf %s "$P" | lenspack hash-password` prints one without the password reaching the shell history. A password, where both are set, wins over a hash;
3. neither: at first start lenspack makes a random password, keeps only its hash in `<dir>/admin-password.hash`, and writes the password once to `<dir>/admin-password.txt`. Both files are readable by the server's user only (0600), and the folder gets a `.gitignore` so it is not committed with the config. The log names the file, never the password. Read it, then delete the file; it is not written again. To start over, delete the hash file.

lenspack refuses a state folder that is a link or writable by everyone, and a state file that is a link, belongs to another user or is writable by anyone else. A folder shared with a group (a Kubernetes volume with `fsGroup`) is fine. With `LENSPACK_ADMIN_PASSWORD` and `sessionSecret` both set, no folder is needed. The session cookie is signed with a key kept in `<dir>/session.key` (or `sessionSecret:`). A new password ends every session made with the old one. Several replicas need the same `<dir>` (or the same password and `sessionSecret`), or a session from one is unknown to the others; replicas starting together on one folder agree on a single made password.

Sign-in is a form at `GET /auth/login`; `GET /auth/logout` signs out. Every try counts as a failure until the password checks out, so a burst sent at once is counted too. After five failures, each further try waits longer (1 s, doubling, at most 15 minutes); failures are forgotten after an hour without one. A caller is its address (an IPv6 /64), or, once it has signed in from that browser, a long-lived signed device cookie. Behind a reverse proxy every caller shares the proxy's address: an attacker there holds up the address, not the admin's own browser, and a success does not clear an address's failures. Callers without a device cookie also share a budget of 100 failures in 10 minutes, and only a few of their passwords are checked at a time; a known browser is held up by neither. So while someone is guessing, a browser that has never signed in (a new one, or after cookies are cleared) may have to wait.

A change request must come from the server's own address: `baseUrl` when set (which also marks the cookie `Secure` on https), else the `Host` the request was sent to, or the `X-Forwarded-Host` a proxy set. Put TLS in front: the form sends the password as it is typed.

### `oidc`

```yaml
auth:
  kind: oidc
  issuer: https://idp.example.com/realms/acme      # reads /.well-known/openid-configuration
  clientId: lenspack
  clientSecret: env:LENSPACK_OIDC_SECRET           # absent for a public client
  baseUrl: https://lens.example.com                # an origin, no path; the provider sends people back to <baseUrl>/auth/callback
  sessionSecret: env:LENSPACK_SESSION_SECRET       # 32+ characters; signs the session cookie
  sessionHours: 8                                  # default 8; roles are read again at the next sign-in
  userClaim: preferred_username                    # default; must be a name users cannot change (else use sub)
  rolesClaims: [groups, realm_access.roles]        # dotted paths; default [groups]
  editors: ["*"]
  maintainers: ["role:lens-maintainers"]
  usage: ["role:lens-maintainers", "finance"]
```

The flow is the authorization code flow with PKCE (S256), a `state` and a `nonce`. The ID token's signature is checked against the issuer's published keys (RS, PS, ES and EdDSA algorithms; never `none` or a shared secret), and so are its issuer, audience (and `azp`), expiry and nonce.

lenspack answers three paths itself:

- `GET /auth/login?return=/path`: to the provider. A page requested without a session is sent here; an API request gets 401.
- `GET /auth/callback`: back from the provider. On success, a session cookie and a redirect to the return path, which must be a path on this server.
- `GET /auth/logout`: clears the session and goes to the provider's `end_session_endpoint` with `client_id`, `post_logout_redirect_uri` (`<baseUrl>/`) and the ID token as `id_token_hint` when it fits in a cookie.

The session is a signed cookie (`HttpOnly`, `SameSite=Lax`, `Secure` on https, the same code as `password`'s) holding the user, roles and tenant; nothing is kept on the server. A change request (anything but GET) carrying an `Origin` other than `baseUrl`'s is refused. Removing someone at the provider takes effect at their next sign-in, at most `sessionHours` later.

### `proxy`

Unchanged, plus `rolesHeader` (oauth2-proxy can inject a `groups` claim as `X-Forwarded-Groups`) and `usage`. A deployment can add roles to its proxy first and move to `oidc` later with the same rules.

## App rights

`editors`, `maintainers` and `usage` list user names, `role:<name>` for anyone with that role or group, or `"*"`. Every kind takes them; a token's own `edit`, `maintain` and `usage` add to them, and `admin` under `password` has all three.

| right | lets a caller |
|---|---|
| viewer (anyone signed in) | read the boards of the packs they may open |
| editor | make boards of their own, change, share and delete them |
| maintainer | also change the pack's own boards; implies editor |
| usage | read the AI usage page (`GET /api/_usage`), which names every user. Absent `usage:`, the maintainers |

## Pack access

Each pack in `lenspack.yaml` may carry `access:` rules. The first rule whose `roles` the caller has decides; a caller no rule matches does not see the pack at all (404, as if absent). A pack without rules is open to everyone signed in.

```yaml
packs:
  - pack: ./support.pack.yaml
    source: warehouse
    access:
      - roles: [staff]                                  # everything
      - roles: [partner]
        hide: [customer_phone, message_text]            # every other key
        scope: [{ dimension: region, op: eq, value: north }]
      - roles: [auditor]
        only: [region, week, tickets_opened]            # these keys and no others
```

- `hide` names dimensions and measures the caller may not use; `only` names the ones they may. A measure computed from a hidden one (derived, or a per-level measure) is hidden with it. A key the pack does not have stops the server at startup, so a typo cannot leave a key showing.
- A measure over the same column as a hidden dimension is not hidden by itself: a distinct count of it is an aggregate, but a `min` or `max` of a text column returns its values. Hide such measures too, or prefer `only`.
- `scope` adds row filters to every query the caller runs, like a principal's own scope. It may filter on a hidden key: the server set it, not the caller.

Put the most trusted rule first.

### Where it is enforced

Resolution refuses any query that names a hidden key (`NOT_PERMITTED`), whatever built it: a board widget, a board filter or selection, a filter menu, explain, the chat's tools. Every path to a source goes through it, so nothing is compiled or run over a hidden key. On top of that, everything that describes the pack leaves hidden keys out:

- the catalogue in every API response, its hierarchies cut above the first hidden level (a drill never steps into one), and suggestions in refusals;
- the chat model's prompt (catalogue and the pack's examples) and its `list_metrics` tool; `run_sql` is refused for such a caller, as raw SQL does not pass through the pack;
- the pack file (`GET /api/<pack>/pack`), which is refused to a caller with any hidden key, and the compiled statement, which reads like it: explain leaves it out, and so do the chat's `query` and `explain` tools.

A board that has a widget on a hidden key still opens: that widget draws as "not available to you" and the rest as usual. This holds for shared boards and for a copy of one. In every board config and version sent to such a caller, a widget filter on a hidden key keeps its key and shows its value as `(hidden)`, and so does a board filter's default selection. That is the only view of a board such a caller gets: a copy they make stores it (the value is not saved under their name), and the chat model's prompt, its tools' results and the reviewer read the board the same way. Titles and text widgets are what their authors wrote: they are shown as written.

Hidden keys are kept from use, not secret as names: a widget error names its key, and explain answers a hidden key differently from an unknown one.

Pack descriptions, instructions and hints are shown to everyone who may open the pack: keep values out of them.

## How the layers combine

One pure function, `decide()` in `@lenspack/policy`, settles what a caller may use of a pack. Every host with callers goes through it: `lenspack serve` with any sign-in, Superset mode, and the CCRS API. `lenspack-mcp` has one caller, the person who started it, and does not.

1. **The host says who the caller is and what it already allows.** The sign-in (or Superset, or CCRS) gives an identity: user, roles, tenant, and whatever the host limits itself: a row scope, keys it keeps from them, capabilities it grants.
2. **Lenspack's rules only narrow it.** The rights by user and role add edit, maintain and usage rights. A pack's access rule adds its `scope` to the host's and the caller's, and its `hide`/`only` keys to the host's hidden keys. Nothing in lenspack.yaml can widen what the host allows.
3. **The engine enforces the result.** Every query carries the scope (`ctx.scope`) and is refused if it names a hidden key (`ctx.hidden`). The engine reads both by shape and does not know who decided them.

The scope is the pack's own (its `ctx.scope`), then the caller's, then their rule's, all applied together. A query that cannot be narrowed by one of them is refused (`OUT_OF_SCOPE`) rather than answered unnarrowed. A host's scope may be tied to one entity (a table's row-level security): it then narrows only the queries that read that entity. A host may also keep whole entities from a caller: their measures and the dimensions only they have are hidden, and a query that reads one is refused (`NOT_PERMITTED`).

### Superset

By default (`hostPolicy: superset`), each user's Superset access is their identity: a dataset their roles may not read is a kept entity, each simple RLS clause on a dataset they may read is scope on that entity, and a dashboard they may not open is a kept board. A clause that doesn't translate (anything beyond `=`, `IN`, `AND` and one-column `OR`) keeps the dataset from them, with the reason logged. Superset also says why in words for the user, so a refusal reads "not available to you: your Superset access doesn't include it" (`ACCESS_HIDDEN`) rather than "not in the pack", and a user who may read nothing is told so before any model is asked. Details in [packages/hosts/superset/README.md](../packages/hosts/superset/README.md#what-each-user-sees).

### Dashboard roles (DASHBOARD_RBAC)

Superset can give a dashboard its own roles (the `DASHBOARD_RBAC` feature flag). A user in one of those roles can open the dashboard and see its charts, even without access to the datasets behind them. Lenspack follows the same rule, as Superset decides it:

- **On that dashboard**, the user can ask about the data of the dashboard's charts: the chat, the board's own data and its filter menus read those datasets for them. Row-level security still applies, as it does in Superset, so they get the same rows the dashboard's charts show them.
- **Only the datasets behind the dashboard's charts.** A dataset that only a dashboard filter reads is not opened: Superset lets that filter list its values, and nothing more.
- **Nowhere else.** On another dashboard, in the list of everything they can ask about, and in compiled queries outside a dashboard, those datasets stay closed to them, with the usual "your Superset access doesn't include it".
- **Who counts.** Superset's own check decides: dashboard roles must be on and the dashboard must have roles; the user must be in one of them and the dashboard published, or be its owner, or an admin.
- **Saved answers** made on a dashboard this way are kept apart: they are never used on another dashboard, or for a user who reads the dashboard's data some other way.
- **When Lenspack can't tell**, nothing opens. If Superset can't be asked, or its plugin is older than this change, a dashboard role opens the dashboard but none of its data in the chat. With `DASHBOARD_RBAC` off, Superset grants nothing through a dashboard, and neither does Lenspack.

Superset 5.0 and 6.1 grant the same here. 6.1 also lets a dashboard's users drill into its data (drill to detail, drill by); that reads the same datasets, so it adds nothing to the list. The plugin asks Superset's own check (`raise_for_access`, for one of the dashboard's charts) as the user, so a Superset change to the rule follows by itself.

`hostPolicy: off` (or `LENSPACK_HOST_POLICY=off`) answers everyone with Lenspack's service account, so anyone signed in reads every configured dataset in full. It was the default before; it is now an explicit choice, and Lenspack warns at every start while it is on.

### CCRS

The CCRS API (`@lenspack/ccrs`) puts the caller's CCRS row scope (departments, jurisdictions, own records) through the same path: it becomes the caller's scope, so every query carries it, inline filter-menu queries included, and no parameter or KPI filter can drop it. A KPI whose entity cannot be narrowed by a scope dimension is refused (`OUT_OF_SCOPE`, reported as `query_failed`) rather than failing on an unknown join. The capabilities CCRS's `/_access` returns are the caller's grants: with none returned (a trusted deployment), every tile is visible.

## How access is tested

The access suite starts real Superset 6.1 and 5.0, each with a Postgres database of sample data and Lenspack in front of it, and checks what each kind of user can see and change. It goes through Superset's own sign-in and its `/lenspack` route, the way a browser does. The chat runs on a stand-in model that calls exactly the tool it is told to, so the suite checks what the tools and routes let through, not what a model says. Nothing paid is called.

### Who is in it

| user | Superset roles | what Superset lets them do |
|---|---|---|
| `lp_admin` | Admin | everything |
| `lp_owner` | Gamma, both datasets | owns dashboard A, so may edit it |
| `lp_viewer` | Gamma, both datasets | views A, may not edit it |
| `lp_partial` | Gamma, `visits` only | no access to `stock` |
| `lp_north` | Gamma, both datasets | RLS `region = 'North'` on both datasets |
| `lp_inlist` | Gamma, both datasets | RLS `region IN ('North', 'East')` on `visits` |
| `lp_complex` | Gamma, both datasets | RLS `region LIKE 'N%'` on `visits`, which Lenspack can't translate |
| `lp_templ` | Gamma, both datasets | RLS `team = '{{ current_username() }}'` on `visits` |
| `lp_rbac` | Gamma and the roles of dashboards B and C | opens B and C through their dashboard roles, reads no dataset; RLS `region IN ('North', 'South')` on `stock` through B's role |
| `lp_rbac_off` | the same as `lp_rbac` | used only while dashboard roles are turned off |
| `lp_noroles` | none | signs in, nothing else |

Dashboard A holds a chart of each dataset and has no dashboard roles. Dashboard B holds a stock chart and C a visits chart; each opens only for its dashboard role (`DASHBOARD_RBAC`). The suite can turn `DASHBOARD_RBAC` off without restarting Superset. Every number in the sample data is a different power of two, so a total shows exactly which rows were counted.

### What each case proves

- **The default.** Lenspack started with no `hostPolicy` applies each user's Superset access.
- **Viewing.**
  - On a dashboard the user can't open, the chat and every board route answer 403. Superset refuses it first, and Lenspack refuses it again for a request Superset signed as "may not view".
  - A dashboard role opens its dashboard for its members only.
  - Binding (`/_superset/bind`) works only for a dashboard the user may open.
  - The boards list and the dashboards list name only dashboards the user may open.
  - A request signed for dashboard A and sent for dashboard B gets 403.
  - A missing, tampered, wrongly keyed, expired or future identity gets 401.
  - Paths with `..`, encoded dots or encoded slashes get 400, from Superset and from Lenspack.
- **Editing.**
  - The owner can edit, through the board API and the chat.
  - A viewer can't. The board API answers 403, and the chat's edit tools answer "you can view this dashboard but not edit it in Superset". Nothing changes in Superset.
  - An admin can edit a dashboard they don't own.
  - With the `boardEdits` switch off, nobody can, admins included.
- **Data.**
  - A dataset the user may not read is missing from the catalogue, the chat's `list_metrics` and the entity list, and every query on it is refused with "your Superset access doesn't include it". A measure that isn't in the pack keeps the pack's own message.
  - RLS narrows chat queries, filter menus and board widgets to the exact rows expected for each user, and a user's own filter never widens them.
  - The `LIKE` rule keeps `visits` from `lp_complex` entirely. The templated rule is rendered by Superset and narrows `lp_templ` to their own team's rows.
  - A user who may read nothing is told so before any model is asked.
  - While Lenspack can't reach Superset, a user it hasn't checked yet sees nothing. Once Superset is back, they see their data again.
- **Dashboard roles.**
  - On B, `lp_rbac` (no dataset access) gets B's stock data through the chat, the board and the filter menu: the same rows Superset's own chart data API serves them for B's chart, with B's role's RLS applied. A filter of their own never widens it.
  - Stock on C, visits on B, the list of everything they can ask about, and a compiled query outside a dashboard are all refused. Superset refuses B's chart asked for as if it were on C.
  - A saved answer `lp_rbac` gets on B is never given to an admin on B, to `lp_rbac` on C, or to a viewer on A.
  - With `DASHBOARD_RBAC` off, B no longer opens for them, Superset refuses its chart data, and Lenspack shows none of B's data even on a request signed as able to view B.
- **Admin surfaces.** Settings, the audit log, cost per answer and usage are for Superset admins only. A dashboard owner gets 403, and so does Superset's own AI assistant page.
- **Caching and saved answers.**
  - Two users with different RLS asking the same question, twice in a row, each get their own correct answer.
  - Five users with different access (all datasets, `visits` only, North only, North and East, their own team) ask the same question. Nobody is answered from another's saved answer: not when the same question comes again within minutes (sent as saved, no model), not when the saved queries run again on fresh data, and not when the question names another region (the region swapped into the saved queries). Each answer has exactly that user's rows.
- **Pending.**
  - A personal copy of B does not carry B's dashboard-role access (needs personal dashboards).
  - Personal dashboards and saved configurations (another change in progress): a viewer may create one; only its owner deletes it; a saved configuration applies only to dashboards the user controls; another user's personal dashboard is neither listed, opened nor edited.

These cases check outcomes, not how Lenspack gets them. They keep holding when queries move to running as the user inside Superset. The `LIKE` case would then get stronger: Superset would apply the rule itself, so `lp_complex` would see the North rows instead of no `visits` at all.

### Running it

```sh
pnpm install
pnpm test:access                 # Superset 6.1 and 5.0, side by side, about 4 minutes after the images are pulled
pnpm test:access superset-6.1    # one version
```

It needs Linux with Docker. Superset runs in the host's network and listens on 127.0.0.1 only. The first run pulls `apache/superset:6.1.0`, `apache/superset:5.0.0` and `postgres:16-alpine`, and each Superset installs the Postgres driver for the sample data. The secret key and passwords are made fresh for each run and never printed. The containers, their volumes and the temporary folder are removed at the end, whether the cases pass or fail. If a run is killed, `docker rm -f -v $(docker ps -aq --filter label=lenspack-access-suite)` clears what is left.

CI runs it on every pull request, in its own job beside the unit tests. The suite is in [packages/hosts/superset/test-access](../packages/hosts/superset/test-access): `stack.ts` starts everything, `fixtures.py` makes the users, roles, rules and dashboards, and `cases.ts` holds the cases.

## What this does not do yet

- Bearer access tokens from the provider for API clients (the `oidc` kind signs in browsers).
- Per-board sharing with people or groups, and read-only links ([#6](https://github.com/theflywheel/lenspack/issues/6)).
- Access rules inside `pack.yaml`. They live in `lenspack.yaml` because role names belong to a deployment, and one pack serves several.
