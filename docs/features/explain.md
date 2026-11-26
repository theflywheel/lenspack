# How this was worked out

This page explains the line under every chat answer that shows where its numbers came from: what it shows, who
sees it, where it is kept and how to switch it. It is for anyone who reads answers, and for auditors.

Every chat answer that read data has one more line under it: **How this was worked out**. It opens to show
each data call the answer made, in the order made:

- **what was asked, in plain words**: the measure, filters, dates, grouping, cut-off, and each step computed after;
- **the SQL that ran**, or the search request for an Elasticsearch source, with a copy button;
- **the rows that came back**: the first 20, and how many there were in all;
- **the dashboard filters the viewer had picked** when they asked, and whether the answer used them.

Together these make the answer card: one record per answer of where its numbers came from.

## Why

A number in a chat reply is only as good as the query behind it. Lenspack's promise is that every figure comes
from a measure the pack approved, never from SQL a model made up. This line lets the reader check that for each
answer. They see which approved measure the figure came from, how it is defined, and what the data held. An
auditor finds the same record in the audit log, so an answer can still be checked after the conversation is gone.

## What it shows

**The words** are built from the query itself and the pack's labels and definitions. No model call writes them,
so they cannot claim something the query did not do. For example, on the `commerce` example pack, "revenue by
country, last 30 days" asked on 30 September 2026 reads:

> Revenue (sum of total_cents / 100.0, the pack's approved measure “revenue”), in the last 30 days (31 August to 30
> September 2026), grouped by country, top 5 by value.

and "average orders per day, by country, last month" adds the compute step:

> Orders (count of rows in orders (one row per order), the pack's approved measure “orders”), last month (1 to 31
> August 2026), grouped by country, top 5 by value. Then averaged per day, with days that had no orders counted as 0.

The words always say:

- which approved measure each figure came from, and its definition;
- the filters and the dates, with a relative window ("the last 30 days") named as the dates it covered;
- the time zone, when it is not UTC;
- any cut-off ("top 5 by value", "first 500 rows", "at most 5000 points");
- each compute step (ratio, change, rolling window, running total, a summary over time) in words, with how empty
  days were treated;
- anything the answer left out, cut or estimated.

A measure someone proposed through the chat, and no one has approved yet, is named as one.

**The statement** is the one the source ran for this answer. It is never compiled again just to be shown.

- **SQL sources** show the compiled statement and the values bound to it.
- **Elasticsearch** shows the query request as JSON.
- **Superset** shows the SQL Superset compiled and ran. It is read from the `query` field of the chart-data
  answer, which Superset 5.0 and 6.1 both include. When that field is missing (a proxy that trims it, or an
  answer to a guest token), Lenspack asks once with `result_type: "query"`. That compiles the same SQL without
  running it. If that fails too, the request Lenspack sent is shown, labelled as such. When Superset answered
  from its cache, the line says when that data was read.

Steps after the SQL (an average per day, a change, a ratio) run in Lenspack on the numbers the source returned,
and the line says so. A question answered from several statements (a measure built from two tables, or a share
of the whole) shows each statement.

**The rows** are the ones behind the answer: what the caller was already allowed to see, nothing more.

**A saved answer** ([Saved answers](saved-answers.md)) shows the stored description, statement and rows, with "saved answer, data as of …".

**The dashboard filters** are the ones the viewer had picked on the board when they asked, named by the pack's
labels. Each says whether the answer used it: "applied" when every data call in the answer was filtered on that
field, otherwise "not applied to these numbers". That tells a viewer looking at one area's dashboard when the
answer is about everywhere. The serve UI sends the board's filters with each question. The Superset panel sends
them when the page that mounts it passes a `selections` function. Reading Superset's own filter bar is not wired
in yet.

**Checks on the reply** have a place on the same card. A check made in code, such as "every number in the reply
appears in a data call's result", reads the full results of the turn's calls, not the shortened card, and adds
its verdict to the card's `checks`.

## Who sees it

Only the person who asked sees it, under their own answer. It travels in their turn's stream as a
`data-answer-card` part, so it never goes to anyone else.

What the card shows is decided by the policy layer (`answerView` in `@lenspack/policy`), from the caller's
access and the deployment's switches. Each can only take things away:

- **A caller who is not shown compiled statements** (one with keys hidden from them) gets the words and the
  rows. They get no SQL, and no measure definitions, since a definition reads like the pack file.
- **A deployment with `explain.sql: false`** shows no SQL to anyone.
- **The panel** keeps each answer's explanation in the browser tab, beside the conversation, so it is there
  again after a reload. It is never sent back to the server.

## Where it is kept

The same record goes into the turn's `chat-turn` audit line, as `card`. The settings page's list of turns
names what each call asked. The record is bounded at about 32 KB:

- 10 data calls, with the rest counted;
- 20 rows per call;
- statements cut at 6,000 characters.

When a turn is still too large, it keeps fewer rows first, then shorter statements, then fewer calls. It never
cuts a row in half. Anything in a statement that looks like a credential, such as a URL's password or a
`password=` pair, is masked. Statements are compiled from the pack, so they should not hold one; the masking is
a second guard.

## The switches

| setting | where | effect |
|---|---|---|
| `explain` | the off switches (`features:`, `LENSPACK_FEATURES`, or the settings page) | Off: no explanation under answers, and none in the audit log. On by default. |
| `explain: false` | `lenspack.yaml` or `superset.yaml` | The same, from the config. |
| `explain: { sql: false }` | `lenspack.yaml` or `superset.yaml` | Keeps the words and the rows, and leaves out the SQL, for a deployment that does not want SQL shown. |

```yaml
explain:
  sql: false
```

The words are in English. The panel's own labels follow its language (English, French, Hindi or Portuguese).

## For developers

The card is built by `answerCard()` in `@lenspack/agent`, which knows nothing of HTTP or of any host. A host
makes one per turn and passes its `onData` to `boardTools`. When the turn ends, the host sends `record()` to the
person who asked and writes it to the audit log. The words come from `describeQuery()` in `@lenspack/engine`.
Each source reports the statement it ran through the `ran` option of `Connector.execute`, so nothing is
compiled twice.

---

**Next:** [Saved answers](saved-answers.md).

**Related:** [The compute step](compute.md) · [Privacy and data handling](../operating/privacy.md) ·
[Chat stream parts](../reference/stream-parts.md)
