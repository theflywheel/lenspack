# Who sees what

This page explains, from the top down, how Lenspack decides what a person may see and do: the host first, then
Lenspack's own rules, then the engine that enforces both. It is for operators and security reviewers. The pages after
it go into each layer.

## Start with the host

Lenspack never decides on its own who someone is or what they may see. **The host says who is asking and what it
already allows; Lenspack only narrows that.**

- **Inside Superset**, Superset says who is asking (a signed header on every request) and what they may see: their
  dataset access, row-level security and dashboard rights. See [Access inside Superset](superset.md).
- **In the standalone server**, your sign-in says who is asking (a password, OpenID Connect, a login proxy or tokens),
  with their roles and tenant. See [Sign-in](sign-in.md).
- **In your own app**, your `access(request)` hook or identity does. See [Write a host](../extending/write-a-host.md).
- **The MCP server** has one caller, the person who started it, and applies none of this.

## Then Lenspack narrows

On top of what the host allows, a deployment can add:

| layer | decides | page |
|---|---|---|
| **Rights** | who may make boards, change the pack's own boards, read usage and administer | [Rights](rights.md) |
| **Admin and user access** | in Superset: who is an admin (roles, named people or a password) and who may use the assistant | [Who can use and administer the assistant](admin-access.md) |
| **Pack access rules** | by role: who may open each pack, which keys they may use, which rows | [Pack access rules](pack-rules.md) |
| **Row scope and tenancy** | which rows every query is held to | [Row scope and tenancy](scope-and-tenancy.md) |

Nothing in Lenspack's config can widen what the host allows.

## How the layers combine

One pure function, `decide()` in `@lenspack/policy`, settles what a caller may use of a pack. Every host with callers
goes through it: `lenspack serve` with any sign-in, the Superset host, and the importer APIs (see
[Importers](../extending/importers.md)). `lenspack-mcp` has one caller
and does not.

1. **The host says who the caller is and what it already allows.** The sign-in (or Superset, or an importer's API) gives
   an identity: user, roles, tenant, and whatever the host limits itself: a row scope, keys or tables it keeps from
   them, boards they may not open, capabilities it grants.
2. **Lenspack's rules only narrow it.** The rights by user and role add edit, maintain and usage rights. A pack's
   access rule adds its `scope` to the host's and the caller's, and its `hide` or `only` keys to the host's hidden
   keys.
3. **The engine enforces the result.** Every query carries the scope and is refused if it names a hidden key. The
   engine reads both by shape and does not know who decided them.

```
identity (host) ──► principalOf() ──► decide(pack) ──► { pack as they see it, ctx: scope + hidden keys }
                      + rights          + pack rules                       │
                                                                           ▼
                                                    every query: resolve() narrows it, or refuses
```

## Fail closed

Whenever Lenspack cannot tell, it shows less:

- a Superset row-level security rule it cannot translate keeps the whole dataset from that person;
- if Superset cannot be asked, the person sees nothing until it can;
- a query the scope cannot narrow is refused (`OUT_OF_SCOPE`), not answered for everyone;
- a key in a pack rule the pack does not have stops the server at start, so a typo cannot leave a key showing;
- a saved answer is only given to someone with the same access.

## What reaches the person

A refusal says why in words for them. Data the host keeps from them reads "not available to you: your Superset
access doesn't include it" (`ACCESS_HIDDEN`), not "not in the pack", and a person who may read nothing is told so
before any model is asked. A widget on a hidden key draws as "not available to you"; the rest of the board opens.

## Audit

Every change, refused change and denied request goes to the audit log with the user, pack, board and outcome.

## Planned

Policy becomes a document of its own, versioned like a pack or a board: rules, rights and per-role feature grants,
loaded by every host and edited from the admin panel. Inside Superset, queries run as the person asking. See
[Policy](../concepts/policy.md#where-it-lives) and [Access inside
Superset](superset.md#planned-superset-runs-each-query-as-the-person).

---

**Next:** [Sign-in](sign-in.md).

**Related:** [Policy](../concepts/policy.md) · [Why the model cannot break things](../architecture/safety.md) ·
[How access is tested](testing.md)
