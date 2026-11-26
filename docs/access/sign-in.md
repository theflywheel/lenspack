# Sign-in

This page covers how the standalone server knows who is asking: the five sign-in kinds, what each needs, and how
sessions and failed tries are handled. It is for operators setting up `lenspack serve`. Inside Superset, Superset
signs people in; see [Who is asking](../hosts/superset/identity.md).

`auth.kind` in `lenspack.yaml` picks the sign-in; the environment variable `LENSPACK_AUTH` overrides it (`LENSPACK_AUTH=none` for a quick local look). With neither, it is `password`. Every kind ends in the same principal: a user, their roles, and the rights in [Rights](rights.md). The rights and the pack rules work the same whichever kind named the caller.

| kind | who the caller is | roles from |
|---|---|---|
| `password` (default) | the one built-in user, `admin`, with a password | `admin` |
| `oidc` | Lenspack signs people in with an OpenID Connect provider (Keycloak, Entra ID, any issuer with discovery) | claims in the ID token |
| `proxy` | a login proxy in front names the user in a header, believed only with the proxy's shared secret | a header (`rolesHeader`), comma-separated |
| `tokens` | bearer tokens the deployment issues | `roles:` per token |
| `none` | open, for a local demo; listens on 127.0.0.1 unless `host:` says otherwise (opened by `LENSPACK_AUTH`, only `--host` moves it, so in a container pass `--host 0.0.0.0` too) | none: the one local user sees everything |

Inside Superset (`lenspack superset`) none of these kinds apply: Superset signs who is asking on every request, and that signed identity, with Superset's own dashboard rights, is the only sign-in there. It is an adapter of its own kind, `superset`, which gives a Superset admin the role `admin`. By default it also brings each user's Superset roles, dataset access, row-level security and the dashboards they may open. See [Who is asking](../hosts/superset/identity.md) and [Access inside Superset](superset.md).

### `password`

For a deployment with no identity provider. There is one user, `admin`, with every right (editor, maintainer, usage) and the role `admin`, which pack rules can match. Lenspack keeps no other users and has no user management: for named people, use `oidc` or a login proxy.

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
3. neither: at first start Lenspack makes a random password, keeps only its hash in `<dir>/admin-password.hash`, and writes the password once to `<dir>/admin-password.txt`. Both files are readable by the server's user only (0600), and the folder gets a `.gitignore` so it is not committed with the config. The log names the file, never the password. Read it, then delete the file; it is not written again. To start over, delete the hash file.

Lenspack refuses a state folder that is a link or writable by everyone, and a state file that is a link, belongs to another user or is writable by anyone else. A folder shared with a group (a Kubernetes volume with `fsGroup`) is fine. With `LENSPACK_ADMIN_PASSWORD` and `sessionSecret` both set, no folder is needed. The session cookie is signed with a key kept in `<dir>/session.key` (or `sessionSecret:`). A new password ends every session made with the old one. Several replicas need the same `<dir>` (or the same password and `sessionSecret`), or a session from one is unknown to the others; replicas starting together on one folder agree on a single made password.

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

Lenspack answers three paths itself:

- `GET /auth/login?return=/path`: to the provider. A page requested without a session is sent here; an API request gets 401.
- `GET /auth/callback`: back from the provider. On success, a session cookie and a redirect to the return path, which must be a path on this server.
- `GET /auth/logout`: clears the session and goes to the provider's `end_session_endpoint` with `client_id`, `post_logout_redirect_uri` (`<baseUrl>/`) and the ID token as `id_token_hint` when it fits in a cookie.

The session is a signed cookie (`HttpOnly`, `SameSite=Lax`, `Secure` on https, the same code as `password`'s) holding the user, roles and tenant; nothing is kept on the server. A change request (anything but GET) carrying an `Origin` other than `baseUrl`'s is refused. Removing someone at the provider takes effect at their next sign-in, at most `sessionHours` later.

### `proxy`

A login proxy in front (oauth2-proxy, an ingress with sign-in) names the user in a header, and optionally their roles
and tenant in others. The headers are believed only when the request carries the proxy's shared secret, so a caller
who reaches Lenspack directly cannot claim to be anyone.

```yaml
auth:
  kind: proxy
  secret: env:LENSPACK_PROXY_SECRET       # at least 16 characters, checked at start
  secretHeader: x-lenspack-proxy-secret   # default
  userHeader: x-forwarded-user            # default
  rolesHeader: x-forwarded-groups         # optional, comma-separated (oauth2-proxy can inject a groups claim)
  tenantHeader: x-tenant                  # optional
  signOutUrl: /oauth2/sign_out            # where the app's sign-out link goes
  maintainers: ["role:lens-maintainers"]
```

A deployment can add roles to its proxy first and move to `oidc` later with the same rules.

### `tokens`

Bearer tokens the deployment issues, for programs and simple setups. Each token is an `env:` reference, compared in
constant time.

```yaml
auth:
  kind: tokens
  users:
    - { user: ops,     token: env:OPS_TOKEN, edit: true, maintain: true }
    - { user: partner, token: env:PARTNER_TOKEN, tenant: t1, roles: [partner],
        scope: [{ dimension: region, op: in, value: [North] }] }
```

Each entry takes `user`, `token`, `edit` and `maintain` (both false by default), `tenant`, `scope` (row filters every
query carries), `packs` (the packs it may open; absent, all), `roles` and `usage`. A request sends
`Authorization: Bearer <token>`.

### `none`

Open, for a local demo; it must be written down. It listens on 127.0.0.1 unless `host:` says otherwise. When
`LENSPACK_AUTH=none` opens it (over a config that names another kind, or none), only `--host` moves it, so in a
container pass `--host 0.0.0.0` too. The one local user has every right, the admin role included.

## What every kind ends in

Every kind ends in the same principal: a user, their roles, their tenant and row scope, and their rights. An
unknown caller gets 401 on every API path. The rights are in [Rights](rights.md); what each caller may see of a pack
is in [Pack access rules](pack-rules.md).

For your own server code, the same comes from an `access(request)` hook passed to `createApp`, which returns that
principal for a request, or nothing.

## Not built yet

- Bearer access tokens from the identity provider for API clients (the `oidc` kind signs in browsers).

---

**Next:** [Rights](rights.md).

**Related:** [Who sees what](README.md) · [Configuration reference](../reference/config.md#auth)
