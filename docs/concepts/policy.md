# Policy

Policy decides what the person asking may see and change. This page gives the short version: three layers, and
one rule. It is for everyone; the [Access and policy](../access/README.md) section goes deeper.

## Three layers

1. **The host says who the caller is and what it already allows.** A user, their roles, their tenant, and whatever
   the host limits itself: rows they may not see, datasets kept from them, boards they may not open.
2. **Lenspack's rules only narrow it.** Rights by user and role add who may edit, maintain and read usage. A
   pack's access rules hide keys and add row filters. Nothing in Lenspack's config can widen what the host allows.
3. **The engine enforces the result.** Every query carries the person's row scope and is refused if it names a
   key hidden from them. The engine does not know who decided either; it reads them by shape.

```
host identity ──► decide() ──► { scope, hidden keys, kept entities, rights } ──► every query
   (Superset,       (kernel       narrowed, never widened                      (refused or
    sign-in)         policy)                                                     narrowed)
```

## The rule

**When Lenspack cannot tell, it shows less, never more.** A row-level security rule it cannot translate keeps the
whole dataset from that person. If Superset cannot be asked, the person sees nothing until it can. A query the
scope cannot narrow is refused rather than answered for everyone.

## What policy covers

- **Seeing**: which packs, keys, rows and boards a person may use.
- **Changing**: who may edit a board, change the pack's own boards, or use the admin pages.
- **Answering**: what "How this was worked out" may show a person (no SQL for someone with hidden keys), and whose
  saved answers they may be given (only answers made under the same access).

## Where it lives

All of these decisions are made in one place, the kernel's policy package, so every host asks the same questions
the same way. How it is built, and where it is going, is in [The kernel](../architecture/kernel.md#policy).

---

**Next:** [Definitions and open questions](definitions.md).

**Related:** [Who sees what](../access/README.md) · [The kernel](../architecture/kernel.md#policy)
