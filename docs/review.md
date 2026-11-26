# Review, open questions and the admin panel

A data assistant gets most of its answers wrong in the same few ways. Someone asks "how many visits this month?" and the assistant reads "this month" as the last 30 days, while the person meant the calendar month. Someone asks about "stock" and the pack has two measures that could be meant. Neither reading is a bug. The pack does not say which one this deployment means, so the assistant guesses.

This page covers the tools that find those guesses and settle them. They all work through the admin panel:

- a daily review of how people used the assistant;
- a log of open questions;
- a layer of definitions that admins add on top of the pack;
- a way for the assistant to ask which reading was meant.

## Why

The pack file is written once, by someone who knows the data. People then ask questions it never thought of. Two things follow:

- **Some questions have no sane default.** "Counting this way gives 4,100; counting that way gives 3,600. Which is right?" Only someone who runs the deployment can answer. The assistant should say it is unsure, not hide the guess.
- **Fixing a definition should not need a release.** A deployment's pack often sits in a read-only mounted file (a ConfigMap). An admin needs to add "weeks start on Monday here" and have the next question use it.

So Lenspack keeps a log of questions with more than one reading and shows the admin each reading's figures side by side. Once a day, if asked to, it has a strong model read the day's questions and propose fixes. Nothing it proposes is applied until an admin accepts it.

## What the admin sees

The panel is served by Lenspack itself, so it looks the same in every host.

- **In Superset**, it is at `/lenspack/_superset/admin/`, linked from the Lenspack settings page (`/ai-assistant/`). Only Superset admins can open it.
- **In the standalone server**, it is at `/_lenspack/admin/`, behind the server's own sign-in. Only the admin can open it. It needs a `state:` directory in `lenspack.yaml` (see below).

Anyone else gets a refusal, and the refusal is written to the audit log. Who may open it is decided in one place, the policy layer, from what the host says about the caller: the admin role (a Superset admin, or the standalone server's built-in admin), never a dashboard's edit right. The settings page and the saved answers' routes ask the same question. Usernames (on the usage board and in review reports) are shown only to those who may also read usage; an admin without that right sees the same figures with the user, the question text and the session hidden.

It has eight tabs, in English and French, in light and dark, and it works at phone width:

| Tab | What it shows |
| --- | --- |
| **Overview** | A board of how people use the server (see [Usage is a board](#usage-is-a-board)), what waits for a decision, and a chat for questions about usage. |
| **Review** | The daily review's settings, a **Run now** button that shows the cost first, and each run's report. |
| **Open questions** | Each question with its readings, each reading's figures, and buttons to answer, dismiss, edit or compare. |
| **Proposals** | The review's proposed changes, each with why and the questions it would fix. Accept, edit then accept, or reject. |
| **Definitions** | What admins have added to the pack: the entries, how much of their size budget they use, undo, and the full history with restore. The pack's own instructions are shown read-only beside them. |
| **Telemetry** | A checklist of every signal Lenspack can record for this deployment (see [What is recorded](#what-is-recorded)). |
| **Cache** | Saved answers ([caching.md](caching.md)): how many questions they answered and what they saved, each entry with pin, unpin and evict, the last refresh with a **Refresh now** button, the most-asked questions per board, chart candidates and settled boards. A server that keeps none says caching is not enabled. |
| **Settings** | Every switch, with where its value comes from (default, config file, environment, or set here). |

## The flows

### Definitions set by an admin

A definition is one of four things:

- **An instruction**: a line the assistant follows ("Weeks start on Monday").
- **A hint** on a measure or dimension ("Before refunds").
- **Synonyms** for a key ("area" and "zone" mean region).
- **A reading for a kind of question**: "when someone asks about sales this month, use the calendar month to date".

Definitions are a document of their own, one per pack, typed and versioned like a pack or a board. They are kept in the server's state directory. They are added to the pack on every chat turn. A change applies to the next question, with no restart. They never change the deployment's own pack file.

Every change keeps who made it, when and why. Any change can be undone, and any earlier version restored. The definitions have their own size budget (4,000 characters by default), shown in the panel, because they are sent with every question. A change that would go over the budget is refused. A change that makes them smaller is always allowed.

Each version has a short key. An answer cache can use it to know that a saved answer was made under older definitions.

The definitions document, its checks and how it is merged into the pack are part of Lenspack's core, not of any one host, so every host and every turn applies them the same way. It is meant as the first part of the documents a deployment lays over its packs.

### Open questions

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

### Clarify (switch: `clarify`)

When a question can be read two ways and the readings give different figures, the assistant does one of two things:

- **It asks** one short question. The readings appear as buttons under its reply, in both the Superset chat and the standalone chat. A button sends that reading as the next message. The pick is counted against the reading in the log.
- **It answers** with the most likely reading and says which one it used.

Either way, the question is logged for an admin. It never asks when the pack's rules or an admin's definition already settle the question.

The reviewer, where it already runs, also checks whether an answer used a reading without saying so, or used the wrong one. This adds no extra model call. Such a turn is logged as an open question too.

### Daily review (switch: `review.daily`, off by default)

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

### Compare readings (switch: `review.compare`, on with the review)

Each reading of an open question has a query. Compare runs those queries on the data, through the same engine as every answer, with no model call. It shows the figures side by side, with a sentence such as: Counting "Every sale" gives 4; counting "Paid sales only" gives 3. Which is appropriate?

It runs after each daily review, for every open question. An admin can also run it on one question from the panel.

## Usage is a board

The Overview tab is not a set of hand-drawn charts. It is a Lenspack board, drawn by the same engine and the same chart renderer as every other board, over a built-in pack about the server itself.

**Why.**

- **Admins learn the tool by using it.** The board they read every day works like the boards their users have. Its widgets, filters, edits and version history behave the same way. An admin can add a chart, change one or undo a change, just as on any board.
- **The tool explains itself.** The chat beside the board answers questions about usage, such as "which board cost most this week?" or "how many questions were answered from saved answers yesterday?". It uses the same agent and the same rules as every answer: plain counts in the pack, and rates and averages worked out by the compute step.
- **Nothing to maintain twice.** A new chart type or a fix to the renderer reaches the usage board for free.

**How it is built.** The usage pack is an ordinary pack (`packs/usage/pack.yaml` in the server package, with its default board in `packs/usage/boards/overview.json`). It reads from a small adapter, the usage source, the way other packs read from a database. The adapter turns the server's own records into tables.

**The data.** One row per chat turn, read into an in-process DuckDB table:

- from the turn telemetry (`telemetry*.jsonl` in the state directory) when the server writes it;
- otherwise from the audit log's chat-turn lines, which carry less (no sessions, roles, countries, feedback or reply times from older servers).

The table is read again when the board is opened, at most every 30 seconds.

**What it measures.**

- **Measures**: turns, questions and edits, active users, cost (model, reviewer and speech), tokens in and out, answers from saved answers and the money they saved, failures, refusals, declines, reviewer checks and material findings, fix rounds, clarifying questions, open questions logged, rephrased questions, median and 95th-percentile reply time, time to first words, speech seconds, thumbs up and down.
- **Dimensions**: day and hour, user, role, session, board, pack, campaign and country (when the telemetry has them), model, language, typed or spoken, answer or edit, kind of answer (direct, derived, chart, meta), outcome, saved-answer tier, feature used, device, and feedback reason.

**The default board.**

- Figures: turns today, cost today, saved-answer rate, failure rate, answer rate, spoken share, active users and the 95th-percentile reply time.
- Lines: turns per day, cost per day by model, daily active users by country, and the spoken share.
- Bars: weekly active users by role, top users, top boards by cost, outcomes and answer rate by language, the 95th-percentile reply time by kind of answer, and thumbs-down reasons.
- A pie of direct, derived and chart answers.
- A table of the most-asked questions with their outcomes.
- Reply time over time.

**Who sees it.** The usage board is for admins only. It names users as they sign in, so it is never listed beside the deployment's own packs, and an admin who may not read usage sees it with the user, question and session hidden.

The usage chat's turns are logged and costed like any other. They are marked internal, and left out of the daily review, so the review never reviews itself. An answer cache should leave them out of its suggestions too.

## What is recorded

The **Telemetry** tab is the deployment's telemetry switchboard: a compact table of every item Lenspack can record,
one row per item, grouped by section. Each row shows:

- its switch. An item that cannot be switched here has a disabled switch with the reason: it is not telemetry, it needs configuring first, or a feature that is off owns it (with a link to that feature's switch on the Settings tab);
- a status: ✓ recording, ◐ on but no data yet, ○ off (since when, and by whom), ⚠ needs configuration, — not telemetry;
- how many it saw in the last seven days, and when it last saw one;
- the decision the item feeds ("whether voice is worth its cost"), cut short with the full text on hover or focus;
- a lock for the privacy-sensitive items, with the note on hover or focus.

Each row opens a detail with the longer text: the fields it reads, where it comes from, its default and config key,
how to turn it on, and its privacy note. Each section's header row has the section's switch and folds the section
away. Above the table are a summary line ("28 of 42 recording · 4 on but no data · 1 need configuration · 7 off · 2
not telemetry"), the switch for telemetry as a whole, and how long records are kept. On a phone the table keeps the
switch, the name and the status, and the rest moves into the detail.

A change applies to the next question. Turning something off keeps what was already recorded until it ages out; the
tab says so. Turning on a privacy-sensitive item (question text, transcript text, kept recordings, device and network
detail) shows what it records, and for kept recordings the consent notice, and asks to confirm. Only admins can
change switches, and every change is in the audit log.

The page prints cleanly for a pilot report, and **Copy as Markdown** copies the same table as text, with each
switch as it stands. Both follow the panel's language (English or French) and its light or dark theme.

The table comes from the server (`<prefix>/telemetry/checklist`, changed with `PUT <prefix>/settings/telemetry`; see
[telemetry.md](telemetry.md#the-switchboard)). A server that does not report its telemetry shows "Telemetry is not
available on this server".

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

All four are in the Settings tab and in `LENSPACK_FEATURES`, for example `LENSPACK_FEATURES="+review.daily"`.

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

## Setting it up

**Superset.** Nothing to add. The state directory the host already uses holds the definitions, questions, runs and usage tables. Open the Lenspack settings page in Superset and follow the link to the admin panel. The panel works with Superset's default Content-Security-Policy: the plugin stamps the page's nonce on its scripts.

**Standalone server.** Add a writable directory to `lenspack.yaml`:

```yaml
state: ./state        # switches, definitions, open questions, review runs, the usage board
features:             # optional starting values; the panel can change them
  review.daily: false
```

With `state:` set, the audit log is kept there by month, unless `audit:` names a file. The panel is at `/_lenspack/admin/`, for the admin. With `cache:` set too, the saved answers' routes are at `/_lenspack/cache`, and the panel's switches and settings apply to them.

What the state directory holds:

Everything in it except the usage tables sits behind a small document store: each file is one named document, read fresh on every use and written only if it has not changed since it was read. A database can take the files' place, so two copies of a server can share them.

| File | What |
| --- | --- |
| `definitions-<pack>.json` | the definitions and their history |
| `open-questions-<pack>.json` | the open-questions log |
| `review-proposals.json` | proposals and what became of them |
| `review-runs/<id>.json` | each review run's report (the last 90) |
| `review-state.json` | the last scheduled time handled |
| `usage.duckdb` | the usage tables and the usage board's versions |
| `settings.json` | switches and the review's settings |
