# Glossary

This page defines the words these docs use, each in a sentence or two, with a link to the page that explains it. It
is for anyone who meets a term and wants its meaning fast.

| term | meaning |
|---|---|
| **access rule** | a line in a pack's `access:` that says, by role, who may open the pack, which keys they may use and which rows they see. [Pack access rules](../access/pack-rules.md) |
| **adapter** (chart) | the one component that draws a chart with a given charting library. Boards never name a library. [React components](../hosts/react.md#chart-libraries-are-adapters) |
| **adapter** (model) | the code that talks to one kind of model provider. [Add a model provider](../extending/model-adapter.md) |
| **admin** | someone with the `admin` role: they may open the admin panel. [Rights](../access/rights.md#admin) |
| **answer card** | the record behind "How this was worked out" under an answer. [How this was worked out](../features/explain.md) |
| **board** | a dashboard as a document of widgets, filters and layout, with no code in it. [Boards and widgets](../concepts/boards.md) |
| **catalogue** | the keys of a pack, with labels and hints, as one person may see them. It is what the model is shown. [Packs](../concepts/packs.md) |
| **compute step** | arithmetic done after the source answers: ratios, changes, rolling windows, running totals, summaries over time. [The compute step](../features/compute.md) |
| **connector** | the code that runs queries against one kind of source and says what it can do. [Sources](../concepts/sources.md) |
| **definition** | an admin's note on what a word means for this deployment, added on top of the pack without a release. [Definitions and open questions](../concepts/definitions.md) |
| **dimension** | something to group or filter by, such as `country`. [Dimensions](../concepts/dimensions.md) |
| **edit operation** | one of ten checked changes to a board, such as `add_widget`. The only way a board changes. [Board format](board.md#edit-operations) |
| **entity** | one table in a pack, with its grain, time column and joins. [Entities and joins](../concepts/entities.md) |
| **fan-out** | counting rows more than once by grouping across a one-to-many join. Lenspack refuses it. [Entities and joins](../concepts/entities.md#fan-out) |
| **fragment** | a piece of SQL in a pack, trusted and reviewed like code, never from a request. [Pack file reference](pack.md#fragments) |
| **grain** | what one row of an entity is: "one row per order". |
| **host** | the app Lenspack runs inside: Superset, the standalone server, your React app, an MCP client. [Hosts](../concepts/hosts.md) |
| **kernel** | the packages every deployment uses: core, pack, policy, engine and agent. [The kernel](../architecture/kernel.md) |
| **maintainer** | someone who may change a pack's own boards. [Rights](../access/rights.md) |
| **measure** | something to count or add up, such as `revenue`. [Measures and the compute step](../concepts/measures.md) |
| **open question** | a question people asked that has two sane readings, kept for an admin to settle. [Definitions and open questions](../concepts/definitions.md) |
| **pack** | a reviewed file that describes your data: entities, dimensions, measures and joins. [Packs](../concepts/packs.md) |
| **policy** | who may see and change what, decided per request. [Policy](../concepts/policy.md) |
| **principal** | the person asking, as Lenspack sees them: user, roles, tenant, scope and rights. [Rights](../access/rights.md) |
| **query** | a request for numbers that names pack keys, in one of five shapes. [Queries](../concepts/queries.md) |
| **refusal** | the compiler declining a query it cannot answer correctly, with a reason and the nearest key. [Refusal codes](errors.md) |
| **reviewer** | a model that checks the chat's edits before they are saved. [Review](../features/review.md) |
| **row scope** | filters the server puts on every query for a person, such as one region. [Scope and tenancy](../access/scope-and-tenancy.md) |
| **saved answer** | the plan behind an answer that went well, rerun on today's data when the question comes again, without the model. [Saved answers](../concepts/saved-answers.md) |
| **source** | where the numbers live: a database, a search index, or Superset. [Sources](../concepts/sources.md) |
| **switch** | a feature an admin can turn on or off while the server runs. [Feature switches](../operating/switches.md) |
| **tenant** | an owner of rows that must never see another's. A pack entity that declares a tenant cannot be queried without one. [Scope and tenancy](../access/scope-and-tenancy.md) |
| **turn** | one question or request in the chat, from start to finish. [Turns](../concepts/turns.md) |
| **verified** | a key that a person reviewed. Keys in a pack file are verified; a model's proposals start unverified. [Write a pack](../extending/write-a-pack.md#7-give-it-to-a-model) |
| **widget** | one tile on a board: a chart, a KPI, a table or a text. [Board format](board.md#widgets) |

---

**Next:** back to the [documentation home](../README.md).

**Related:** [Concepts](../concepts/README.md) · [Reference](README.md)
