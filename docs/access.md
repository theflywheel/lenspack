# Sign-in, roles and pack access

Who may sign in, what they may do in the app, and what of each pack's data they may see.

## Sign-in

`auth:` in `lenspack.yaml` names how a caller is identified. Every kind ends in the same principal: a user, their roles, and the rights below.

| kind | who the caller is | roles from |
|---|---|---|
| `oidc` | lenspack signs people in with an OpenID Connect provider (Keycloak, Entra ID, any issuer with discovery) | claims in the ID token |
| `proxy` | a login proxy in front names the user in a header, believed only with the proxy's shared secret | a header (`rolesHeader`), comma-separated |
| `tokens` | bearer tokens the deployment issues | `roles:` per token |
| `none` | open, on purpose | none: the one local user sees everything |

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

The session is a signed cookie (`HttpOnly`, `SameSite=Lax`, `Secure` on https) holding the user, roles and tenant; nothing is kept on the server. A change request (anything but GET) carrying an `Origin` other than `baseUrl`'s is refused. Removing someone at the provider takes effect at their next sign-in, at most `sessionHours` later.

### `proxy`

Unchanged, plus `rolesHeader` (oauth2-proxy can inject a `groups` claim as `X-Forwarded-Groups`) and `usage`. A deployment can add roles to its proxy first and move to `oidc` later with the same rules.

## App rights

`editors`, `maintainers` and `usage` list user names, `role:<name>` for anyone with that role or group, or `"*"`.

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
