# Rights: using, viewing, editing, maintaining, usage and admin

This page lists what a signed-in person may *do*: use the assistant at all, read boards, make and change them,
change the pack's own boards, read usage, and use the admin pages. It is for operators deciding who gets which right. What a person may *see* of
the data is in [Pack access rules](pack-rules.md) and [Row scope and tenancy](scope-and-tenancy.md).

## The rights

| right | lets a caller |
|---|---|
| **user** | use the assistant at all: boards, data, the chat and its button. Absent `users:`, everyone signed in. Admins always may |
| **viewer** (any user) | read the boards of the packs they may open, and ask questions about them |
| **editor** | make boards of their own, change, share and delete them |
| **maintainer** | also change the pack's own boards; implies editor |
| **usage** | read the AI usage page (`GET /api/_usage`), which names every user. Absent `usage:`, the maintainers |
| **admin** | open the admin panel, change settings and switches, manage saved answers, read the audit log. Absent `admins:`, anyone with a role named `admin` |

## Granting them in the standalone server

`editors`, `maintainers`, `usage`, `admins` and `users` in the `auth:` block list user names, `role:<name>` for anyone
with that role or group, or `"*"` for everyone signed in. Every sign-in kind takes them, except that `tokens` has no
`users` rule: there `users` is the list of tokens, and leaving a token out already keeps its holder out. A token's
own `edit`, `maintain` and `usage` add to them. `admin` under `password` has every right, and so does the one local
user under `none`.

```yaml
auth:
  kind: oidc
  # …
  editors: ["*"]                                 # everyone signed in may make boards
  maintainers: ["role:lens-maintainers"]         # these may change the pack's boards
  usage: ["role:lens-maintainers", "finance"]   # these may read who spent what
  admins: ["role:lens-admins", "ops-lead"]       # these may use the admin pages
  users: ["role:lens-users"]                     # only these (and admins) may use the assistant
```

A `role:` entry matches roles only, so a user named like a role gets nothing from it. Rights only add: listing
someone twice changes nothing.

Every request that changes something (edit operations, layout, restore, chat, create, copy, share, delete) needs the
editor right on that board; a viewer gets 403 from the board API. In the chat, a viewer may still ask questions; the
edit tools refuse, with a message the model passes on.

## Boards have owners

- **A board someone makes is theirs.** Until they share it, nobody else sees it (404, as if it did not exist). Once
  shared, others in the same tenant may read it and save a copy, not change it.
- **The pack's own boards**, from its board files, have no owner: everyone who may open the pack reads them, and only
  a maintainer changes them. A changed board file lands as a new version at the next start, so an edit made in the
  app stays in the history.
- A board that the host keeps from a caller (a Superset dashboard they may not open) is neither listed nor opened.

`boardRights()` in the policy package decides this from the caller and the board, for every host.

## Admin

The admin panel, the settings routes and the saved answers' routes ask one question, `mayAdminister`: does the
caller hold Lenspack's admin role? One rule, `admins`, gives it, read the same way for every sign-in, Superset
included. The sign-in only says who someone is and which roles they hold; Lenspack decides which of them are admins.

- **In the standalone server**, `auth.admins` lists user names and `role:<name>` entries. Left out, any sign-in role
  or group named `admin` counts, as before: a role from OpenID Connect claims, a login proxy's roles header or a
  token's `roles`. So if your identity provider has a group called `admin` and you set no rule, its members can
  administer Lenspack. Once the rule is set, a role that happens to be called `admin` counts only if the rule names
  it. The built-in password user is always an admin, and so is the one local user under `none`.
- **In Superset**, `auth.admins` in `superset.yaml` lists Superset role names, default `["Admin"]`: Superset's own
  admins, as before. With `["Lenspack admin"]`, a Superset Admin without that role gets no admin pages, and a Gamma
  or Alpha user with it does. See [Who is asking: who may administer](../hosts/superset/identity.md#who-may-administer).

Being an admin opens the admin pages and nothing else. It does not let anyone read more data, open more dashboards or
change more boards: those still follow the sign-in, the host and the pack rules.

A dashboard's edit right never makes someone an admin. Names on the usage board and in review reports are shown only
to admins who also hold the usage right; others see the same figures with the user, the question text and the
session hidden. Every refusal is written to the audit log.

## Who may use the assistant

`users` switches the assistant on per person. Left out, everyone signed in may use it, as before. Set, only people
the rule names, and every admin, may: anyone else gets a plain refusal ("The assistant isn't turned on for your
account") from every board, data and chat route. Inside Superset they also see no **Ask** button, and a Superset admin
turns it on for someone by giving them the role in Settings → List Users. See [Who is asking: who may use the
assistant](../hosts/superset/identity.md#who-may-use-the-assistant).

**Upgrading:** the keys are `auth.admins` and `auth.users`, in `lenspack.yaml` and in `superset.yaml`. Leaving them
out keeps today's behaviour: admins are anyone with a role named `admin` under `lenspack serve`, Superset's `Admin`
role under Superset, and the built-in `admin` under `password` always; and everyone signed in may use the assistant.

## Editing inside Superset

Inside Superset, edits follow Superset's own rights by default: whoever Superset lets edit that dashboard. See
[Who is asking: who may edit](../hosts/superset/identity.md#who-may-edit).

Anyone whose Superset roles may write dashboards may make or copy a dashboard of their own and change it freely, and
`editScope: own` limits chat edits to those. See [Personal dashboards and saved layouts](../features/personal-dashboards.md).

## Turning edits off for everyone

The `boardEdits` switch, off, makes the chat answer questions only, for everyone, admins included. See
[Feature switches](../operating/switches.md).

## Not built yet

- Sharing a board with named people or groups, and read-only links.

---

**Next:** [Pack access rules](pack-rules.md).

**Related:** [Sign-in](sign-in.md) · [The admin panel](../features/admin-panel.md) · [Policy](../concepts/policy.md)
