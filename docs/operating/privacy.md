# Privacy and data handling

This page says what Lenspack sends to model providers, what it stores about the people who use it, who can read it,
and how long it is kept. It is for whoever answers privacy questions about a deployment.

## What goes to the model provider

On each chat turn, the provider receives:

- the pack's catalogue as the person may see it (keys, labels, hints, synonyms), its instructions and examples, and
  the admins' definitions;
- the current board (widget titles, queries, filters);
- the conversation (the recent turns, 8 by default);
- **the rows the assistant's tools read**, so it can write its reply. These are aggregates (counts, sums, groups) or,
  for a rows query, the records asked for, never more than the query's limit.

A key hidden from a person is left out of all of this. The provider never receives table names it could misuse, SQL
fragments, database addresses or credentials. Errors are passed on with URLs, hosts, ports and IP addresses taken
out. The daily review sends the period's turns with users named u1, u2 and so on.

**Voice:** the audio clip goes to the transcription provider and is not kept by Lenspack.

Choose a provider whose terms suit your data, and keep pack instructions, hints and examples free of real values:
everyone who may open the pack sees them, and the model receives them on every turn.

## What Lenspack stores

| record | holds | who can read it | kept |
|---|---|---|---|
| audit log | each change, refusal, denied request and chat turn, with the user, the question, the answer, the tool calls, "How this was worked out" (bounded to about 32 KB a turn, credentials masked) and the cost | admins | 90 days by month (`audit.retentionDays`); `audit: false` turns it off |
| usage file (`usage:`) | one line per model call: user, pack, board, role, tokens, cost | whoever has the usage right | until you delete it |
| saved answers | the question, its plan, the reply and the rows it was written from, tied to an access fingerprint | admins (Cache tab) | `ttlHours` (one week by default), unless pinned |
| open questions and review runs | questions people asked, with readings; the daily review's report | admins | review runs: the last 90 |
| boards and versions | who changed what, when | per board rights | as long as the board |

Names on the usage board and in review reports are shown only to admins who also hold the usage right; others see the
same figures with the user, question text and session hidden. The browser keeps each answer's "How this was worked
out" beside the conversation in the tab; it is never sent back to the server.

**Telemetry** keeps one record per turn, per transcription and per client event, each item switched on its own.
Question text, transcript text, kept recordings and device detail start off and ask an admin to confirm. Records are
kept 90 days. See [Telemetry](../features/telemetry.md#privacy-notes).

## What is never stored

Passwords (only a scrypt hash of the built-in admin's), model keys, database credentials, and the browser's user agent.

## The data itself

Lenspack never copies your data into its own store. It reads it through the source, read-only, for each query. Saved
answers keep the rows a reply was written from, under the access they were read with, and run the queries again for
fresh numbers. The usage board reads only Lenspack's own records, copied into a separate in-process database; it
cannot reach the deployment's data.

---

**Next:** [Upgrading](upgrading.md).

**Related:** [How this was worked out](../features/explain.md) · [What Lenspack keeps on disk](state.md) ·
[Why the model cannot break things](../architecture/safety.md)
