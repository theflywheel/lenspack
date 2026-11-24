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

Superset mode (`lenspack superset`) takes none of these kinds: Superset signs who is asking on every request, and that signed identity, with Superset's own dashboard rights, is the only sign-in there. It is an adapter of its own kind, `superset`, which gives a Superset admin the role `admin`. See [packages/superset/README.md](../packages/superset/README.md).

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
- the pack file (`GET /api/<pack>/pack`), which is refused to a caller with any hidden key, and the compiled statement in explain, which reads like it.

A board that has a widget on a hidden key still opens: that widget draws as "not available to you" and the rest as usual. This holds for shared boards and for a copy of one. In every board config and version sent to such a caller, a widget filter on a hidden key keeps its key and shows its value as `(hidden)`. Titles and text widgets are what their authors wrote: they are shown as written.

Hidden keys are kept from use, not secret as names: a widget error names its key, and explain answers a hidden key differently from an unknown one.

Pack descriptions, instructions and hints are shown to everyone who may open the pack: keep values out of them.

## What this does not do yet

- Bearer access tokens from the provider for API clients (the `oidc` kind signs in browsers).
- Per-board sharing with people or groups, and read-only links ([#6](https://github.com/theflywheel/lenspack/issues/6)).
- Access rules inside `pack.yaml`. They live in `lenspack.yaml` because role names belong to a deployment, and one pack serves several.
