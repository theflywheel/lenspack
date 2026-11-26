# Rights: viewing, editing, maintaining, usage and admin

This page lists what a signed-in person may *do*: read boards, make and change them, change the pack's own boards,
read usage, and use the admin pages. It is for operators deciding who gets which right. What a person may *see* of
the data is in [Pack access rules](pack-rules.md) and [Row scope and tenancy](scope-and-tenancy.md).

## The rights

| right | lets a caller |
|---|---|
| **viewer** (anyone signed in) | read the boards of the packs they may open, and ask questions about them |
| **editor** | make boards of their own, change, share and delete them |
| **maintainer** | also change the pack's own boards; implies editor |
| **usage** | read the AI usage page (`GET /api/_usage`), which names every user. Absent `usage:`, the maintainers |
| **admin** | open the admin panel, change settings and switches, manage saved answers |

## Granting them in the standalone server

`editors`, `maintainers` and `usage` in the `auth:` block list user names, `role:<name>` for anyone with that role or
group, or `"*"` for everyone signed in. Every sign-in kind takes them. A token's own `edit`, `maintain` and `usage`
add to them. `admin` under `password` has all three, and so does the one local user under `none`.

```yaml
auth:
  kind: oidc
  # …
  editors: ["*"]                                 # everyone signed in may make boards
  maintainers: ["role:lens-maintainers"]         # these may change the pack's boards
  usage: ["role:lens-maintainers", "finance"]   # these may read who spent what
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
caller hold the role `admin`?

- **In the standalone server**, any sign-in role or group named `admin` counts: the built-in password user, a role
  from OpenID Connect claims, a login proxy's roles header or a token's `roles`, and the one local user under `none`.
  So if your identity provider has a group called `admin`, its members can administer Lenspack.
- **In Superset**, only a Superset admin, from the signed admin flag. A Superset role that happens to be named
  `admin` grants nothing.

A dashboard's edit right never makes someone an admin. Names on the usage board and in review reports are shown only
to admins who also hold the usage right; others see the same figures with the user, the question text and the
session hidden. Every refusal is written to the audit log.

## Editing inside Superset

Inside Superset, edits follow Superset's own rights by default: whoever Superset lets edit that dashboard. See
[Who is asking: who may edit](../hosts/superset/identity.md#who-may-edit).

## Turning edits off for everyone

The `boardEdits` switch, off, makes the chat answer questions only, for everyone, admins included. See
[Feature switches](../operating/switches.md).

## Not built yet

- Sharing a board with named people or groups, and read-only links.

---

**Next:** [Pack access rules](pack-rules.md).

**Related:** [Sign-in](sign-in.md) · [The admin panel](../features/admin-panel.md) · [Policy](../concepts/policy.md)
