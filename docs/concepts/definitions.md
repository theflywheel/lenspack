# Definitions and open questions

Some questions have two sane readings, and the pack does not say which one this deployment means. This page
explains definitions, which settle such readings, and open questions, which collect the ones still unsettled. It is
for admins and pack authors.

## The problem

Someone asks "how many orders this month?". The assistant reads "this month" as the last 30 days; the person meant
the calendar month. Someone asks about "sales" and the pack has two measures that could be meant. Neither reading
is a bug. Only someone who runs the deployment can say which is right.

## Definitions

A **definition** is something an admin adds on top of the pack, without editing the pack file or restarting
anything. There are four kinds:

- **an instruction**: a line the assistant follows ("Weeks start on Monday");
- **a hint** on a measure or dimension ("Before refunds");
- **synonyms** for a key ("market" and "region" mean country);
- **a reading for a kind of question**: "when someone asks about sales this month, use the calendar month to date".

Definitions are a document of their own, one per pack, versioned like a board. Each change keeps who made it, when
and why, and any change can be undone. They are added to the pack on every turn, so a change applies to the next
question. They never change the pack file itself.

## Open questions

An **open question** is a kind of question with two or more readings and no sane default. Each entry keeps the
question in general words, its readings (each with the query that computes it), the questions people actually
asked, how often, and whether it is open, answered or dismissed.

They come from the assistant during a chat, the reviewer, the daily review, or an admin by hand. When an admin
answers one, the chosen reading becomes a definition, and the assistant stops asking.

## How they meet in the chat

When a question can be read two ways that give different numbers, the assistant either asks (the readings appear
as buttons) or answers with the most likely reading and says which one it used. Either way the question is logged
for an admin. It never asks when the pack's rules or a definition already settle it.

---

**Next:** [Saved answers](saved-answers.md).

**Related:** [Open questions and definitions](../features/open-questions.md) · [The admin
panel](../features/admin-panel.md)
