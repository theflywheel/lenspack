# The life of a turn

This page follows one chat message from the moment it reaches the server to the last line of the reply, and says
where each step lives in the code today and where it is planned to move. It is for developers.

## The steps

```
POST /api/<pack>/<board>/chat
  1  who is asking           host identity → decide() → ctx (scope, hidden keys), rights
  2  nothing to answer from? a person who may read no data is told so; no model is called
  3  budget                  over today's cap → 429, before any model call
  4  saved answer?           exact, re-run, swapped value, or a small-model match → reply, no full turn
  5  wait for a place        the queue; a second edit to the same board waits for the first
  6  prompt                  pack + admin definitions + board + rules + language + access note
  7  round 1                 the builder model calls tools; edits go to a staged copy of the board
  8  review                  if the turn tried an edit: the reviewer checks it
  9  fix round               a material finding → the escalation model fixes, the reviewer checks again
 10  save or discard         staged edits saved as versions, or dropped if still wrong
 11  close                   answer card, cost line, audit line, usage ledger, saved-answer store
```

1. **Who is asking.** The host's sign-in gives an identity. `decide()` in the policy package turns it into the
   context every query carries and the rights for this board. See [Policy](../concepts/policy.md).
2. **Nothing to answer from.** If the host keeps every measure from the person, they are told before anything
   else runs, and no model is asked.
3. **Budget.** If today's metered spend has reached the server's or the person's cap, the chat answers 429 and
   says when the budget resets. See [Costs](../operating/costs.md#a-budget).
4. **Saved answer.** The reuse layer tries the cheapest way to answer first: the same reply sent again within a few
   minutes, the saved queries run again on fresh data, a place or a time swapped into them, or a small-model match
   to a saved question in other words. A match ends the turn here. See [Saved answers](../features/saved-answers.md).
5. **The queue.** At most a set number of model turns run at once; the rest wait their turn and are told their
   place. A change to a board waits for any change already running on it. See [Busy hours](../features/busy-hours.md).
6. **The prompt.** The system prompt is built in parts, the stable part first (the pack's catalogue, examples and
   rules, the admins' definitions) and the part that changes most last (the current board, what the person changed
   by hand since the last turn). A model provider that caches prompts reads the stable part from its cache.
7. **Round 1.** The builder model calls tools, up to a step limit, and stops early after repeated refusals. With a
   reviewer on, every edit goes to a **staged** copy of the board: nothing is saved yet.
8. **Review.** A turn is reviewed when the board gained a version, or when the reply may say it did (an edit was
   tried and refused, or the reply says it added, removed, renamed or moved something). The reviewer sees the
   request, the board before and after, and the refusals, and marks each finding **material** (the board would
   mislead whoever reads it) or **minor**.
9. **Fix round.** A material finding gets one fix round on the escalation model and a second check.
10. **Save or discard.** If the change is still wrong, nothing from the turn is saved and the reply says the board
    was left as it was. Otherwise the staged edits become versions. Minor findings are saved and mentioned in one
    sentence.
11. **Close.** The answer card goes to the person who asked; the turn's cost is sent as a line under the reply; one
    `chat-turn` audit line records the instruction, the answer, the tool calls, the outcome and the cost; the
    saved-answer store keeps the plan if the turn went well.

Throughout, the reply streams as it is written. Words after an edit wait for the reviewer, so a reply never says "I
added the chart" and then "I removed the chart I added". The stream's extra parts are listed in
[Chat stream parts](../reference/stream-parts.md).

## Where it lives today

The turn (steps 3 and 5 to 11) is a function inside the standalone server's package (`packages/hosts/serve`),
written against its HTTP response. The Superset host runs the same server runtime, so both hosts share it. The
evals host the real server over a loopback port so they test the production turn. The pieces that are already
host-neutral live in the kernel: the tools, saved answers, the queue, the answer card and clarify.

## Planned: one turn in the kernel

The turn moves into the agent package as one function, `runTurn()`, that takes a turn's inputs and yields events
(text, tool calls, the answer card, review, usage). Every host turns those events into its own stream, and the
evals call it directly. It will have two modes:

- **Ask**, for questions and for anyone who may only view: read-only tools, a cheap default model, a check in code
  that every number in the reply appears in a tool result, and the answer card.
- **Edit**, for changes: the staging, reviewer and fix round above, with review started by an attempted edit rather
  than by the reply's words.

Models, metering, budget, audit, settings and speech move with it into a shared runtime package, so the Superset
host no longer imports the standalone server.

---

**Next:** [Stores, and running several copies](stores.md).

**Related:** [Turns](../concepts/turns.md) · [Dashboard edits](../features/dashboard-edits.md) · [Chat models](../operating/models.md)
