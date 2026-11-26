# Row scope and tenancy

This page explains the two ways Lenspack narrows the rows a person can read: a tenant, which a pack declares, and a
row scope, which the host and the deployment set. It is for operators and anyone reviewing how one customer's or one
region's data is kept from another.

## Tenancy: declared by the pack

A pack whose rows belong to customers says so once, on the entity:

```yaml
entities:
  invoices: { source: billing.invoices, grain: one row per invoice, tenant: org_id }
  places:   { source: places, grain: one row per place, tenant: { field: path, match: subtree } }
```

- An entity that declares a `tenant` cannot be queried without one. The condition is pushed into that entity's
  subquery, so there is no way to forget it (`TENANT_REQUIRED` otherwise).
- `match: subtree` treats the tenant as a node of a dotted path: tenant `a.b` reads `a.b` and everything under it.
- The tenant comes from the host (a sign-in claim, a token's `tenant`, a proxy's tenant header), never from the model
  or the request.
- A tenant narrows the pack's tenancy; it can never open a pack the config pins to another tenant. Such a pack is not
  listed, and opening it answers 403.

## Row scope: set by the host and the deployment

A **row scope** is a list of filters every query a person runs carries: board widgets, filter menus, explain, the
chat's tools, on every source.

```yaml
scope: [{ dimension: country, op: in, value: [PT, ES] }]
```

It comes from three places, applied together:

1. **the pack's own context**, for a deployment that pins a pack to some rows;
2. **the caller**: a sign-in's claims, a token's `scope`, or the host (Superset's row-level security);
3. **the caller's pack access rule** (`scope:` in [Pack access rules](pack-rules.md)).

A clause may name an entity (`{ entity: customers, dimension: country, … }`); it then narrows only the queries that read
that entity, as a table's row-level security does. A host may also keep whole entities from a caller: their measures
and the dimensions only they have are hidden, and a query that reads one is refused (`NOT_PERMITTED`).

## Pinning every answer in Superset

In Superset, the pack's own row scope is `scope:` in `superset.yaml`. Every answer carries it, for everyone, whatever
they ask or pick on a dashboard. For a deployment that should only ever talk about one campaign:

```yaml
scope:
  - { dimension: campaign, op: eq, value: 2026-spring }
```

- `dimension` is a pack key (a column's key: `campaign` for a column `Campaign`), and `op` and `value` are a query
  filter's ([Filters](../concepts/filters.md)). A clause with `entity: orders` narrows only that dataset.
- It applies on every path that asks Superset for a number: the chat's tools, the explain card and `/explain`, saved
  answers (it is part of the access they are kept under, so one saved under it is never served without it), the
  suggested questions they feed, computed charts, board data and filter menus. It is added to the person's own
  Superset access and row-level security, never in place of it.
- A dashboard filter can't widen it. Picking another campaign on the dashboard adds that filter to the scope's, so the
  answer is empty, not another campaign's.
- A dataset without the column can't be narrowed, so a question about it is refused (`OUT_OF_SCOPE`). The startup log
  names such datasets. A clause on a dimension the pack doesn't have refuses every question, and the log says so.
- It narrows what Lenspack answers. Superset draws its own charts, including any chart the chat adds to a dashboard:
  give the dashboard a filter on the same column, or a row-level security rule, to pin those too.
- The settings API (`GET /_superset/settings`) shows it as `scope`.

## Failing closed

A query that a scope cannot narrow (its entity has no path to the scope's dimension) is refused with `OUT_OF_SCOPE`
rather than answered for all rows. Nothing the person does can remove a scope: a filter of their own can narrow
further, never widen.

Cached results are keyed by the compiled statement and its parameters, and saved answers by the access they were made
under, so one caller's rows are never served to another. See [Saved
answers](../concepts/saved-answers.md#the-safety-rule).

## Imported systems

An importer's API that answers another system's dashboards puts that system's row scope for the caller through the
same path. See [Importers](../extending/importers.md).

## `run_sql`

Raw SQL does not pass through the pack, so neither tenancy nor scope applies to it. It is refused on a scoped pack or
for a scoped caller unless enabled as `role-scoped`. See [`run_sql`](../architecture/safety.md#run_sql).

---

**Next:** [Access inside Superset](superset.md).

**Related:** [Filters](../concepts/filters.md#3-a-persons-row-scope) · [Entities and joins](../concepts/entities.md) ·
[The life of a query](../architecture/life-of-a-query.md#resolve)
