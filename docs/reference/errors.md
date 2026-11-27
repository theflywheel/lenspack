# Refusal codes

This page lists every code a query can be refused with, what it means and what to do. It is for developers reading
refusals in API answers, and for pack authors working out why a question was turned down.

A refusal is not a failure. It is the compiler saying a query cannot be answered correctly from this pack, on this
source, for this person, before anything reaches the database. Every refusal (`ResolveError` in `@lenspack/engine`)
carries:

- `code`: one of the codes below;
- a message in plain words, which the model reads and usually acts on;
- `key`: the key it is about, when there is one;
- `nearest`: the nearest key that would work, when there is one ("did you mean `country`?").

| code | means | what to do |
|---|---|---|
| `UNKNOWN_MEASURE` | the measure is not in the pack | use `nearest`, or add the measure to the pack |
| `UNKNOWN_DIMENSION` | the dimension is not in the pack | use `nearest`, or add it |
| `UNKNOWN_ENTITY` | a rows or points query names an entity the pack does not have | use `nearest` |
| `NO_JOIN_PATH` | no declared join reaches the dimension's entity from the measure's | declare the join, if one is real |
| `FANOUT_REFUSED` | the only path crosses a `one_to_many` join, so grouping would count rows more than once | use a measure on the far entity, or a dimension on the measure's own entity; the message names both. See [Entities and joins](../concepts/entities.md#fan-out) |
| `NEEDS_JOIN` | the source cannot join (a search index) and the dimension lives on another entity | use a dimension on the measure's entity (the message lists them), or give the dimension an `also` entry on it |
| `TENANT_REQUIRED` | the entity declares a tenant and the query has none | the host must supply the tenant. See [Scope and tenancy](../access/scope-and-tenancy.md) |
| `NO_TIME` | a series or a comparison over an entity with no `time` | give the entity a `time`, or ask a breakdown or value |
| `NEEDS_TIME_RANGE` | a previous-period comparison without a time range | add `time`, such as `{ last: "30d" }` |
| `WRONG_ENTITY` | a key belongs to another entity than the query's root (a rows column, a point's size) | use a key on that entity |
| `TIME_DIMENSION` | a breakdown by a time dimension | use a series |
| `OUT_OF_SCOPE` | the person's view is limited by a dimension this entity cannot be narrowed by, so its rows cannot be shown safely | nothing on the query side; see [Scope and tenancy](../access/scope-and-tenancy.md) |
| `NOT_PERMITTED` | the pack's access rules hide this key from the person | see [Pack access rules](../access/pack-rules.md) |
| `ACCESS_HIDDEN` | the host keeps this key from the person (their Superset access), with the reason in words, so it is not mistaken for "not in the pack" | give access in the host. See [Access inside Superset](../access/superset.md) |
| `UNAVAILABLE` | the source can't answer this key right now: what it reads is not collected or not set up (for example a telemetry field switched off). The refusal carries the host's `notice`, words and an optional link, which a board shows in place of the widget's figure | what the notice says, such as switching the field on |
| `TOO_HEAVY` | the query is past one of the deployment's query limits: grouping by a column with a value per record, a series with too many points, too long a time range, too many groups or rows, or too many queries in one question. The message says what to ask instead | ask for a coarser level or grain, a shorter range, fewer rows; see [Query safety](../operating/query-safety.md) |
| `NOT_SUPPORTED` | what the source cannot compute: a percentile on MySQL or SQLite, a two-stage `per` measure on Elasticsearch, a zoned series on SQLite or MySQL, a fragment with no entry for this database, `compare` on a cross-entity ratio, a filter that cannot narrow every operand | use another measure or shape, or a source that can. See [SQL databases](../sources/sql.md#capability-matrix) |

`GET /api/<pack>/explain?q=…` also answers `{ ok: false, code: "INVALID" }` for a query that is not well formed (a
missing field, a wrong type), before any of the checks above.

---

**Next:** [Packages](packages.md).

**Related:** [The life of a query](../architecture/life-of-a-query.md) · [Query format](query.md) ·
[Troubleshooting](../operating/troubleshooting.md)
