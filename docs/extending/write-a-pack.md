# Write a pack

This page covers the choices you make when writing a pack for a database of your own, with short fragments for a
made-up billing database. It is for developers and analysts who know their data. To learn by doing first, follow
[Tutorial: build a pack from scratch](../getting-started/tutorial.md), which runs end to end on data that ships with
the repository. The ideas behind each step are in [Concepts](../concepts/README.md); every key is in the [Pack file
reference](../reference/pack.md).

The aim: a new pack takes under an hour, and nothing under `packages/` changes. If you find yourself editing the
compiler, that is a bug report we want.

Start by looking at what the database holds: `lenspack sources --config lenspack.yaml` lists tables, columns, types
and row counts.

## 1. Pick the entities

One entity per table (or view) you want to measure. Name the grain in one line: it is shown to the model, and it
keeps you honest.

```yaml
entities:
  invoices: { source: billing.invoices, grain: one row per invoice, time: issued_at }
  accounts: { source: billing.accounts, grain: one row per account }
```

Prefer views over base tables when the raw shape is awkward ("latest run", soft deletes, unions). A view is the
right place for `WHERE deleted_at IS NULL`; so is an entity `where:` or `filter:`, which every query on the entity
then carries.

## 2. Declare the joins, with their direction

```yaml
  invoices:
    joins:
      - { to: accounts, on: invoices.account_id = accounts.id, type: many_to_one }
```

`type` is what makes fan-out refusal possible. Many invoices to one account is `many_to_one`. Declare `one_to_many`
on `accounts` too. Lenspack will then refuse account measures grouped by invoice fields, with the reason, instead of
saying it found no join.

## 3. Dimensions

Anything you would `GROUP BY`: a column (`field`), an expression (`sql`), or a JSON path (`json`). Exactly one of the
three.

```yaml
dimensions:
  - { key: plan,     entity: accounts, field: plan, type: enum }
  - { key: region,   entity: accounts, json: [metadata, region] }
  - { key: issued,   entity: invoices, sql: issued_at, type: time, grains: [day, week, month] }
```

Add `synonyms` and a `hint` for anything a person might ask for by another name.

## 4. Measures

Anything you would put in `SELECT` with an aggregate. Keep them to simple counts and sums, with the filters that keep
them correct:

```yaml
measures:
  - { key: invoices, entity: invoices, agg: count }
  - { key: overdue,  entity: invoices, agg: count, where: [{ field: status, value: overdue }] }
  - { key: billed,   entity: invoices, agg: sum, sql: amount_cents / 100.0, format: currency }
  - { key: avg_invoice, entity: invoices, derived: billed / invoices, format: currency }
  - key: p90_days_to_pay
    entity: invoices
    agg: p90
    sql:                    # databases disagree on time arithmetic, so one fragment per database
      default: "EXTRACT(EPOCH FROM (paid_at - issued_at)) / 86400.0"      # Postgres, DuckDB
      mysql: "TIMESTAMPDIFF(SECOND, issued_at, paid_at) / 86400.0"
      sqlite: "(unixepoch(paid_at) - unixepoch(issued_at)) / 86400.0"
      clickhouse: "dateDiff('second', issued_at, paid_at) / 86400.0"
    format: duration
```

Rules of thumb:

- **Rates come from the compute step.** "The overdue rate" is `overdue` over `invoices`, a `ratio` step the assistant
  adds when asked; changes, rolling averages and averages per day are steps too. Do not add a measure per rate. See
  [Measures and the compute step](../concepts/measures.md#the-compute-step).
- **A ratio worth naming** (average invoice) can be `derived`: arithmetic over other measures, which may live on
  different entities.
- **A count of a subset** is `agg: count` with a `where` (or a SQL `filter`).
- A rate written as `agg: avg` over a 0/1 expression (`CASE WHEN status = 'overdue' THEN 1 ELSE 0 END`) also works,
  and the older example packs use it. Never precompute per-group rates in a view and average them.
- **Write fragments every database reads** (`CASE WHEN … THEN 1 ELSE 0 END`, not `::int`), or name columns with
  `field:` and conditions with `where:`, which every source understands. Where databases genuinely disagree on a
  function, use a per-database fragment: `sql: { default: "…", mysql: "…", sqlite: "…", clickhouse: "…" }`. See
  [SQL databases](../sources/sql.md#pack-fragments).

## 5. Tenancy

If rows belong to customers, say so once:

```yaml
  invoices: { …, tenant: org_id }
```

Every query over that entity now needs a tenant from the host, and the condition is pushed into the subquery. There
is no way to forget it. See [Row scope and tenancy](../access/scope-and-tenancy.md).

## 6. Check it

From the command line, with the pack in a `lenspack.yaml`:

```bash
lenspack check --config lenspack.yaml     # loads every pack, draws every board, exits 1 on any error
```

Or in code:

```ts
import { loadPack, catalogueFrom } from "@lenspack/pack";
import { compile } from "@lenspack/sql";

const pack = await loadPack("./billing.yaml");           // throws PackError with every problem listed
const c = compile({ kind: "breakdown", dimension: "plan", measure: "billed", limit: 10 }, pack, { dialect: "postgres" });
console.log(c.sql, c.params);
```

Then run the conformance idea from `examples/test/conformance.test.ts` against your pack: every dimension × measure ×
shape should compile or refuse with a documented code, and something must be answerable for every measure.

## 7. Give it to a model

```bash
lenspack-mcp --pack ./billing.yaml --db postgres://… --tenant org_123
```

Ask for a board. When the model asks for something the pack cannot express, it will `propose_measure`. The proposal
is written to `<pack>.proposals.json` (beside `lenspack.yaml`, or in the folder `proposals:` names), marked
unverified. You review it and add it to the pack file; a key in a pack file is verified by the review
that merged it. That loop (the model proposes, a person verifies, the catalogue grows) is how the vocabulary stays
trustworthy.

## 8. Write instructions and examples

Rules the keys cannot say go in `instructions:` (at most 2,000 characters), sent to the model on every turn: "Revenue
is after refunds", "Weeks start on Monday". Questions people will ask, each with the query someone checked, go in
`examples:` (at most 12). Keep values (names, figures) out of both: everyone who may open the pack sees them.

Once the pack is in use, admins can add definitions on top of it without editing the file. See
[Definitions and open questions](../concepts/definitions.md).

---

**Next:** [Write a source](write-a-source.md).

**Related:** [Tutorial: build a pack](../getting-started/tutorial.md) · [Pack file reference](../reference/pack.md) ·
[Packs](../concepts/packs.md) · [Your own data](../getting-started/your-own-data.md)
