# Who is asking

This page explains how the Lenspack server knows who is asking inside Superset, who may edit and administer, the
account Lenspack uses to talk to Superset, and the audit log. It is for Superset admins and security reviewers.
What each person may *see* is in [Access inside Superset](../../access/superset.md).

## The signed identity

Browsers never reach the Lenspack server directly. Superset forwards `/lenspack/...` to it for signed-in users and
adds a header, `x-lenspack-identity`: base64url JSON `{u, a, r, d, b, p, e, v, t}` and an HMAC-SHA256 of it.

| field | meaning |
|---|---|
| `u` | the Superset user |
| `a` | whether they are a Superset admin |
| `r` | their Superset role names |
| `d` | the dashboard the request is about |
| `b`, `p` | its board (`superset-<d>`) and the pack in the path |
| `e`, `v` | whether Superset lets them edit and view that dashboard |
| `t` | when it was signed |

The key is derived from Superset's `SECRET_KEY` on the Superset side; the Lenspack server fetches it on start
(`GET /api/v1/lenspack/identity-key`, allowed to admins and its own account). A request without a valid signature
less than five minutes old is not signed in (401). Only `overlay.js`, `chat.js`, `chat.css` and `/healthz` are
public.

## One dashboard per request

The plugin reads the dashboard from the path where the server reads a board (`api/<pack>/superset-<id>/...`) and
checks the user's rights on that dashboard. The server reads the board from its own route and refuses the request
(403) when it is not the board Superset signed for. The same happens when the pack differs, or when the path names
a `superset-<id>` board Superset signed nothing for.

Both sides refuse a path with a `.` or `..` segment or an encoded slash (`%2e`, `%2f`, `%5c`; 400). Binding a
dashboard (`/_superset/bind`) works only for the dashboard Superset checked. A plugin from before `b` and `p` signs
only `d`, and the server then checks `superset-<d>` against its route.

## Who may edit

Edits follow `editPolicy` in the config (or `LENSPACK_EDIT_POLICY`):

- **`superset`**, the default: whoever Superset lets edit that dashboard, its owners with `can_write` on Dashboard,
  and admins. That right counts on that dashboard's board only. Everyone else who can view it may still ask
  questions; the chat's edit tools then answer "you can view this dashboard but not edit it in Superset", which the
  model passes on.
- **`signed-in`**: anyone signed in may edit (the behaviour of early releases).

The `boardEdits` switch comes first: off, nobody edits through the chat, admins included.

> **Coming soon.** `editScope: own` limits chat edits to each person's own dashboards. See
> [Personal dashboards](../../features/personal-dashboards.md#where-the-chat-may-edit-editscope).

## Who may administer

Settings writes, the audit log, cost per answer and the usage page (`GET /api/_usage`, which names every user's
spend) need a Superset admin. Owning a dashboard does not give them.

The roles in the header also become the user's roles in Lenspack's policy, beside `admin` for a Superset admin. A
Superset role literally named `admin` grants nothing here: Lenspack's admin comes only from the signed admin flag.

## Lenspack's own Superset account

Lenspack reads data and writes dashboards through its own Superset account, `lenspack`, with the Admin role.
It is made on first start through the plugin's bootstrap route; see
[Install](install.md#3-run-the-server). Because that account can read everything, Lenspack narrows every answer to
what the person asking may see; see [Access inside Superset](../../access/superset.md).

**Planned:** queries run as the person asking, through Superset's own security, and edits attributed to them in
Superset's history rather than to `lenspack`. See [Access inside Superset](../../access/superset.md#planned-superset-runs-each-query-as-the-person).

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
