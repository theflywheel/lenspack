# Claims the build checks

This page lists what Lenspack's test suite holds true on every build, and fails the build over. It is for anyone
judging whether the design's promises are kept, and for contributors who break one.

Lenspack came out of a tool whose dashboard logic was tied to one schema. These checks keep it general:

| check | what it holds |
|---|---|
| Every SQL database, same answer | Every example board, and every dimension × measure × shape of every example pack, runs on Postgres, MySQL, MariaDB, SQLite and ClickHouse and must return DuckDB's numbers. A percentile on a database without one (MySQL, SQLite) must come back as the documented refusal and nothing else. Saved files pin the SQL each database is sent. |
| One pack, two kinds of source | The `campaign` pack returns the same numbers from DuckDB and from a real Elasticsearch (7.17), on more than 100 queries. It is the one pack run on Elasticsearch: the others use joins, which a search index does not have. |
| One edit suite, every pack | The core's tests run over every example catalogue, not just the one they were written for. |
| No domain words in the code | The build fails if the kernel, the sources or the hosts' own code contain a word from any example domain (`pnpm lint:domain`). |
| Pack conformance | Every dimension × measure × shape compiles or fails with a documented reason; every declared fan-out is refused; tenancy is present. |
| The docs match the code | The key tables in [Configuration keys](../reference/config.md#every-key) and [Pack file](../reference/pack.md#every-key) are generated from the schemas, and `pnpm lint:docs` fails when they drift. |

The databases run in CI as services: Postgres 16, MySQL 8.4, MariaDB 11, ClickHouse 25.8 and Elasticsearch 7.17.
The examples are listed in [The example packs](../getting-started/examples.md).

One aim is not a build check, because no test can time it: a new pack should take under an hour to write and change
nothing under `packages/`. [Write a pack](../extending/write-a-pack.md) holds it as the target.

---

**Next:** [Features](../features/README.md).

**Related:** [Why the model cannot break things](safety.md) · [The example packs](../getting-started/examples.md) ·
[Evals](../reference/evals.md)
