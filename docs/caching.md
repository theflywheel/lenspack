# Saved answers: using the model less

People who use a dashboard do not come up with new questions every day. A team asks the same few dozen things ("how many households were reached today?", "which ward is behind?") again and again, in slightly different words, about different places and days. And once a dashboard has been shaped over a few rounds of changes, it settles: nobody keeps moving the charts around.

Lenspack takes advantage of both. When a question has been answered well before, it answers it again by running the same queries on the current data, without asking the model to work everything out again. When a change to a board has been made and accepted before, it makes the same change again. The model is kept for questions that are actually new.

This page explains how that works, what it costs, when a saved answer is not used, and what the person asking sees.

## The idea in one paragraph

A full turn with the assistant reads the pack's catalogue, plans which queries to run, runs them, and writes a reply. Most of the cost is the planning and the writing. The result of the planning (which tools were called, with which arguments) is small and can be kept. So Lenspack keeps a **plan** for each question it answered well, together with the reply and the numbers the reply was written from. The next time the same question comes in, it runs the plan again on today's data and puts today's numbers into the saved reply. The numbers are always read fresh. Only the work of deciding what to read is reused.

## The tiers, cheapest first

Each question is tried against these in order. The first one that fits answers it. If none fits, the full assistant answers, as it always did.

| tier | when it applies | what it does | model cost |
|---|---|---|---|
| **1. Exact replay** | The same question (ignoring case, punctuation, spacing and how numbers are written) was answered in the last few minutes on the same day | Sends the saved reply as it is. The data has not had time to change. | none |
| **2. Plan replay** | The same question, answered earlier | Runs the saved queries again on the current data. If every number in the saved reply can be traced to one place in the results, and the results still have the same rows in the same order, today's numbers are put into the reply in the same format. Otherwise one small model call rewrites the reply from the fresh results. | none, or one small call |
| **3. Slots** | The same question about another place, facility or time ("in Ward 7" instead of "in Ward 12", "last week" instead of "today") | Swaps the value into the saved queries, checks that the value exists in the data, and runs them. The reply is filled in as in tier 2. A different time period always goes to the small model, because the dates in the reply change. | none, or one small call |
| **4. Router** | A question in different words, or another language | One small model call sees the new question and the eight saved questions most like it, and says which one (if any) would answer it exactly as asked, and with which place or time. A match is run as in tier 3. "No match" goes to the full assistant. | one small call |

**Suggested questions.** A pack can list example questions with the query someone checked for each (`examples:` in the pack file); the chat offers them as suggestion chips. When one of those questions is asked and nothing is saved for it yet, its checked query is run directly, under the asking person's access, and the small model says the result in one to three sentences (with no model at hand, a plain line such as "households reached: 1,204." does). That answer is then kept like any other, so the next ask is tier 1 or 2. Before, clicking a chip ran the full assistant even though the right query was already known.

The small model is the deployment's `router` role if one is set, otherwise a Haiku model if one is configured, otherwise the main model. On Haiku 5.5 a router or rewrite call costs a few hundredths of a cent.

### What gets saved

Only answers that went well are saved:

- the turn finished without an error and was not refused, and at least one of its data queries worked (a turn whose queries were all refused or failed is not kept, so a refusal or an outage is never replayed);
- if the reviewer checked it, the reviewer accepted it (a turn whose finding was fixed or left the board as it was is not saved);
- the turn only read data (a turn that also changed the board is saved as an edit, below, not as an answer);
- the question stands on its own. A follow-up such as "and for last week?" or "show that as a line" depends on the turn before it, so it is neither served from nor kept.

When the reply cannot be rebuilt safely by swapping numbers, the reason is recorded (for example "the rows changed" or "'17' is not a number in the results") and the small model writes it instead. A number the person typed ("the top 5") is left as it is. A count written in words, a number written as "1.2k", or a number whose sign flipped always goes to the small model, because the words around it might no longer be true.

## Dashboards settle

A change to a board that was made and accepted is kept too, keyed by the board's content before the change and the request. If someone asks for the same change on a board in the same state (for example after undoing it, or on an identical copy of the board), it is made again without the model, and the reviewer is not asked again. If the model is asked afresh and makes exactly the same changes to the same board content as an accepted change, the reviewer is skipped as well, because it has already accepted that exact change.

Lenspack also counts how often each board changes. A board with no change in the last week is shown as **settled** on the admin page. A settled board is where saved answers pay off most.

From the questions people ask, Lenspack also suggests:

- **Suggestion chips.** The questions asked most often on a board (at least twice in 30 days, or pinned by an admin) become the chat's suggestion chips, ahead of the built-in examples. A person only sees questions asked by people with the same access as them. Clicking one is answered from the saved answer.
- **Chart candidates.** A question asked at least three times in two weeks that no chart on its board answers is listed for admins, with the query that answers it, as a candidate for a new chart. Putting it on the board means nobody needs to ask.

## When a saved answer is not used

A saved answer is used only for the same:

- **access scope.** The places, records and fields a person may see. See below.
- **pack and its definitions.** A change to the pack file (a measure, a dimension, a definition, a correctness filter) changes its fingerprint, and every answer saved under the old one stops being served.
- **assistant version.** When the assistant's instructions change (`PROMPT_VERSION`), old answers stop being served.
- **board filters.** An answer is saved per board, under that board's filters. Adding, changing or removing a filter starts afresh.
- **the viewer's filter selections.** What a person has picked in the dashboard's filters (the `selections` the chat panels send with each question, or `?f_<field>=` on the chat request) is part of the question: "how many today?" with one province picked is not the same question as with none.
- **language rules.** A reply in a chosen language is not served to someone who chose another.

A saved edit is also kept apart by **the tab the viewer had open**, on a dashboard with tabs: "add a chart here" puts the chart on that tab. A saved answer is not: which tab is open doesn't change what a number is.

And it expires:

- **by age.** After `ttlHours` (one week by default), an entry is dropped. Pinned entries do not expire.
- **when the data may have changed.** A saved reply is sent as it is (tier 1) only within `freshMinutes` (10 by default) of when its numbers were read, and on the same day. After that the queries always run again (tier 2), so the numbers are never older than that window. We chose this over watching the data source for changes: Superset's "last changed" time tracks a dataset's definition, not its rows, and asking a source for its latest row costs about as much as running the queries.
- **on request.** "Ask fresh" (below), or an admin evicting it.

The store holds at most `maxEntries` entries (500 by default). When it is full, the entry used longest ago goes first. Pinned entries are kept. It is kept in `reuse.json` in the deployment's state directory and survives restarts.

## Why we never cross access scopes

Two people can ask the same words and be entitled to different answers. Someone who may only see one province must never be given a number counted over all of them, and must not even learn that someone else asked about a place they cannot see. So every saved answer carries a fingerprint of the access it was made under: the tenant, the row filters, and the fields and tables hidden from that person. An answer is only served to a request with the same fingerprint, and its queries are run again under the asking person's own access, so the access checks still apply to every query. The suggestion chips follow the same rule. Admins see every scope's questions on the admin page, because they can already see every board.

## What the person asking sees

A reply from a saved answer looks like any other, with one line under it:

> Saved answer, data as of 09:41 · **Ask fresh**

- The time is when the numbers were read. For tier 2 and later, that is now.
- For a change to the board, the line reads "Saved change, made as before".
- **Ask fresh** sends the same question to the full assistant, whatever is saved. Its answer replaces the saved one.
- The query steps still appear, with their results, so the person can see where the numbers came from.
- When the queries ran again (tier 2 and later), "How this was worked out" is shown as for any answer ([explain.md](explain.md)). A reply sent unchanged (tier 1) has none; "Ask fresh" gives one.
- The cost line shows what the reply actually cost: nothing for tiers 1 to 3 without a rewrite, a fraction of a cent otherwise.

This appears in both chat panels: the one inside Superset and the one in the board app, in light and dark themes.

Every turn served this way is written to the audit log as a `chat-turn` with `builder: "saved answer"` and `reuse: { tier, entry, savedUsd, dataAsOf, how }`. Here `how` says whether the reply was swapped by template or rewritten, and why.

## The switches

- **The `cache` feature** (on by default) turns the whole thing on or off, like the other feature switches: `LENSPACK_FEATURES=-cache`, or on the admin settings page. On by default because nothing is served that was not checked first, every number is read again after a few minutes, and the person can always ask fresh.
- **Settings** under `cache` in the admin settings (`PUT <prefix>/settings/cache`, or `cache:` in the deployment config):

| setting | default | |
|---|---|---|
| `enabled` | `true` | `false` keeps the store but serves nothing from it |
| `ttlHours` | `168` | how long an entry lives, in hours (1 to 2,160, which is 90 days) |
| `router` | `"on"` | `"off"`: no small-model matching, so only exact and slotted questions are served (tiers 1 to 3) |
| `maxEntries` | `500` | how many entries are kept (10 to 20,000) |
| `freshMinutes` | `10` | how long a saved reply is sent unchanged before its queries are run again (0 to 1,440) |

A `null` in a `PUT` returns a setting to its default. An unknown setting is refused.

For `lenspack serve`, add `cache: true` (or `cache: { file: ./reuse.json, ttlHours: 72, … }`) to `lenspack.yaml`. Without it, every question goes to the full assistant.

## Busy hours: the queue

Use of a dashboard is concentrated. Most people open it at the start of the day and before a review meeting, so most questions arrive in two or three short peaks, and they are mostly the same questions. That makes peaks both predictable and repetitive, and Lenspack uses both facts: saved answers take the repetitive part, and the rest waits its turn instead of failing.

- **At most `maxConcurrent` model turns run at once** (8 by default). The others wait in line, oldest first. A turn answered from a saved answer never waits: it uses no model.
- **The person waiting is told so.** The chat shows "Busy, about 12 s (number 3 in line)" and updates it as the line moves.
- **When the line is full** (`maxWaiting`, 50 by default), or a turn has waited `maxWaitSeconds` (60 by default), the reply is a short "Lenspack is too busy right now. Try again in a minute", with a Try again button and the board's suggestion chips beside it. Those chips are usually saved answers, so they still answer at once.
- **A rate limit is not a failure.** When the model provider turns a call away because of its rate limit (HTTP 429) or because it is overloaded (529), the call is tried again after about 1, 2, 4 seconds and so on (up to 15 seconds each, with a random part so that many waiting turns do not all retry at the same moment, and longer if the provider asks for longer). It only fails once the turn's wait limit would be passed.
- **Two changes to the same dashboard do not run at once.** If a second request to change a board arrives while another change to it is still being made, it waits for the first to finish ("waiting for another edit on this dashboard"), then starts from the board as the first left it. Questions, and changes to other boards, do not wait for it. A request counts as a change when it starts with a word such as "add", "remove", "move" or "change" (in English, French, Portuguese and Hindi). A question mistaken for a change only waits a little longer; a change mistaken for a question still works, as it always did.
- How long each turn waited is recorded as `queueMs` in its `chat-turn` audit record.

Settings under `queue` (`PUT <prefix>/settings/queue`, or `queue:` in the deployment config):

| setting | default | |
|---|---|---|
| `maxConcurrent` | `8` | model turns at once (1 to 200) |
| `maxWaiting` | `50` | turns that may wait (0 to 2,000) |
| `maxWaitSeconds` | `60` | how long a turn may wait, and how long a rate-limited call keeps retrying (1 to 600) |

## Pre-warming: ready before the peak

Because the peaks come at known times, the most-asked answers can be made ready just before them. At each configured time, Lenspack takes the most-asked saved answers (`topN`, 10 by default) on each board for each access scope, runs their queries again on the current data, and rebuilds their replies, as the person they were made for, with that person's access and nothing wider. The first people to arrive then get tier 1 answers, with numbers read minutes before.

- No full assistant turn runs. Most replies are rebuilt by swapping the numbers, with no model at all. A reply that needs rewriting costs one small model call; the refresh stops making those once it has spent `maxUsd` (5 cents by default), and such replies are rebuilt when they are next asked instead.
- A refresh also runs a few seconds after a data load, when the data pipeline says so (`POST <prefix>/cache/data-changed`, below).
- Off by default: turn it on once you know when your peaks are.

Settings under `cache.prewarm`:

| setting | default | |
|---|---|---|
| `enabled` | `false` | run refreshes at the times below |
| `times` | `["06:30", "16:30"]` | local times, `HH:MM` |
| `timeZone` | the pack's time zone, else UTC | an IANA time zone such as `Africa/Lagos` |
| `topN` | `10` | answers per board and access scope (1 to 100) |
| `maxUsd` | `0.05` | what one refresh may spend on rewrites, in US dollars (0 to 100) |

A refresh that was due while the server was down runs if the server is back within 30 minutes of the time.

## How it is built

The matching, the replays, the refreshes and the queue know nothing about HTTP or about the host they run in. They are in `@lenspack/agent` (`reuseLayer` and `localTurnGate`), so the same logic can serve any host, and the coming shared turn code can call it directly. A host gives them a turn (who asks what, on which board, with which access), a small model to call, and a store, and turns what comes back into its own reply stream. The Lenspack server's side is a few lines in its chat route.

State sits behind two small interfaces, so that two copies of a deployment can share it later:

- **`AnswerStore`**: saved answers, board edit counts and totals. Today `fileAnswerStore` keeps them in `reuse.json`. A database-backed store implements the same calls (`get`, `put`, `delete`, `entries` and a few counters), so every copy sees every saved answer.
- **`TurnGate`**: the queue and the one-change-at-a-time rule per board. Today `localTurnGate` keeps them in the server's memory, which is right for one copy. With several copies behind a load balancer, each copy limits only its own turns, and two changes to the same board on two copies are not held one after the other; a shared gate (for example on database row locks or a small queue service) implements the same `acquire`, `settings` and `stats` calls to fix that.

Who may see and change the admin pages is decided by one function in `@lenspack/policy` (`mayAdminister`), like the other access decisions.

## Prompt caching

Separate from saved answers, the Anthropic adapter marks the parts of every call that do not change (the tools, the pack's catalogue and rules) for Anthropic's prompt cache. These are now kept for **one hour** instead of five minutes, so a question that comes in 20 minutes after the last one still reads them from the cache at a tenth of the input price. Writing to the one-hour cache costs twice the input price (five-minute writes cost 1.25 times), so it pays for itself after about two reads. The part that grows during one turn (the conversation inside a tool loop) keeps the five-minute cache, since nothing reads it after the turn. `cacheTtl: "5m"` in the provider's `anthropic` settings goes back to five minutes everywhere. Metering charges one-hour and five-minute cache writes each at their own price, from the breakdown Anthropic reports. See [llm.md](llm.md#anthropic).

## What it saves: an estimate

A made-up but realistic week: one deployment, **8,000 questions a day** (56,000 a week) about **50 distinct things**. We assume:

- 15% of questions are follow-ups or new, and go to the full assistant;
- each of the 50 questions is first asked under 6 different combinations of board, access and language, and each of those first asks goes to the full assistant once a week (the entries expire after a week);
- of the rest, half are asked in the same words (tiers 1 and 2), 15% about another place or time (tier 3), and 35% in other words (tier 4). The router finds a match for 80% of those;
- one in five replays cannot be swapped by template and needs a rewrite (30% of tier 3, for time periods). A rewrite costs about $0.0005 and a router call about $0.0002 on Haiku 5.5.

| main model | cost of a full turn | a week without saved answers | a week with them | saved |
|---|---|---|---|---|
| Haiku 5.5 | about $0.003 | $168 | $45 | about 73% |
| Sonnet 5.5 | about $0.03 | $1,680 | $369 | about 78% |

About 12,000 of the 56,000 questions still go to the full assistant. The small-model calls for the rest cost about $9 a week. The answers also come back faster: a replay takes as long as the queries, with no model time at all.

The real number for a deployment is on the admin page. Each turn served from a saved answer is credited with the running average cost of a full turn on that model, minus what the replay spent.

## The admin API

For admins only, under the host's admin prefix (`/_superset` inside Superset). A person who is not an admin gets `403`, and the attempt is written to the audit log.

`GET <prefix>/cache`: totals since the store was started, the queue right now, the last refresh, and every entry.

```jsonc
{
  "stats": { "since": "2026-11-26T08:00:00.000Z", "turns": 120, "hits": { "t1": 40, "t2": 31, "t3": 9, "t4": 12 }, "misses": 28, "savedUsd": 1.92 },
  "queue": { "running": 3, "waiting": 0, "editsWaiting": 0, "turnSeconds": 11.5 },  // turnSeconds: recent average model turn
  "prewarm": { "at": "2026-11-26T06:30:04.000Z", "reason": "schedule", "pack": null, "entries": 24, "refreshed": 21, "rewritten": 2, "skipped": 1, "failed": 0, "spentUsd": 0.0011, "modelCalls": 2 },  // or null
  "entries": [
    {
      "id": "k3j9x2", "board": "overview", "question": "How many households were reached today?",
      "variants": ["households reached today?"],      // other wordings served from it
      "kind": "answer",                                // or "edit"
      "hits": 14, "lastHit": "2026-11-26T09:41:00.000Z", "createdAt": "2026-11-25T07:02:00.000Z",
      "pinned": false, "tierCounts": { "t1": 6, "t2": 5, "t3": 0, "t4": 3 }, "dataAsOf": "2026-11-26T09:41:00.000Z",
      "lang": "en", "asks7d": 15                        // extra: the question's language, and asks in the last 7 days
    }
  ]
}
```

`POST <prefix>/cache/<id>/pin`, `/unpin`, `/evict`: answers `{ "ok": true, "id": "<id>", "action": "pin" }`, or `404` for an unknown id. Each is written to the audit log. A pinned entry does not expire and is never pushed out when the store is full.

`GET <prefix>/cache/suggestions?board=<id>`: the most-asked questions on a board, across every scope: `{ "board": "<id>", "suggestions": ["…"] }`. Optional `lang` and `limit` (8 by default).

`GET <prefix>/cache/chart-candidates`: questions asked often that no chart on their board answers: `{ "candidates": [{ "id", "board", "question", "variants", "asks", "lastHit", "query": { "kind": "value", "measure": "…" } }] }`, most asked first. Optional `minAsks` (3) and `days` (14).

`GET <prefix>/cache/boards` (an addition): how often each board changed, for settled boards: `{ "boards": [{ "board", "edits7d", "edits30d", "edits90d", "lastEdit", "settled" }] }`.

`POST <prefix>/cache/prewarm`: refreshes now, and answers when done: `{ "ok": true, "run": { …as "prewarm" above } }` (`run` is `null` when saved answers are off).

`POST <prefix>/cache/data-changed`, with an optional body `{ "pack": "<name>" }`: for a data pipeline to call after a load. Answers `202 { "ok": true, "scheduled": true }` at once; the refresh runs a few seconds later, and several calls close together make one refresh.

For everyone who may open a board, the board API also answers `GET /api/<pack>/<board>/suggestions?lang=` with `{ "suggestions": ["…"] }`: the most-asked questions on that board by people with the same access. The chat panels use it for their chips.

The settings are read and changed with the other admin settings: `GET <prefix>/settings` includes `cache` (with `prewarm`) and `queue`; `PUT <prefix>/settings/cache` and `PUT <prefix>/settings/queue` take any of the settings above (`prewarm` as a partial object).

The chat stream carries two extra kinds of part: `data-reuse` (the saved-answer line) and `data-queue` (`{ "state": "waiting", "reason": "busy" | "edit", "position", "etaSeconds" }` while waiting, not kept in the message; `{ "state": "full", "why": "full" | "timeout", "retryAfterSeconds" }` when turned away, followed by the same message as text so any client can show it).
