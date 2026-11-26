# Write a source

This page shows how to connect Lenspack to a kind of system it does not ship with: a new SQL database (a driver), or
something that is not SQL at all (a connector). It is for developers. What a source is, and why it matters, is in
[Sources](../concepts/sources.md).

## Which one you need

- **A SQL database** that takes SQL text and bound parameters: write a **driver**. The planner, printer and every
  check are reused; you supply the database's rules and its connection. This is almost always the right choice.
- **Anything else** (a search engine, an analytics API, another BI tool): write a **connector**, which takes a bound
  plan and returns rows. The Elasticsearch and Superset connectors are examples.

## A new SQL database

### What a driver is

```ts
type Driver = {
  name: string;        // "mysql"; also the key a pack's per-dialect fragments use
  schemes: string[];   // ["mysql", "mariadb"]
  dialect: DialectRules;
  connect(url: string, opts?: { base?: string; defaultTimeoutMs?: number; maxRows?: number }): Promise<Connection>;
};

type Connection = {
  executor: Executor;                      // query(sql, params, { timeoutMs }) → rows, read-only
  writer?: Writer;                         // seeding and tests only; never handed to a tool or a model
  introspect(): Promise<SourceSchema>;     // tables, columns, types, row counts: `lenspack sources`
  close(): Promise<void>;
};
```

`registerDriver(driver)` adds one; `driverFor(url)` finds one; `openSource(url)` returns the connector the engine
runs boards on. Registering a driver also registers its dialect, so the compiler prints for it and a pack can carry
fragments under its name. Nothing under `packages/` changes. What a dialect answers is listed in
[SQL databases](../sources/sql.md#the-dialect); how each shipped driver keeps its guards is in
[The guards belong to the driver](../sources/sql.md#the-guards-belong-to-the-driver).

### Writing a driver

```ts
import { type Driver, postgresRules, registerDriver } from "@lenspack/sql";

registerDriver({
  name: "acme",
  schemes: ["acme"],
  dialect: { ...postgresRules, dialect: "acme", param: () => "?", capabilities: { percentiles: false } },
  async connect(url, opts) {
    const client = await AcmeClient.connect(url);
    return {
      executor: {
        dialect: "acme",
        async query(sql, params, o) {
          // read-only, one statement, a timeout and a row cap: here, not in the SQL
          return client.readOnly(sql, params, { timeoutMs: o?.timeoutMs ?? opts?.defaultTimeoutMs, maxRows: opts?.maxRows });
        },
      },
      introspect: async () => ({ collections: await client.tables() }),
      close: () => client.close(),
    };
  },
});
```

Start from the closest dialect and override what differs. Then prove it:

1. Add golden SQL for it in `packages/sources/sql/test/golden.test.ts` (a file per dialect, every node the planner emits).
2. Add it to `ENGINES` in `packages/sources/sql/test/drivers.test.ts`: every golden query must return DuckDB's numbers or the documented refusal, and a write, a second statement, a slow statement and an oversized result must each be stopped.
3. Add it to `ENGINES` in `examples/test/conformance.test.ts` with a dialect for `examples/_shared/seed-util.ts`: every example board and every dimension × measure × shape must agree with DuckDB.
4. Add a service for it to `.github/workflows/ci.yml`.

## A connector

A connector is everything Lenspack knows about one kind of backend. The engine resolves a query against the pack
(keys, join paths, tenancy, time windows, capability refusals) and hands the connector a bound plan; the connector
turns it into something native and runs it. Nothing above it knows which backend it is talking to.

```ts
interface Connector {
  readonly kind: string;                    // "postgres", "elasticsearch", …; also the fragment key it reads
  readonly capabilities: Capabilities;      // what resolution refuses before calling you
  compile(bound: BoundPlan, pack: Pack): Plan | Promise<Plan>;     // { text, native, bound, approximate? }
  execute(plan: Plan, opts?: { timeoutMs?: number; ran?: (s: SourceStatement) => void }): Promise<WidgetData>;
  introspect?(): Promise<SourceSchema>;     // tables or indexes, fields and types: `lenspack sources`
  close?(): Promise<void>;
}
```

- `compile` returns a `Plan`: human-readable `text` (shown in "How this was worked out"), whatever `execute` needs
  in `native`, and `approximate: true` when some numbers will be estimates.
- `execute` runs it read-only, under `timeoutMs`, and calls `ran` with what it actually sent (the statement with its
  values, or a request body), once per statement.
- **Capabilities** say what the backend can do, so the engine refuses the rest up front with `NOT_SUPPORTED`:

| capability | meaning | absent means |
|---|---|---|
| `joins` | row-level joins between entities | (required) |
| `exactDistinct` | `count_distinct` is exact; false marks it ≈ | (required) |
| `exactPercentiles` | median, p90 and p95 are exact | (required) |
| `percentiles` | percentiles can be computed at all | true |
| `zonedBuckets` | series buckets can start at local hours and days in the pack's time zone | true |
| `twoStage` | measures with `per` | true |
| `timeHeatmap` | a heatmap's columns can be time buckets | true |
| `points` | map queries | **false**: a connector must say it can |
| `heatmap` | heatmaps may be made (a deployment can turn them off) | true |
| `savedCompute` | where widgets are kept as the host's own charts: why one with this compute cannot be kept | any compute is kept |

The engine does the rest: compute steps, share and Other, ratios across entities, and the words of the answer.
Prove a connector the way the Elasticsearch one is proven: run an example pack on it and on DuckDB, and require the
same numbers.

**Today**, `lenspack serve` opens the source kinds it knows (SQL URLs, `elasticsearch`, `opensearch`), so a new
connector runs in a server you build with `createApp` (see [The standalone server](../hosts/serve.md#as-a-library)).
**Planned:** a registry of sources, like the driver registry, so `lenspack.yaml` can name a connector the repository
does not ship.

---

**Next:** [Write a host](write-a-host.md).

**Related:** [SQL databases](../sources/sql.md) · [Elasticsearch](../sources/elasticsearch.md) ·
[The life of a query](../architecture/life-of-a-query.md)
