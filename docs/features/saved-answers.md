# Saved answers

This page explains how saved answers work, what they save, when one is not used, and what the person asking sees.
It is for admins and anyone sizing a deployment. The idea, and the rule that keeps it safe, are in [Concepts: saved
answers](../concepts/saved-answers.md): a question answered well before is answered again by running the same
queries on today's data, without the model, and only for someone with the same access. A change to a board made
and accepted before is made again the same way. The model is kept for questions that are actually new.

## The tiers, cheapest first

Each question is tried against these in order. The first one that fits answers it. If none fits, the full assistant
answers, as it always did.

| tier | when it applies | what it does | model cost |
|---|---|---|---|
| **1. Exact replay** | The same question (ignoring case, punctuation, spacing and how numbers are written) was answered in the last few minutes on the same day | Sends the saved reply as it is. The data has not had time to change. | none |
| **2. Plan replay** | The same question, answered earlier | Runs the saved queries again on the current data. If every number in the saved reply can be traced to one place in the results, and the results still have the same rows in the same order, today's numbers are put into the reply in the same format. Otherwise one small model call rewrites the reply from the fresh results. | none, or one small call |
| **3. Slots** | The same question about another place, product or time ("in Portugal" instead of "in Spain", "last week" instead of "today") | Swaps the value into the saved queries, checks that the value exists in the data, and runs them. The reply is filled in as in tier 2. A different time period always goes to the small model, because the dates in the reply change. | none, or one small call |
| **4. Router** | A question in different words, or another language | One small model call sees the new question and the eight saved answers most like it, and says which one (if any) would answer it exactly as asked, and with which place or time. A match is run as in tier 3. "No match" goes to the full assistant. Only answers are offered: a saved change to a board is never made on the small model's say-so. | one small call |

**Suggested questions.** A pack can list example questions with the query someone checked for each (`examples:` in the
pack file); the chat offers them as suggestion chips. When one of those questions is asked and nothing is saved for it
yet, its checked query is run directly, under the asking person's access, and the small model says the result in one to
three sentences (with no model at hand, a plain line such as "orders today: 1,204." does). That answer is then kept like
any other, so the next ask is tier 1 or 2. An example written in several languages (in Superset, `question: { en: …,
fr: … }`) runs the same checked query whichever language's chip is clicked: the pack keeps the other languages as the
example's `wordings`.

The small model is the deployment's `router` role if one is set, otherwise a Haiku model if one is configured, otherwise
the main model. On Haiku 5.5 a router or rewrite call costs a few hundredths of a cent.

### What gets saved

Only answers that went well are saved:

- the turn finished without an error and was not refused, and at least one of its data queries worked. A turn that
  ran no query (a reply in the model's own words, an explanation, an "I can't") is not kept, nor is one whose queries
  were all refused or failed, so a refusal or an outage is never replayed;
- if the reviewer checked it, the reviewer accepted it (a turn whose finding was fixed or left the board as it was is
  not saved);
- the turn only read data (a turn that also changed the board is saved as an edit, below, not as an answer);
- the question stands on its own. A follow-up such as "and for last week?" or "show that as a line" depends on the turn
  before it, so it is neither served from nor kept.

When the reply cannot be rebuilt safely by swapping numbers, the reason is recorded (for example "the rows changed" or
"'17' is not a number in the results") and the small model writes it instead. A number the person typed ("the top 5") is
left as it is. A count written in words, a number written as "1.2k", or a number whose sign flipped always goes to the
small model, because the words around it might no longer be true.

## Dashboards settle

A change to a board that was made and accepted is kept too, keyed by the board's content before the change and the
request. If someone asks for the same change on a board in the same state (for example after undoing it, or on an
identical copy of the board), it is made again without the model, and the reviewer is not asked again. If the model is
asked afresh and makes exactly the same changes to the same board content as an accepted change, the reviewer is skipped
as well, because it has already accepted that exact change.

Lenspack also counts how often each board changes. A board with no change in the last week is shown as **settled** on
the admin page. A settled board is where saved answers pay off most.

From the questions people ask, Lenspack also suggests:

- **Suggestion chips.** The questions asked most often on a board (at least twice in 30 days, or pinned by an admin)
  become the chat's suggestion chips, ahead of the built-in examples. A person only sees questions asked by people with
  the same access as them. Clicking one is answered from the saved answer.
- **Chart candidates.** A question asked at least three times in two weeks that no chart on its board answers is listed
  for admins, with the query that answers it, as a candidate for a new chart. Putting it on the board means nobody needs
  to ask.

## When a saved answer is not used

A saved answer is used only for the same:

- **access scope.** The places, records and fields a person may see. See below.
- **edit rights.** Whether the person may change the board, and whether they are offered their own copy of it to
  change. The assistant is told differently in each case, so a reply given to someone who can edit (which may offer or
  describe a change) is never given to someone who can only read, nor the other way round.
- **pack and its definitions.** A change to the pack file (a measure, a dimension, a definition, a correctness filter)
  changes its fingerprint, and every answer saved under the old one stops being served.
- **the assistant's instructions.** When a release changes the instructions the assistant is given, old answers stop
  being served.
- **board filters.** An answer is saved per board, under that board's filters. Adding, changing or removing a filter
  starts afresh.
- **the viewer's filter selections.** What a person has picked in the dashboard's filters (the `selections` the chat
  panels send with each question, or `?f_<field>=` on the chat request) is part of the question: "how many today?" with
  one region picked is not the same question as with none.
- **language rules.** A reply in a chosen language is not served to someone who chose another.
- **board grant.** An answer made on a dashboard that the person may read only there (a Superset dashboard role) is
  never used on another dashboard, or for someone who reads that data another way.

A saved edit is also kept apart by **the tab the viewer had open**, on a dashboard with tabs: "add a chart here" puts
the chart on that tab. A saved answer is not: which tab is open does not change what a number is.

And it expires:

- **by age.** After `ttlHours` (one week by default), an entry is dropped. Pinned entries do not expire.
- **when the data may have changed.** A saved reply is sent as it is (tier 1) only within `freshMinutes` (10 by default)
  of when its numbers were read, and on the same day. After that the queries always run again (tier 2), so the numbers
  are never older than that window. We chose this over watching the data source for changes: Superset's "last changed"
  time tracks a dataset's definition, not its rows, and asking a source for its latest row costs about as much as
  running the queries.
- **on request.** "Ask fresh" (below), an admin evicting it, or an admin clearing them all.
- **at start, when it can no longer match.** A saved answer kept under an earlier pack (a changed `scope:` or excluded
  field included), earlier definitions, an earlier version of the assistant's instructions or its name, or other
  language rules is never served again, so it is dropped when the server starts, and is never refreshed. Answers with no
  query behind them, kept by earlier versions, go too.

The store holds at most `maxEntries` entries (500 by default). When it is full, the entry used longest ago goes first.
Pinned entries are kept. It is kept in `reuse.json` in the deployment's state directory and survives restarts. The file
holds people's questions, the replies and the rows that answered them (no user names), so only the server's own user can
read it (file mode 600, like the audit log; a file written by an earlier version is put right at start).

## Why we never cross access scopes

Two people can ask the same words and be entitled to different answers. Someone who may only see one country must never
be given a number counted over all of them, and must not even learn that someone else asked about a place they cannot
see. So every saved answer carries a fingerprint of the access it was made under: the tenant, the row filters, and the
fields and tables hidden from that person. An answer is only served to a request with the same fingerprint, and its
queries are run again under the asking person's own access, so the access checks still apply to every query. The
suggestion chips follow the same rule. Admins see every scope's questions on the admin page, because they can already
see every board.

## What the person asking sees

A reply from a saved answer looks like any other, with one line under it:

> Saved answer · numbers read at 09:41 · **Ask fresh**

- The time is when the numbers were read from the source. For tier 2 and later, that is now. It is not how recent the
  source's data is: a source loaded yesterday read at 09:41 says 09:41.
- Its tooltip says what ran: nothing at all (tier 1: the same answer as a few minutes ago), the queries again with no
  model, or the queries again with a small model that matched the question or worded the reply.
- For a change to the board, the line reads "Saved change, made as before".
- **Ask fresh** sends the same question to the full assistant, whatever is saved. Its answer replaces the saved one.
- The query steps still appear, with their results, so the person can see where the numbers came from.
- When the queries ran again (tier 2 and later), "How this was worked out" is shown as for any answer ([How this was
  worked out](explain.md)). A reply sent unchanged (tier 1) has none; "Ask fresh" gives one.
- The cost line shows what the reply actually cost: nothing for tiers 1 to 3 without a rewrite, a fraction of a cent
  otherwise.

This appears in both chat panels: the one inside Superset and the one in the board app, in light and dark themes.

Every turn served this way is written to the audit log as a `chat-turn` with `builder: "saved answer"` and `reuse: {
tier, entry, savedUsd, dataAsOf, how }`. Here `how` says whether the reply was swapped by template or rewritten, and
why. The reply's `data-reuse` part carries `model` when a small model was used, which the tooltip reads.

## The switches

- **The `cache` feature** (on by default) turns the whole thing on or off, like the other feature switches:
  `LENSPACK_FEATURES=-cache`, or on the admin settings page. On by default because nothing is served that was not
  checked first, every number is read again after a few minutes, and the person can always ask fresh. Off (or
  `enabled: false`), nothing else happens either: no answer is served or kept, no suggestion chip comes from a saved
  question (the pack's own examples still show), the admin page lists no entry, suggestion, chart candidate or settled
  board, board edits are not counted, and nothing is refreshed.
- **Switching off does not delete the file.** What was saved stays in `reuse.json` until it expires, so switching back on
  picks up where it was. To remove it, an admin uses **Clear saved answers** on the Cache tab (`POST
  <prefix>/cache/clear`), which works whether saved answers are on or off, empties the file at once and is written to the
  audit log. With saved answers off, the Cache tab shows how many are still kept and the button.
- **Settings** under `cache` in the admin settings (`PUT <prefix>/settings/cache`, or `cache:` in the deployment
  config):

| setting | default | |
|---|---|---|
| `enabled` | `true` | `false` keeps the store but serves, keeps, suggests and refreshes nothing from it |
| `ttlHours` | `168` | how long an entry lives, in hours (1 to 2,160, which is 90 days) |
| `router` | `"on"` | `"off"`: no small-model matching, so only exact and slotted questions are served (tiers 1 to 3) |
| `maxEntries` | `500` | how many entries are kept (10 to 20,000) |
| `freshMinutes` | `10` | how long a saved reply is sent unchanged before its queries are run again (0 to 1,440) |

A `null` in a `PUT` returns a setting to its default. An unknown setting is refused.

For `lenspack serve`, add `cache: true` (or `cache: { file: ./reuse.json, ttlHours: 72, … }`) to `lenspack.yaml`.
Without it, every question goes to the full assistant.

## Pre-warming: ready before the peak

Because the peaks come at known times, the most-asked answers can be made ready just before them. At each configured
time, Lenspack takes the most-asked saved answers (`topN`, 10 by default) on each board for each access scope, runs
their queries again on the current data, and rebuilds their replies, as the person they were made for, with that
person's access and nothing wider. The first people to arrive then get tier 1 answers, with numbers read minutes before.

- No full assistant turn runs. Most replies are rebuilt by swapping the numbers, with no model at all. A reply that
  needs rewriting costs one small model call; the refresh stops making those once it has spent `maxUsd` (5 cents by
  default), and such replies are rebuilt when they are next asked instead.
- A refresh also runs a few seconds after a data load, when the data pipeline says so (`POST
  <prefix>/cache/data-changed`; see [the HTTP API](../reference/http-api.md#saved-answers-and-the-queue)).
- Off by default: turn it on once you know when your peaks are.

Settings under `cache.prewarm`:

| setting | default | |
|---|---|---|
| `enabled` | `false` | run refreshes at the times below |
| `times` | `["06:30", "16:30"]` | local times, `HH:MM` |
| `timeZone` | the pack's time zone, else UTC | an IANA time zone such as `Europe/Lisbon` |
| `topN` | `10` | answers per board and access scope (1 to 100) |
| `maxUsd` | `0.05` | what one refresh may spend on rewrites, in US dollars (0 to 100) |

A refresh that was due while the server was down runs if the server is back within 30 minutes of the time.

## What it saves: an estimate

A made-up but realistic week: one deployment, **8,000 questions a day** (56,000 a week) about **50 distinct things**. We
assume:

- 15% of questions are follow-ups or new, and go to the full assistant;
- each of the 50 questions is first asked under 6 different combinations of board, access and language, and each of
  those first asks goes to the full assistant once a week (the entries expire after a week);
- of the rest, half are asked in the same words (tiers 1 and 2), 15% about another place or time (tier 3), and 35% in
  other words (tier 4). The router finds a match for 80% of those;
- one in five replays cannot be swapped by template and needs a rewrite (30% of tier 3, for time periods). A rewrite
  costs about $0.0005 and a router call about $0.0002 on Haiku 5.5.

| main model | cost of a full turn | a week without saved answers | a week with them | saved |
|---|---|---|---|---|
| Haiku 5.5 | about $0.003 | $168 | $45 | about 73% |
| Sonnet 5.5 | about $0.03 | $1,680 | $369 | about 78% |

About 12,000 of the 56,000 questions still go to the full assistant. The small-model calls for the rest cost about $9 a
week. The answers also come back faster: a replay takes as long as the queries, with no model time at all.

The real number for a deployment is on the admin page. Each turn served from a saved answer is credited with the running
average cost of a full turn on that model, minus what the replay spent.

## How it is built

The matching, the replays, the refreshes and the queue know nothing about HTTP or about the host they run in. They are
in `@lenspack/agent` (`reuseLayer` and `localTurnGate`), so the same logic can serve any host, and the planned shared
turn can call it directly. A host gives them a turn (who asks what, on which board, with which access), a small model to
call, and a store, and turns what comes back into its own reply stream. The Lenspack server's side is a few lines in its
chat route.

State sits behind two small interfaces, so that two copies of a deployment can share it later:

- **`AnswerStore`**: saved answers, board edit counts and totals. Today `fileAnswerStore` keeps them in `reuse.json`. A
  database-backed store implements the same calls (`get`, `put`, `delete`, `entries` and a few counters), so every copy
  sees every saved answer.
- **`TurnGate`**: the queue and the one-change-at-a-time rule per board. Today `localTurnGate` keeps them in the
  server's memory, which is right for one copy. With several copies behind a load balancer, each copy limits only its
  own turns, and two changes to the same board on two copies are not held one after the other; a shared gate (for
  example on database row locks or a small queue service) implements the same `acquire`, `settings` and `stats` calls to
  fix that.

Who may see and change the admin pages is decided by one function in `@lenspack/policy` (`mayAdminister`), like the
other access decisions.


## Routes

Admins read and manage saved answers through the admin panel's Cache tab, or directly through the routes listed
in [HTTP API: saved answers and the queue](../reference/http-api.md#saved-answers-and-the-queue).

---

**Next:** [Busy hours](busy-hours.md).

**Related:** [Concepts: saved answers](../concepts/saved-answers.md) · [Costs](../operating/costs.md) ·
[The admin panel](admin-panel.md)
