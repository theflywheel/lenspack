# Writing a pack for your own data

Target: under an hour, and nothing under `packages/` changes. If you find yourself editing the compiler, that is a bug report we want.

## 1. Pick the entities

One entity per table (or view) you want to measure. Name the grain in one line — it is shown to the model and it keeps you honest:

```yaml
entities:
  invoices: { source: billing.invoices, grain: one row per invoice, time: issued_at }
  accounts: { source: billing.accounts, grain: one row per account }
```

Prefer views over base tables when the raw shape is awkward ("latest run", soft deletes, unions). A view is the right place for `WHERE deleted_at IS NULL`.

## 2. Declare the joins, with their direction

```yaml
  invoices:
    joins:
      - { to: accounts, on: invoices.account_id = accounts.id, type: many_to_one }
```

`type` is what makes fan-out refusal possible. Many invoices → one account is `many_to_one`; declare the reverse on `accounts` as `one_to_many` if you want account-level measures to be able to reach invoice dimensions *the other way round* (they will be refused, correctly).

## 3. Dimensions

Anything you would `GROUP BY`. A column, an expression, or a JSON path:

```yaml
dimensions:
  - { key: plan,     entity: accounts, sql: plan, type: enum }
  - { key: region,   entity: accounts, json: [metadata, region] }
  - { key: issued,   entity: invoices, sql: issued_at, type: time, grains: [day, week, month] }
```

Add `synonyms` and a `hint` for anything a person might ask for by another name.

## 4. Measures

Anything you would put in `SELECT` with an aggregate:

```yaml
measures:
  - { key: invoices,   entity: invoices, agg: count }
  - { key: billed,     entity: invoices, agg: sum, sql: amount_cents / 100.0, format: currency }
  - { key: overdue_rate, entity: invoices, agg: avg, sql: "(status = 'overdue')::int", format: percent }
  - { key: avg_invoice, entity: invoices, derived: billed / invoices, format: currency }
  - { key: p90_days_to_pay, entity: invoices, agg: p90, sql: "EXTRACT(EPOCH FROM (paid_at - issued_at)) / 86400.0", format: duration }
```

Rules of thumb:
- A rate is `agg: avg` over a 0/1 expression. Never precompute per-group rates in a view and average them.
- A ratio of two aggregates is `derived`.
- A count of a subset is `agg: count` with a `filter`.
- If Postgres and DuckDB disagree on a function, use a per-dialect fragment: `sql: { postgres: "…", duckdb: "…" }`.

## 5. Tenancy

If rows belong to customers, say so once:

```yaml
  invoices: { …, tenant: org_id }
```

Every query over that entity now needs `ctx.tenant`, and the predicate is pushed into the subquery. There is no way to forget it.

## 6. Check it

```ts
import { loadPack, catalogueFrom } from "@lenspack/spec";
import { compile } from "@lenspack/sql";

const pack = await loadPack("./billing.yaml");           // throws PackError with every problem listed
const c = compile({ kind: "breakdown", dimension: "plan", measure: "billed", limit: 10 }, pack, { dialect: "postgres" });
console.log(c.sql, c.params);
```

Then run the conformance idea from `examples/test/conformance.test.ts` against your pack: every dimension × measure × shape should compile or refuse with a documented code, and something must be answerable for every measure.

## 7. Give it to a model

```bash
npx lenspack-mcp --pack ./billing.yaml --db postgres://… --tenant org_123
```

Ask for a board. When the model asks for something the pack cannot express, it will `propose_measure`; you review the proposal and add it to the pack with `verified: true`. That loop — model proposes, human verifies, catalogue grows — is how the vocabulary stays trustworthy.
