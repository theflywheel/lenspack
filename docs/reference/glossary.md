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
| **daily review** | an optional job, off by default, that reads the day's chat turns once a day and proposes changes to the definitions. Not the same as the reviewer. [Open questions and definitions](../features/open-questions.md#the-daily-review) |
| **definition** | an admin's note on what a word means for this deployment, added on top of the pack without a release. [Definitions and open questions](../concepts/definitions.md) |
| **dimension** | something to group or filter by, such as `country`. [Dimensions](../concepts/dimensions.md) |
| **edit operation** | one of ten checked changes to a board, such as `add_widget`. The only way a board changes. [Board format](board.md#edit-operations) |
| **entity** | one table in a pack, with its grain, time column and joins. [Entities and joins](../concepts/entities.md) |
| **escalation model** | the model that runs the fix round after the reviewer finds a material problem; the builder, unless a role names another. [Chat models](../operating/models.md#roles) |
| **fan-out** | counting rows more than once by grouping across a one-to-many join. Lenspack refuses it. [Entities and joins](../concepts/entities.md#fan-out) |
| **fragment** | a piece of SQL in a pack, trusted and reviewed like code, never from a request. [Pack file reference](pack.md#fragments) |
| **grain** | what one row of an entity is: "one row per order". |
| **host** | the app Lenspack runs inside: Superset, the standalone server, your React app, an MCP client. [Hosts](../concepts/hosts.md) |
| **host policy** | `hostPolicy` in the Superset host: whether each person's Superset access narrows what Lenspack shows them (`superset`, the default) or not (`off`). [Access inside Superset](../access/superset.md) |
| **kernel** | the packages every deployment uses: core, pack, policy, engine and agent. [The kernel](../architecture/kernel.md) |
| **maintainer** | someone who may change a pack's own boards. [Rights](../access/rights.md) |
| **measure** | something to count or add up, such as `revenue`. [Measures and the compute step](../concepts/measures.md) |
| **open question** | a question people asked that has two sane readings, kept for an admin to settle. [Definitions and open questions](../concepts/definitions.md) |
| **overlay** | `overlay:` in `superset.yaml`: what a pack needs that Superset has no field for, such as instructions, hierarchies and example questions. [Datasets and dashboards](../hosts/superset/datasets-and-dashboards.md#the-overlay) |
| **pack** | a reviewed file that describes your data: entities, dimensions, measures and joins. [Packs](../concepts/packs.md) |
| **policy** | who may see and change what, decided per request. [Policy](../concepts/policy.md) |
| **principal** | the person asking, as Lenspack sees them: user, roles, tenant, scope and rights. [Rights](../access/rights.md) |
| **publicPath** | the path in front of every Lenspack route when it sits behind Superset, usually `/lenspack`. [Configuration keys](config.md#supersetyaml) |
| **query** | a request for numbers that names pack keys, in one of five shapes. [Queries](../concepts/queries.md) |
| **refusal** | the compiler declining a query it cannot answer correctly, with a reason and the nearest key. [Refusal codes](errors.md) |
| **reviewer** | a second model call that checks the chat's edits against the request before they are saved. Not the same as the daily review. [The reviewer](../features/dashboard-edits.md#the-reviewer) |
| **router** | the small model that matches a question in new words to a saved answer. [Saved answers](../features/saved-answers.md#the-tiers-cheapest-first) |
| **row scope** | filters the server puts on every query for a person, such as one country. [Scope and tenancy](../access/scope-and-tenancy.md) |
| **row-level security (RLS)** | a database or Superset rule that limits which rows a person sees, such as `country = 'PT'`. Lenspack turns Superset's RLS into a row scope. [Access inside Superset](../access/superset.md) |
| **saved answer** | the plan behind an answer that went well, rerun on today's data when the question comes again, without the model. [Saved answers](../concepts/saved-answers.md) |
| **settled board** | a board with no change in the last week; saved answers pay off most there. [Saved answers](../features/saved-answers.md#dashboards-settle) |
| **source** | where the numbers live: a database, a search index, or Superset. [Sources](../concepts/sources.md) |
| **staged edit** | a chat edit held as a draft until the reviewer has checked it; also called a draft edit. Nothing is saved until the turn ends well. [The reviewer](../features/dashboard-edits.md#the-reviewer) |
| **state directory** | the folder where a running server keeps what it learns: board bookkeeping, settings, the audit log, saved answers, telemetry. [What Lenspack keeps on disk](../operating/state.md#the-state-directory) |
| **switch** | a feature an admin can turn on or off while the server runs. [Feature switches](../operating/switches.md) |
| **tenant** | an owner of rows that must never see another's. A pack entity that declares a tenant cannot be queried without one. [Scope and tenancy](../access/scope-and-tenancy.md) |
| **tier** | one of the four ways a saved answer can be reused, from sending the saved reply as it is to a small model matching new words. [Saved answers](../features/saved-answers.md#the-tiers-cheapest-first) |
| **turn** | one question or request in the chat, from start to finish. [Turns](../concepts/turns.md) |
| **verified** | a key that a person reviewed. Keys in a pack file are verified; a model's proposals start unverified. [Write a pack](../extending/write-a-pack.md#7-give-it-to-a-model) |
| **widget** | one tile on a board: a chart, a KPI, a table or a text. [Board format](board.md#widgets) |

---

**Next:** [How access is tested](../access/testing.md).

**Related:** [Concepts](../concepts/README.md) · [Reference](README.md)
