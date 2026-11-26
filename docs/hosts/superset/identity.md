# Who is asking

This page explains how the Lenspack server knows who is asking inside Superset, who may use the assistant, edit and administer, the
account Lenspack uses to talk to Superset, and the audit log. It is for Superset admins and security reviewers.
What each person may *see* is in [Access inside Superset](../../access/superset.md).

## The signed identity

Browsers never reach the Lenspack server directly. Superset forwards `/lenspack/...` to it for signed-in users and
adds a header, `x-lenspack-identity`: base64url JSON `{u, i, a, r, w, d, b, p, e, v, t}` and an HMAC-SHA256 of it.

| field | meaning |
|---|---|
| `u` | the Superset user |
| `i` | their Superset user id (needed to make or copy [personal dashboards](../../features/personal-dashboards.md); an older plugin that does not sign it gets a refusal saying to update) |
| `a` | whether they are a Superset admin. It counts only as Superset's own right to edit every dashboard; who is a Lenspack admin is the `admins` rule's to say (below) |
| `r` | their Superset role names, which Lenspack's `admins`, `usage` and `users` rules read |
| `w` | whether Superset lets them write dashboards at all (`can_write` on Dashboard, or Admin), which making, copying, deleting and laying out [personal dashboards](../../features/personal-dashboards.md) need. An older plugin does not sign it; then only Superset admins may |
| `d` | the dashboard the request is about |
| `b`, `p` | its board (`superset-<d>`) and the pack in the path |
| `e`, `v` | whether Superset lets them edit and view that dashboard |
| `t` | when it was signed |

The key is derived from Superset's `SECRET_KEY` on the Superset side; the Lenspack server fetches it on start
(`GET /api/v1/lenspack/identity-key`, allowed to admins and its own account). A request without a valid signature
less than five minutes old is not signed in (401). Only `overlay.js`, `chat.js`, `mine.js`, `chat.css` and
`/healthz` are public.

## One dashboard per request

The plugin reads the dashboard from the path where the server reads a board (`api/<pack>/superset-<id>/...`) and
checks the user's rights on that dashboard. The server reads the board from its own route and refuses the request
(403) when it is not the board Superset signed for. The same happens when the pack differs, or when the path names
a `superset-<id>` board Superset signed nothing for.

Both sides refuse a path with a `.` or `..` segment or an encoded slash (`%2e`, `%2f`, `%5c`; 400). Binding a
dashboard (`/_superset/bind`), and the personal-dashboard and saved-layout routes (`/_superset/my...?dashboard=<id>`),
work only for the dashboard Superset checked. An older plugin signs only the dashboard
id. The server still checks it, but update the plugin.

## Who may use the assistant

Everyone signed in to Superset, unless the config names roles in `auth.users` (or `LENSPACK_USER_ROLES`,
comma-separated):

```yaml
auth:
  users: ["Lenspack user"]
```

Then only people with one of those Superset roles, and every Lenspack admin, see the **Ask** button and may use the
chat. Everyone else sees no button, and the chat, board, data and personal-dashboard routes answer 403 "The assistant
isn't turned on for your account". To turn it on for someone, a Superset admin gives them the role in
Settings → List Users (make the role once in Settings → List Roles; it needs no permissions). It applies from their
next page load. Nothing in Lenspack needs changing.

Hiding the button costs nothing extra. Every Superset page already loads `/lenspack/overlay.js` through Superset's
own route, which signs the person's role names onto that request. The server checks the signature and the rule, with
no call back to Superset, and for someone left out answers with an empty script that is never cached. No page makes
a request it did not make before, and the plugin needs no copy of the rule.

## Who may edit

Edits follow `editPolicy` in the config (or `LENSPACK_EDIT_POLICY`):

- **`superset`**, the default: whoever Superset lets edit that dashboard, its owners with `can_write` on Dashboard,
  and admins. That right counts on that dashboard's board only. Everyone else who can view it may still ask
  questions; the chat's edit tools then answer "you can view this dashboard but not edit it in Superset", which the
  model passes on.
- **`signed-in`**: anyone signed in may edit (the behaviour of early releases).

The `boardEdits` switch comes first: off, nobody edits through the chat, admins included.

Someone who can only view a dashboard can make their own copy and change that. `editScope: own` (or
`LENSPACK_EDIT_SCOPE=own`) narrows chat edits further, to each person's own dashboards, so shared ones stay as they
are; admins (by the `admins` rule) are exempt unless `adminsExempt: false`, still only on dashboards Superset lets
them edit. See [Personal dashboards and saved
layouts](../../features/personal-dashboards.md#where-the-chat-may-edit-editscope).

## Who may administer

Lenspack decides who its admins are, by Superset role name: `auth.admins` in the config (or `LENSPACK_ADMIN_ROLES`,
comma-separated). The default is `["Admin"]`, Superset's own admins, as before.

```yaml
auth:
  admins: ["Lenspack admin"]   # a Superset Admin without this role gets no admin pages
  usage: ["Lenspack admin"]    # who also sees user names; default: the same roles as admins
```

An admin may use the settings and their changes, the admin panel, saved answers, the audit log, cost per answer,
everyone's personal dashboards and the usage page (`GET /api/_usage`, which names every user's spend). User names on
those pages also need the usage right: `auth.usage` (or `LENSPACK_USAGE_ROLES`), by default the same roles as
`admins`.

- **Being an admin gives no more data.** A Gamma or Alpha user given the "Lenspack admin" role opens the admin
  panel at `/lenspack/_superset/admin/` and changes the settings through it. They still see only their own data,
  open only the dashboards Superset lets them open, and edit only what Superset lets them edit.
- **Owning a dashboard does not make anyone an admin.**
- **Superset's Settings → AI assistant page** also lists Superset's databases, so it stays a Superset Admin's page.
  Lenspack refuses it to any Superset Admin the rule does not name.
- **Older plugins.** A plugin too old to sign role names still signs the admin flag, which then counts as the
  `Admin` role, so the default rule holds for it too.

The roles in the header also become the user's roles in Lenspack's policy. Lenspack's own `admin` role is given
only by the `admins` rule, so a Superset role that happens to be called `admin` grants nothing unless the rule names
it.

## Lenspack's own Superset account

Lenspack reads data and writes dashboards through its own Superset account, `lenspack`, with the Admin role.
It is made on first start through the plugin's bootstrap route; see
[Install](install.md#3-run-the-server). Because that account can read everything, Lenspack narrows every answer to
what the person asking may see; see [Access inside Superset](../../access/superset.md).

**Planned:** queries run as the person asking, through Superset's own security, and edits attributed to them in
Superset's history rather than to `lenspack`. See [Access inside
Superset](../../access/superset.md#planned-superset-runs-each-query-as-the-person).

## The audit log

Board changes, refused and denied requests, chat turns and settings changes, each with the Superset user, are one
JSON line each in `audit.jsonl` in the state directory.

- On the first write of a month, the previous month moves to `audit-YYYY-MM.jsonl`; months older than 90 days are
  deleted (`audit.retentionDays`, or `LENSPACK_AUDIT_RETENTION_DAYS`). `audit: false` turns it off.
- It is the durable record: the usage figures (`GET /api/_usage`) are kept in memory and reset on restart.
- Admins read it with `GET /_superset/audit?month=YYYY-MM&limit=N`, and on the AI assistant page.

---

**Next:** [Settings and switches](settings.md).

**Related:** [Access inside Superset](../../access/superset.md) · [Rights](../../access/rights.md) ·
[Why the model cannot break things](../../architecture/safety.md)
