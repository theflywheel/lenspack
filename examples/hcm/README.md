# hcm

A health-campaign registry with the shape of DIGIT HCM: `household`, `address`, `individual`, `household_member`, `individual_identifier`, `project` (+ `project_address`), `project_beneficiary`, `project_task`, `task_resource`, `side_effect`, `referral` — the real column names and types from a UAT instance, and the real conventions that make it awkward:

- **every audit time is a `BIGINT` of epoch milliseconds** → the pack's `time:` is an expression per dialect (`AT TIME ZONE 'UTC'` on Postgres: lenspack treats naive time as UTC, and a `timestamptz` would follow the server's zone)
- **every table carries `isdeleted`** → each entity declares `filter: isdeleted = false`, so no query can forget it
- **dual keys** (`id` and `clientreferenceid`) and **one address row per task**
- **JSON in `additionaldetails` / `symptoms`** (jsonb on Postgres) → per-dialect fragments
- **a dotted project hierarchy** (`root.child.leaf`) → a view resolves `root` and `name`
- **fan-out on every side**: tasks → resources, tasks → side effects, households → members. "Success rate by product" is refused; "delivered rate by product" is the question the schema can answer

All data is synthetic (`seed.ts`); identifiers use the real `<keyId>|<base64>` cipher format with generated plaintexts. No real registry data is involved.
