# What Lenspack does not do

This page lists the lines Lenspack never crosses, by design, and the things it does not do yet. Read it before you
plan a deployment, so nothing here surprises you later.

## Lines it never crosses

**The model never writes SQL for an answer.** It names keys from the pack, and the compiler writes the query. The
one exception is `run_sql`, a developer's tool that is off by default. When it is switched on it runs one
read-only statement, and its results can never become a widget. See [Why the model cannot break
things](../architecture/safety.md#run_sql).

**Lenspack never writes to your data.** Every query runs read-only, one statement at a time, under a time limit
and a row cap, enforced by the database driver rather than trusted from the SQL. Boards are kept apart from the
data, in their own store. Inside Superset, boards are Superset dashboards and charts: Lenspack writes those, never
the tables behind them. See [SQL databases](../sources/sql.md#the-guards-belong-to-the-driver).

**The model never changes the pack.** When it needs a measure the pack lacks, it can propose one. The proposal
is written to a file as unverified and does not enter the pack until a person adds it. See
[Write a pack](../extending/write-a-pack.md#7-give-it-to-a-model).

**Lenspack never decides who someone is.** The app it runs inside (Superset, a sign-in provider, a login proxy)
says who is asking. Lenspack's own rules can only take things away from what that app allows. See
[Who sees what](../access/README.md).

**A number it cannot get right is refused, not guessed.** Asking for an order-level measure split by something
that has many rows per order would count orders twice; the compiler refuses it and suggests a measure that works.
A percentile on a database without one is refused rather than estimated another way. A rate is never added up.
See [Entities and joins](../concepts/entities.md#fan-out) and [the compute step](../features/compute.md#how-zeros-and-gaps-are-treated).

**A board holds no code.** No URLs, no markup and no colour values. Text widgets are drawn as plain text, and a
colour scheme is a name the renderer maps to its own palette. See [Boards and widgets](../concepts/boards.md).

## Not built yet

These are known gaps. Each is a candidate for later work, not a promise.

- **Pre-aggregation and rollups.** Every query reads the source as it is.
- **Choosing measures by meaning.** A pack with hundreds of measures should keep its catalogue small or scope the
  model's `list_metrics` search with a query; there is no embedding search.
- **Warehouse drivers** such as BigQuery and Snowflake. See [Write a source](../extending/write-a-source.md).
- **Queries run as the person inside Superset.** Today Lenspack reads data through its own Superset account and
  applies each person's access itself. Planned: Superset runs each query as the person asking. See
  [Access inside Superset](../access/superset.md#planned-superset-runs-each-query-as-the-person).
- **Board history that survives a restart inside Superset.** Superset keeps the dashboards; Lenspack's own version
  history there is held in memory. See [Stores](../architecture/stores.md).
- **Bearer tokens from the sign-in provider** for API clients. The `oidc` sign-in covers browsers.
- **Sharing a board with groups, read-only links, and handing a board to another owner.**
- **Access rules inside the pack file.** They live in the deployment's config, because role names belong to a
  deployment and one pack serves several.
- **Filters on a group's value** ("regions below 80%"), counting groups ("how many regions are below 80%"), and
  periods tied to a calendar of your own ("round 2 against round 1"). See [the compute step](../features/compute.md).

---

**Next:** [Quick start](../getting-started/quickstart.md), or [Concepts](../concepts/README.md) if you would
rather read first.

**Related:** [What you get](offerings.md) · [Safety model](../architecture/safety.md)
