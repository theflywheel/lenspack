# Answering questions

This page describes what happens when someone asks a question in the chat, what the reply contains and where its
numbers come from. It is for anyone who will use the chat or support people who do.

## Ask in words

Open the chat on a board and ask: "revenue by country last month", "how many orders today compared with
yesterday?", "which channel grew fastest this quarter?". The assistant reads the board you are on, the filters you
have picked, and the pack's catalogue, and answers with numbers it read through the pack's measures.

- **Numbers only from the pack.** Every figure in a reply came from a query the engine ran. The assistant does not
  write SQL and does not do arithmetic in its head: rates and changes come from the
  [compute step](compute.md).
- **The board's filters apply.** "How many today?" with one country picked is answered for that country. "How this
  was worked out" says whether each pick was applied.
- **Your access applies.** A person who may see one country is answered for that country. A question about data
  their access keeps from them is answered with "not available to you", not with a guess.
- **Refusals are explained.** A question the pack cannot answer gets the reason and what it can answer instead.

## What a reply looks like

- The answer, in the language you asked in, formatted with bold, lists and tables (the `markdown` switch turns
  formatting off).
- **[How this was worked out](explain.md)**: each data call in plain words, with its SQL and its rows.
- A line with what the turn cost, an estimate from list prices, and a running total in the chat menu (the
  `turnCost` switch hides both; the audit log still records each turn's cost).
- When the reply came from a [saved answer](saved-answers.md), a line saying so, with **Ask fresh**.
- When the question could be read two ways, the readings as buttons, or a sentence saying which one was used. See
  [Clarify](open-questions.md#clarify).
- Suggested questions under an empty chat: the pack's examples, then the board's most-asked questions.

## Follow-ups and new chats

The assistant keeps the conversation's recent turns (8 by default, `historyTurns`), so "and last year?" works.
Edits made by hand between turns are summarised for it, so it knows the board changed. **New chat** clears the
conversation for this board without touching the board; an Undo note brings it back for a few seconds.

## Picking a model

Where the deployment offers more than one, the chat's menu picks the model for your turns. The admin sets which are
offered and which is the default. See [Chat models](../operating/models.md).

## When the assistant cannot answer

| you see | why | what to do |
|---|---|---|
| "not available to you: your Superset access doesn't include it" | your host access keeps that data from you | ask an admin for access |
| "Lenspack is too busy right now" | the queue is full | try again; suggested questions are often saved answers and answer at once. See [Busy hours](busy-hours.md) |
| "today's budget is used up" | the deployment's daily spend cap is reached | wait for the reset, or ask an admin. See [Costs](../operating/costs.md) |
| a refusal naming a measure that exists | the pack has nothing for what you asked | ask with that measure, or ask an admin to add one |

---

**Next:** [The compute step](compute.md).

**Related:** [Turns](../concepts/turns.md) · [The life of a turn](../architecture/life-of-a-turn.md)
