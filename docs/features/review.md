# Daily review, open questions and definitions

This page covers the tools that find questions the assistant may have read wrongly and settle them: definitions,
open questions, clarify, the daily review and compare readings. It is for admins who keep a deployment's answers
right after launch. The ideas are introduced in [Definitions and open questions](../concepts/definitions.md).

A data assistant gets most of its answers wrong in the same few ways. Someone asks "how many visits this month?" and the assistant reads "this month" as the last 30 days, while the person meant the calendar month. Someone asks about "stock" and the pack has two measures that could be meant. Neither reading is a bug. The pack does not say which one this deployment means, so the assistant guesses.

## Why

The pack file is written once, by someone who knows the data. People then ask questions it never thought of. Two things follow:

- **Some questions have no sane default.** "Counting this way gives 4,100; counting that way gives 3,600. Which is right?" Only someone who runs the deployment can answer. The assistant should say it is unsure, not hide the guess.
- **Fixing a definition should not need a release.** A deployment's pack often sits in a read-only mounted file (a Kubernetes ConfigMap, say). An admin needs to add "weeks start on Monday here" and have the next question use it.

So Lenspack keeps a log of questions with more than one reading and shows the admin each reading's figures side by side. Once a day, if asked to, it has a strong model read the day's questions and propose fixes. Nothing it proposes is applied until an admin accepts it.

## Definitions

A definition is one of four things:

- **An instruction**: a line the assistant follows ("Weeks start on Monday").
- **A hint** on a measure or dimension ("Before refunds").
- **Synonyms** for a key ("area" and "zone" mean region).
- **A reading for a kind of question**: "when someone asks about sales this month, use the calendar month to date".

Definitions are a document of their own, one per pack, typed and versioned like a pack or a board. They are kept in the server's state directory. They are added to the pack on every chat turn. A change applies to the next question, with no restart. They never change the deployment's own pack file.

Every change keeps who made it, when and why. Any change can be undone, and any earlier version restored. The definitions have their own size budget (4,000 characters by default), shown in the panel, because they are sent with every question. A change that would go over the budget is refused. A change that makes them smaller is always allowed.

Each version has a short key. An answer cache can use it to know that a saved answer was made under older definitions.

The definitions document, its checks and how it is merged into the pack are part of Lenspack's core, not of any one host, so every host and every turn applies them the same way. It is meant as the first part of the documents a deployment lays over its packs.

## Open questions

An open question is a kind of question with two or more readings and no sane default. Each entry keeps:

- the question in general words;
- its readings: a label, what the reading counts, and the query that computes it with the pack's measures and compute steps;
- the questions people actually asked;
- when it was first and last seen, and how often;
- its status (open, answered or dismissed), and the reading chosen.

Entries come from four places:

- the assistant, during a chat;
- the reviewer that checks each answer;
- the daily review;
- an admin, by hand.

A question that matches an existing entry is counted against it, not logged twice.

When an admin answers a question, the chosen reading becomes a definition. From the next turn on, the assistant uses it and does not ask again.

## Clarify

Switch: `clarify`, on by default.

When a question can be read two ways and the readings give different figures, the assistant does one of two things:

- **It asks** one short question. The readings appear as buttons under its reply, in both the Superset chat and the standalone chat. A button sends that reading as the next message. The pick is counted against the reading in the log.
- **It answers** with the most likely reading and says which one it used.

Either way, the question is logged for an admin. It never asks when the pack's rules or an admin's definition already settle the question.

The reviewer, where it already runs, also checks whether an answer used a reading without saying so, or used the wrong one. This adds no extra model call. Such a turn is logged as an open question too.

## The daily review

Switch: `review.daily`, off by default.

Once a day, at a set local time, a strong model reads the period's chat turns. It returns a structured report:

- a summary;
- **findings**: where answers went wrong, citing the turns;
- **proposals**: changes to the definitions, each with why and the turns it would fix;
- **new open questions**, with their readings and the queries behind them;
- **chart candidates**: questions asked often enough to deserve a chart. When an answer cache is running, its own list of frequent questions is given to the review as well.

Each run is kept as a JSON file in the state directory. Proposals wait for an admin. Open questions join the log.

The turns go to the model with users named u1, u2 and so on. The panel shows the real names, to admins only.

Settings, all in the Review tab:

| Setting | Default |
| --- | --- |
| Run every day | off |
| Local time and time zone | 06:00 in the pack's time zone |
| Model | `claude-opus-5-5` |
| Most per run | US$1 |
| Look back | 24 hours |
| Skip a scheduled run below | 5 turns |

The schedule runs inside the server and survives a restart. If the server was down when a run was due, it runs once when the server comes back, not once for every run it missed. Turning the review on does not start a run straight away.

**Run now** first shows how many turns would be read, how many would be shortened or left out, and what the run would cost: about how much, and at most how much. Nothing runs until the admin confirms.

## Compare readings

Switch: `review.compare`, on with the review.

Each reading of an open question has a query. Compare runs those queries on the data, through the same engine as every answer, with no model call. It shows the figures side by side, with a sentence such as: Counting "Every sale" gives 4; counting "Paid sales only" gives 3. Which is appropriate?

It runs after each daily review, for every open question. An admin can also run it on one question from the panel.

## Cost controls

- **The daily review is off** until an admin turns it on.
- **The cap is per run, and it is enforced before the call.** The run plans what it sends against the model's list price, counting the whole input and the longest answer allowed (thinking included). If the turns do not fit, it shortens them, then leaves some out. Turns where something went wrong are kept first. A model with no price is refused, because the cap could not be enforced.
- **Run now shows the cost first.**
- **The minimum-turns setting** skips a scheduled run on a quiet day.
- **Compare readings never calls a model.**
- **Clarify adds one short line** to the prompt, and one optional tool.
- **The reviewer's reading check** is part of the call it already makes.
- **Costs are shown** on the usage board and in each run's report. The review is metered as its own role (`daily-review`), so its spend is counted separately in the usage ledger and the budget.

## Switches

All four are on the admin panel's Settings tab and in `LENSPACK_FEATURES` (see [Feature switches](../operating/switches.md)), for example `LENSPACK_FEATURES="+review.daily"`.

| Switch | Default | What it does |
| --- | --- | --- |
| `clarify` | on | The assistant asks which reading is meant, or says which one it used, and logs the question. |
| `review.daily` | off | The daily review. |
| `review.compare` | on | After a review, compare each open question's readings on the data. |
| `reviewer` | on | The reviewer, which also checks for unstated or wrong readings. |

## Safety

- **Nothing changes without an admin.** The review only proposes. Answering a question, accepting a proposal and every edit to the definitions are an admin's actions.
- **Everything is recorded.** Each change to the definitions keeps who, when and why. The audit log records every admin action and every refusal.
- **Everything can be undone.** Undo the last change, or restore any earlier version.
- **The deployment's pack file is never written.** Definitions live in the state directory.
- **The usage pack reads only the server's own records.** It reads the audit log and the telemetry, copied into a separate in-process database. It cannot reach the deployment's data.
- **Admin only.** The panel, its data and the usage chat are refused to anyone else.


## Where it is kept

Definitions, open questions, proposals and review runs live in the server's state directory. Setting it up and
the list of files are in [What Lenspack keeps on disk](../operating/state.md).

---

**Next:** [The admin panel](admin-panel.md).

**Related:** [Definitions and open questions](../concepts/definitions.md) · [Costs](../operating/costs.md) ·
[Telemetry](telemetry.md)
