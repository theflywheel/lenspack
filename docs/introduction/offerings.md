# What you get

This page lists what Lenspack gives the people who use it and the people who run it, one paragraph each, with a
link to the page that explains it. It is for anyone weighing Lenspack up.

## For the people reading dashboards

**Answers in a chat, on top of the dashboard.** A chat panel sits on every dashboard. Ask "how many orders last
week, by country?" and the assistant runs the queries and answers with the numbers. It can work out rates,
changes, rolling averages and running totals from the pack's simple measures, without anyone adding a new measure
for each question. See [Answering questions](../features/answering.md) and [the compute step](../features/compute.md).

**Dashboard edits by asking.** "Add weekly revenue under the totals", "make that a line", "remove the pie". Every
change is a new version, any version can be restored, and a second model checks each change before it is saved.
See [Dashboard edits](../features/dashboard-edits.md).

**"How this was worked out", under every answer.** Each figure names the approved measure it came from, the filters and
dates it used, the SQL that ran and the rows behind it. See [How this was worked out](../features/explain.md).

**Voice and languages.** A microphone in the chat panel, and replies in English, French, Hindi or Portuguese.
See [Voice](../features/voice.md) and [Languages](../features/languages.md).

**Asking which reading was meant.** When a question can be read two ways that give different numbers, the
assistant asks, with buttons, or says which reading it used. See [Open questions and
definitions](../features/open-questions.md#clarify).

**Your own copy of a shared dashboard.** Inside Superset, someone who can only view a dashboard can copy it and
change the copy, or keep a layout they like under a name. See [Personal dashboards](../features/personal-dashboards.md).

## For the people running it

**Access that follows the host.** Inside Superset, each person sees only what Superset lets them see: their
datasets, their row-level security and the dashboards they may open. Lenspack's own rules can only narrow that.
When Lenspack cannot tell, it shows less. See [Who sees what](../access/README.md).

**Saved answers.** Most questions are asked again and again. Lenspack answers a repeated question by running the
same queries on today's data, without the model, and keeps the model for new questions. See
[Saved answers](../features/saved-answers.md).

**A daily review, open questions and definitions.** A log of questions with more than one reading, each reading's
figures side by side, and a layer of definitions admins add without a release. An optional daily review proposes
fixes for an admin to accept. See [Daily review](../features/open-questions.md).

**An admin panel.** One place for usage, the review, open questions, definitions, saved answers, telemetry and
every switch. Its overview is itself a Lenspack board. See [The admin panel](../features/admin-panel.md).

**Costs you can see and cap.** Every model call is metered by user, board and purpose. A daily budget, for the
server and per person, stops the chat before it spends past the cap. See [Costs](../operating/costs.md).

**Usage telemetry.** One record per chat turn, a thumbs up or down on answers, and a switch for each
item recorded. See [Usage telemetry](../features/telemetry.md).

**Your name on it.** Call the assistant something else and label its button your way, in each language. See
[Naming the assistant](../features/naming.md).

## For developers

**One pack, many databases.** Postgres, ClickHouse, DuckDB, SQLite, MySQL and MariaDB through read-only drivers,
plus Elasticsearch and OpenSearch, plus Superset's own datasets. A pack written with structured fields runs
unchanged on all of them. See [Sources](../sources/README.md).

**Boards in your own app.** React components draw any board with your choice of chart library. See
[React](../hosts/react.md).

**Tools for any model.** The agent's tools work in your own model loop or through an MCP server. See
[MCP](../hosts/mcp.md) and [Write a host](../extending/write-a-host.md).

---

**Next:** [What Lenspack does not do](limits.md).

**Related:** [All features](../features/README.md) · [Choose a host](../hosts/README.md)
