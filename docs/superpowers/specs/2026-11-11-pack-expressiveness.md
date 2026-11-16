# How far can packs go? An expressiveness review

Status: evaluation, 2026-11-11. Nothing built. The model keeps naming keys;
this asks what packs and the query IR would need to answer more.

## Method

Twenty questions a campaign team asks of health-campaign data (registration,
delivery, referral and stock records; Elasticsearch, so no joins), each
mapped to today's pack + IR. "Yes" means a pack author can define it and the
model can ask for it; "partly" means a workaround with a cost; "no" means
neither can.

| # | Question | Today | What is missing |
|---|---|---|---|
| 1 | Doses delivered by district, this cycle | yes | |
| 2 | Coverage: delivered / target, by district | yes | `levels` + cross-entity derived |
| 3 | Delivery rate by product, vs last week | yes | `compare` |
| 4 | Received − dispatched per facility (stock balance) | yes | derived `a - b` on one entity |
| 5 | Delivered vs ineligible vs referred, side by side | yes | further `measures` |
| 6 | Cycle 02 against cycle 01, by district | partly | a breakdown `by: cycle` draws it; no delta per group |
| 7 | Cumulative doses through the campaign, against target | no | running totals in a series |
| 8 | 7-day moving average of daily visits | no | windowed series |
| 9 | Wards below 80% coverage | no | a filter on a group's measure value (HAVING) |
| 10 | Deliveries per field worker per day, and who falls under 20 | no on ES | two-stage `per` is refused on ES; group-level HAVING |
| 11 | Average children dosed per household | no on ES | two-stage `per` on ES |
| 12 | Beneficiaries dosed twice in one cycle (data quality) | no on ES | `per` + `having` on ES |
| 13 | Households registered but never visited | no | a filter on keys present / absent in another entity |
| 14 | Children referred who were later seen at a facility | no | as 13, the other way round |
| 15 | Household size distribution (1, 2–3, 4–6, 7+) | partly | a number dimension groups by each value; no bins |
| 16 | Visits by hour of day / day of week | partly | needs a Painless fragment per pack; no built-in date parts |
| 17 | Doses this campaign against the same campaign last year | no | `compare` only reads the period just before |
| 18 | Top 3 districts in each region | no | top-N within groups |
| 19 | "NORTH" and "North" counted as one region | no | dimension value normalisation |
| 20 | Median time from registration to delivery | no on ES | a duration across two entities needs a join |

Eight of twenty fully, three partly, nine not. Of the nine, seven are
closable inside the pack model; 13/14 need a new filter kind; 20 needs a join
Elasticsearch cannot do and stays out (index-time enrichment is the answer
there, not Lenspack).

## Proposed additions, by value for the cost

Each keeps the model naming keys and the compiler writing the query. Each has
a SQL form and an Elasticsearch form, so no backend falls behind.

### 1. Two-stage `per` on Elasticsearch (closes 10, 11, 12)

Already in the pack spec and on every SQL driver; refused on ES only because
the connector does not build it. ES pipeline aggregations do it natively: a
`terms` (or `composite`) aggregation on the key, the inner metric, then
`avg_bucket` / `sum_bucket` / `max_bucket` / `percentiles_bucket`, and
`bucket_selector` for `having`. The catch is key count: workers (hundreds)
fit in one `terms`; households (often 100k+) exceed `search.max_buckets`, so large
keys page with `composite` across requests, or the answer is refused with a
reason. Cost: medium, all in `@lenspack/elasticsearch`.

### 2. Group filters: `having` on a query (closes 9, half of 10)

```yaml
{ kind: breakdown, dimension: ward, measure: coverage, having: { op: lt, value: 0.8 } }
```

SQL: `HAVING`; ES: `bucket_selector`. Cross-entity measures filter after
they are combined. Works with `sort`/`limit` (filter first). Cost: low.

### 3. Windowed series (closes 7, 8)

```yaml
{ kind: series, measure: doses_delivered, grain: day, window: { kind: cumulative } }
{ kind: series, measure: visits, grain: day, window: { kind: moving_avg, size: 7 } }
```

SQL: window functions over the bucketed result; ES: `cumulative_sum`,
`moving_fn`. A cumulative series beside a timeless target (already
supported) gives "progress against target" in one widget. Cost: low–medium.

### 4. Key filters across entities (closes 13, 14)

```yaml
filters: [{ op: present_in, entity: task, key: household_ref }]   # or absent_in
```

SQL: `EXISTS` / `NOT EXISTS`. ES has no join, so the connector runs two
requests: collect the keys from the other entity (a `composite` aggregation,
paged), then filter with `terms`. ES caps a `terms` filter at 65,536 values
by default, so above that the answer is refused with a reason, not
truncated. The pack declares which key pairs are valid (`links:`), so the
model cannot invent a key relationship. Cost: medium–high; the one genuinely
new mechanism.

### 5. Dimension refinements (closes 15, 16, 19)

- `bins: [1, 2, 4, 7]` on a number dimension → `1`, `2–3`, `4–6`, `7+`. SQL `CASE`; ES `range` aggregation.
- `part: hour_of_day | day_of_week | month_of_year` on a time dimension, computed per dialect and in the pack's time zone. SQL date functions; ES a built-in script.
- `normalise: case | { map: {...} }`: groups merged at read time, for counts and sums (a distinct count cannot be merged, and is refused). The data-quality answer belongs upstream, but dashboards cannot wait for it.

Cost: low each.

### 6. Comparisons beyond the previous period (closes 6, 17)

- `compare: { offset: "1y" }` (or a `period` offset) reads any earlier window, not only the adjacent one.
- `compare: { dimension: cycle, value: "01" }` gives each group's delta against a named value of another dimension.

Cost: low (the first), medium (the second).

### 7. Top-N within groups (closes 18)

`breakdown` with `by` and `limitPerGroup`. SQL `ROW_NUMBER()`; ES nested
`terms` sizes. Cost: low. Lowest value of the set.

## Pack-authoring power, not only query power

The other way to get "more sophisticated" without touching the IR:

- **Measure templates.** One definition, many measures: `doses_by_product: { template: doses_delivered, each: product }` expands to a measure per value at load time. Today each is written by hand.
- **Shared filters.** Named `where` sets reused across measures (`delivered_spaq`), so a definition changes in one place.
- **Examples as tests.** `examples:` already resolve at startup; adding expected values against a fixture turns them into regression tests for the pack.
- **Generated packs.** `lenspack draft` from introspection exists; for HCM the boundary hierarchy, enums and `also:` blocks are mechanical and could be generated from the index mappings, leaving the author only the measures.

## Limits as configuration

Independent of the above: the caps that are code today (series 12,
breakdown 500, rows 1000, filters 20, chat steps 12, rounds 3, history 8,
query timeout, row cap, the cross-entity fetch of 10,000 groups) move into a
`policy:` block in `lenspack.yaml`, overridable per pack, with defaults equal
to today. Correctness guards (fan-out, unnarrowed filters) get `refuse`
(default) or `warn`. Read-only access, tenant and row scope, and "nothing in
a config is executed" stay invariants.

## Suggested order

1. `per` on ES, `having`, windowed series: the three that unlock the most HCM questions (7, 8, 9, 10, 11, 12) for the least new mechanism.
2. Dimension refinements and `compare` offsets.
3. Policy block.
4. Key filters across entities (13, 14), once the cap behaviour is agreed.
5. Templates and shared filters as packs grow.

The HCM eval should include these twenty questions, so each addition is
measured by how many it moves from "no" to "yes" and whether the model then
asks for it correctly.
