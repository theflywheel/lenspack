# Tutorial: build a pack from scratch

This tutorial builds a pack for a made-up support desk, one step at a time, and checks each step before the next.
It is for developers and analysts who have done the [Quick start](quickstart.md) and want to describe data of their
own. Allow 30 minutes. No model key is needed until the last step.

You will end with a pack, a board drawn from it, and a server that answers and refuses questions the way the
example packs do. The finished pack is close to [`examples/tickets/pack.yaml`](../../examples/tickets/pack.yaml),
so you can compare when you are done.

## Before you start

You need a clone of the repository with its packages built:

```bash
git clone https://github.com/theflywheel/lenspack && cd lenspack
pnpm install && pnpm build
```

The commands below call the `lenspack` command as `node packages/hosts/serve/dist/cli.js`. Work in a new folder
inside the clone, say `desk/`, and set a short name for the command:

```bash
mkdir desk && cd desk
alias lenspack="node ../packages/hosts/serve/dist/cli.js"
```

## 1. Make the data

```bash
(cd .. && pnpm seed tickets desk/tickets.duckdb)
```

This writes 4,000 made-up support tickets and their status history into a DuckDB file. The tickets run up to 31
August 2026, so ask about dates before then.

## 2. Point a config at it

Create `lenspack.yaml`:

```yaml
sources:
  desk: { url: duckdb:./tickets.duckdb }
packs:
  - { pack: ./tickets.pack.yaml, source: desk, boards: ./boards }
store: { kind: duckdb, path: ./boards.duckdb }   # where edited boards are kept; never in a source
auth: { kind: none }                             # no sign-in: this machine only
```

Then make an empty `boards` folder (`mkdir boards`) and ask what the database holds:

```bash
lenspack sources --config lenspack.yaml
```

**Checkpoint.** You see two tables and their columns:

```
desk (duckdb)
  status_history (~10421 rows)
    id: integer
    ticket_id: integer
    status: varchar
    changed_at: timestamp
  tickets (~4000 rows)
    id: integer
    created_at: timestamp
    team: varchar
    priority: varchar
    status: varchar
    channel: varchar
    resolved_at: timestamp
    sla_hours: integer
    first_response_minutes: integer
```

## 3. The smallest pack

A pack needs one entity (a table, and what one row is), one dimension (something to group by) and one measure
(something to count). Create `tickets.pack.yaml`:

```yaml
pack: tickets
version: 1
entities:
  tickets:
    source: tickets
    grain: one row per ticket
    time: created_at
dimensions:
  - { key: team, entity: tickets, field: team }
measures:
  - { key: tickets, entity: tickets, agg: count }
```

```bash
lenspack check --config lenspack.yaml
```

**Checkpoint.** `every widget drew`, and the command exits 0. There are no boards yet, so nothing was drawn, but
the pack loaded.

Now make a mistake on purpose. Add a measure that names an entity that does not exist:

```yaml
  - { key: open, entity: ticket, agg: count }
```

**Checkpoint.** `lenspack check` now prints `Invalid pack: measures[1]: unknown entity "ticket"` and exits 1. A
pack with a mistake never loads, and every problem is listed. Fix the name to `tickets` before going on.

## 4. Measures people ask for

Keep measures simple: counts and sums, each with the filter that makes it right. Replace the `measures:` list:

```yaml
measures:
  - { key: tickets,  entity: tickets, agg: count, label: Tickets }
  - { key: open,     entity: tickets, agg: count, where: [{ field: status, op: in, value: [open, pending] }],
      label: Open tickets, synonyms: [backlog] }
  - { key: resolved, entity: tickets, agg: count, where: [{ field: status, value: resolved }], label: Resolved tickets }
  - { key: first_response_min, entity: tickets, agg: avg, field: first_response_minutes,
      label: Mean first response (minutes) }
```

There is no `resolution_rate` measure, on purpose. "What share of tickets were resolved?" is `resolved` divided by
`tickets`, and the assistant gets it from the [compute step](../concepts/measures.md#the-compute-step) when someone
asks. A pack holds the base numbers; rates, changes and averages per day are worked out after.

`label` is what people see. `synonyms` are other words they use: someone who asks about "the backlog" gets `open`.

## 5. More dimensions

```yaml
dimensions:
  - { key: team,     entity: tickets, field: team, label: Team }
  - { key: priority, entity: tickets, field: priority, label: Priority, type: enum, hint: p1 is most urgent }
  - { key: status,   entity: tickets, field: status, label: Current status, type: enum }
  - { key: channel,  entity: tickets, field: channel, label: Channel, type: enum }
```

`type: enum` says the column holds a short fixed list, so a filter can offer its values. A `hint` is one line for
the model.

## 6. A second table, and the refusal

Each ticket has many rows in `status_history`, one per status it passed through. Add it as an entity and say which
way the join goes:

```yaml
entities:
  tickets:
    source: tickets
    grain: one row per ticket
    time: created_at
    joins:
      - { to: status_history, on: status_history.ticket_id = tickets.id, type: one_to_many }
  status_history:
    source: status_history
    grain: one row per status change
    time: changed_at
    joins:
      - { to: tickets, on: status_history.ticket_id = tickets.id, type: many_to_one }
```

and a dimension and a measure on it:

```yaml
  - { key: transition, entity: status_history, field: status, label: Status entered }   # under dimensions:
  - { key: transitions, entity: status_history, agg: count, label: Status changes }     # under measures:
```

Now start the server:

```bash
lenspack serve --config lenspack.yaml        # http://127.0.0.1:8787
```

In another terminal, ask the server how it would answer a query, without running it. The `explain` route compiles
one query and returns the SQL, or the refusal:

```bash
curl -sG localhost:8787/api/tickets/explain --data-urlencode 'q={"kind":"breakdown","dimension":"team","measure":"open"}'
```

**Checkpoint.** `"ok": true`, with the SQL it would send: a count of open and pending tickets, grouped by team.

Now ask for tickets grouped by the status they entered:

```bash
curl -sG localhost:8787/api/tickets/explain --data-urlencode 'q={"kind":"breakdown","dimension":"transition","measure":"tickets"}'
```

**Checkpoint.** A refusal:

```json
{ "ok": false, "code": "FANOUT_REFUSED",
  "error": "\"transition\" lives on \"status_history\", which has many rows per \"tickets\" row; grouping a tickets-level measure by it would multiply the numbers. Measure one of these instead: transitions. Or keep the measure and group by a dimension on \"tickets\": team, priority, status, channel.",
  "nearest": "transitions", "key": "transition" }
```

A ticket that passed through three statuses would be counted three times. Lenspack refuses instead of giving a
number that is too big, and says what would work: count `transitions` instead. The `type:` on each join is what
lets it know. A typo is caught the same way: `"dimension": "tem"` is refused with `UNKNOWN_DIMENSION` and
`"nearest": "team"`.

## 7. A first board

A board is a JSON file of edit operations. Stop the server (Ctrl-C), then create `boards/desk.json`:

```json
{
  "title": "Support desk",
  "ops": [
    { "op": "add_widget", "id": "backlog", "placement": { "place": "top", "width": "third", "height": 3 },
      "widget": { "kind": "kpi", "title": "Open tickets", "query": { "kind": "value", "measure": "open" } } },
    { "op": "add_widget", "id": "by_team", "placement": { "place": "bottom", "width": "half", "height": 7 },
      "widget": { "kind": "chart", "chart": "bar", "title": "Open tickets by team",
                  "query": { "kind": "breakdown", "dimension": "team", "measure": "open" } } },
    { "op": "add_widget", "id": "weekly", "placement": { "place": "bottom", "width": "half", "height": 7 },
      "widget": { "kind": "chart", "chart": "line", "title": "Tickets per week",
                  "query": { "kind": "series", "measure": "tickets", "grain": "week" } } }
  ]
}
```

```bash
lenspack check --config lenspack.yaml
```

**Checkpoint.** `tickets/desk: 3 widgets drawn on duckdb`, then `every widget drew`. `lenspack check` runs every
widget of every board against the database, so a board that cannot be drawn fails here, before anyone opens it.
Stop the server before running it: both use the board store.

Start the server again and read the board's numbers:

```bash
lenspack serve --config lenspack.yaml
curl -s localhost:8787/api/tickets/desk/data
```

**Checkpoint.** A JSON object with one entry per widget: `backlog` is 365 open tickets, `by_team` has four rows
(access, platform, billing, mobile), `weekly` a row per week.

Edits go through the same checks. Adding the refused query from step 6 as a widget fails with the same message, and
the board does not change:

```bash
curl -s -X POST localhost:8787/api/tickets/desk/ops -H 'content-type: application/json' -d '{"ops":[
  {"op":"add_widget","id":"funnel","placement":{"place":"bottom","width":"half","height":7},
   "widget":{"kind":"chart","chart":"bar","title":"Tickets by status entered",
             "query":{"kind":"breakdown","dimension":"transition","measure":"tickets"}}}]}'
```

Change `"measure":"tickets"` to `"measure":"transitions"` and the widget is added, as a new version of the board.

## 8. A duration, on every database

How long a ticket takes to resolve is the time between two columns. Databases write that differently, so give one
SQL fragment per database, with `default` for the rest:

```yaml
  - key: median_hours_to_resolve
    entity: tickets
    agg: median
    sql:
      default: "EXTRACT(EPOCH FROM (resolved_at - created_at)) / 3600.0"     # Postgres, DuckDB
      mysql: "TIMESTAMPDIFF(MICROSECOND, created_at, resolved_at) / 3.6e9"
      sqlite: "(unixepoch(resolved_at) - unixepoch(created_at)) / 3600.0"
      clickhouse: "dateDiff('millisecond', created_at, resolved_at) / 3600000.0"
    format: duration
    label: Median hours to resolve
    hint: Only resolved tickets have a value.
```

Run `lenspack check` again. When a fragment is needed at all, prefer `field:` and `where:`, which every source reads
the same way. See [SQL databases](../sources/sql.md#pack-fragments).

## 9. Rules and examples for the model

Two last keys help the model. `instructions` holds rules the keys cannot say. `examples` holds questions people will
ask, each with the query someone checked:

```yaml
description: A support desk's tickets and their status history.
instructions: Compare resolution times on the median, never on a mean; a few long-stuck tickets dominate a mean.
examples:
  - question: How often do tickets get escalated?
    query: { kind: value, measure: transitions, filters: [{ dimension: transition, op: eq, value: escalated }] }
```

`lenspack check` also checks that every example's query is one the pack can answer.

## 10. Ask it

The chat needs a model. Give the server one through the environment (any OpenAI-compatible endpoint, or Claude; see
[Chat models](../operating/models.md)) and start it again. With the board app (`--ui <dir>`; see
[The standalone server](../hosts/serve.md)) or with `POST /api/tickets/desk/chat`, ask:

- *"Which team has the biggest backlog?"* The answer comes from `open`, by team.
- *"What share of tickets were resolved, by priority?"* The assistant divides `resolved` by `tickets` in the
  compute step. No new measure was needed.
- *"Tickets by the status they entered."* The assistant explains the refusal you saw in step 6 and offers status
  changes instead.

Open **How this was worked out** under an answer to see the measure, its definition, the SQL and the rows.

## What you built

A pack of two entities, five dimensions and six measures, a board, and a server that refuses what the data cannot
answer. Compare it with [`examples/tickets/pack.yaml`](../../examples/tickets/pack.yaml), which adds a creation-date
dimension, a 90th-percentile duration and an SLA breach rate.

For your own database, [Your own data](your-own-data.md) sets up a server with sign-in, and [Write a
pack](../extending/write-a-pack.md) covers the choices this tutorial did not meet: views, tenancy, JSON columns and
derived measures.

---

**Next:** [Your own data](your-own-data.md).

**Related:** [Write a pack](../extending/write-a-pack.md) · [Pack file reference](../reference/pack.md) ·
[The example packs](examples.md)
