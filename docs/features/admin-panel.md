# The admin panel

This page describes the admin panel: who can open it, its tabs, and the usage board on its first tab. It is for
admins.

## Who can open it

The panel is served by Lenspack itself, so it looks the same in every host.

- **In Superset**, it is at `/lenspack/_superset/admin/`, linked from the Lenspack settings page (`/ai-assistant/`).
  Only Superset admins can open it.
- **In the standalone server**, it is at `/_lenspack/admin/`, behind the server's own sign-in. Anyone with a sign-in
  role named `admin` can open it. It needs a `state:` directory in `lenspack.yaml`.

Anyone else gets a refusal, and the refusal is written to the audit log. Who may open it is decided in one place, the
policy layer, from what the host says about the caller: the admin role, never a dashboard's edit right. In Superset that
is a Superset admin, from the signed admin flag (a Superset role that happens to be named `admin` does not count). In
the standalone server it is any sign-in role or group named `admin`: the built-in password user, a role from OpenID
Connect, a login proxy or a token, or the one local user when sign-in is off. The settings page and the saved answers'
routes ask the same question. Usernames (on the usage board and in review reports) are shown only to those who may also
read usage; an admin without that right sees the same figures with the user, the question text and the session hidden.

It has eight tabs, in English and French, in light and dark, and it works at phone width:

| Tab | What it shows |
| --- | --- |
| **Overview** | A board of how people use the server (see [Usage is a board](#usage-is-a-board)), what waits for a decision, and a chat for questions about usage. |
| **Review** | The daily review's settings, a **Run now** button that shows the cost first, and each run's report. |
| **Open questions** | Each question with its readings, each reading's figures, and buttons to answer, dismiss, edit or compare. |
| **Proposals** | The review's proposed changes, each with why and the questions it would fix. Accept, edit then accept, or reject. |
| **Definitions** | What admins have added to the pack: the entries, how much of their size budget they use, undo, and the full history with restore. The pack's own instructions are shown read-only beside them. |
| **Telemetry** | A checklist of every signal Lenspack can record for this deployment (see [What is recorded](#what-is-recorded)). |
| **Cache** | [Saved answers](saved-answers.md): how many questions they answered and what they saved, each entry with pin, unpin and evict, the last refresh with a **Refresh now** button, the most-asked questions per board, chart candidates and settled boards. A server that keeps none says caching is not enabled. |
| **Settings** | Every switch, with where its value comes from (default, config file, environment, or set here). |

## Usage is a board

The Overview tab is not a set of hand-drawn charts. It is a Lenspack board, drawn by the same engine and the same chart
renderer as every other board, over a built-in pack about the server itself.

### Why

- **Admins learn the tool by using it.** The board they read every day works like the boards their users have. Its
  widgets, filters, edits and version history behave the same way. An admin can add a chart, change one or undo a
  change, just as on any board.
- **The tool explains itself.** The chat beside the board answers questions about usage, such as "which board cost most
  this week?" or "how many questions were answered from saved answers yesterday?". It uses the same agent and the same
  rules as every answer: plain counts in the pack, and rates and averages worked out by the compute step.
- **Nothing to maintain twice.** A new chart type or a fix to the renderer reaches the usage board for free.

### How it is built

The usage pack is an ordinary pack (`packs/usage/pack.yaml` in the server package, with its default board in
`packs/usage/boards/overview.json`). It reads from a small adapter, the usage source, the way other packs read from a
database. The adapter turns the server's own records into tables.

### The data

One row per chat turn, read into an in-process DuckDB table:

- from the turn telemetry (`telemetry*.jsonl` in the state directory) when the server writes it;
- otherwise from the audit log's chat-turn lines, which carry less (no sessions, roles, countries, feedback or reply
  times from older servers).

The table is read again when the board is opened, at most every 30 seconds.

### What it measures

- **Measures**: turns, questions and edits, active users, cost (model, reviewer and speech), tokens in and out, answers
  from saved answers and the money they saved, failures, refusals, declines, reviewer checks and material findings, fix
  rounds, clarifying questions, open questions logged, rephrased questions, median and 95th-percentile reply time, time
  to first words, speech seconds, thumbs up and down.
- **Dimensions**: day and hour, user, role, session, board, pack, campaign and country (when the telemetry has them),
  model, language, typed or spoken, answer or edit, kind of answer (direct, derived, chart, meta), outcome, saved-answer
  tier, feature used, device, and feedback reason.

### The default board

- Figures: turns today, cost today, saved-answer rate, failure rate, answer rate, spoken share, active users and the
  95th-percentile reply time.
- Lines: turns per day, cost per day by model, daily active users by the `country` label from
  [`context:`](telemetry.md#tagging-records-with-your-own-context), and the spoken share.
- Bars: weekly active users by role, top users, top boards by cost, outcomes and answer rate by language, the
  95th-percentile reply time by kind of answer, and thumbs-down reasons.
- A pie of direct, derived and chart answers.
- A table of the most-asked questions with their outcomes.
- Reply time over time.

### Who sees it

The usage board is for admins only. It names users as they sign in, so it is never listed beside the deployment's own
packs, and an admin who may not read usage sees it with the user, question and session hidden.

The usage chat's turns are logged and costed like any other. They are marked internal, and left out of the daily review,
so the review never reviews itself.

## What is recorded

The **Telemetry** tab is the deployment's telemetry switchboard: a compact table of every item Lenspack can record,
one row per item, grouped by section. Each row shows:

- its switch. An item that cannot be switched here has a disabled switch with the reason: it is not telemetry, it
  needs configuring first, or a feature that is off owns it (with a link to that feature's switch on the Settings
  tab);
- a status: ✓ recording, ◐ on but no data yet, ○ off (since when, and by whom), ⚠ needs configuration, — not
  telemetry (kept for another reason, such as the audit log);
- how many it saw in the last seven days, and when it last saw one;
- the decision the item feeds ("whether voice is worth its cost"), cut short with the full text on hover or focus;
- a lock for the privacy-sensitive items, with the note on hover or focus.

Each row opens a detail with the longer text: the fields it reads, where it comes from, its default and config key,
how to turn it on, and its privacy note. Each section's header row has the section's switch and folds the section
away. Above the table are a summary line (for example "28 of 42 recording · 4 on but no data · 1 need configuration
· 7 off · 2 not telemetry"), the switch for telemetry as a whole, and how long records are kept. On a phone the table
keeps the switch, the name and the status, and the rest moves into the detail.

A change applies to the next question. Turning something off keeps what was already recorded until it ages out; the
tab says so. Turning on a privacy-sensitive item (question text, transcript text, kept recordings, device and network
detail) shows what it records, and for kept recordings the consent notice, and asks to confirm. Only admins can
change switches, and every change is in the audit log.

The page prints cleanly for a usage report, and **Copy as Markdown** copies the same table as text, with each switch
as it stands. Both follow the panel's language (English or French) and its light or dark theme.

The table comes from the server (`<prefix>/telemetry/checklist`, changed with `PUT <prefix>/settings/telemetry`; see
[Telemetry](telemetry.md#the-switchboard)). A server that does not report its telemetry shows "Telemetry is not
available on this server".

## Setting it up

**Superset.** Nothing to add. The state directory the host already uses holds the definitions, questions, runs and
usage tables. Open the Lenspack settings page in Superset (Settings → Manage → AI assistant) and follow the link to
the admin panel. The panel works with Superset's default Content-Security-Policy: the plugin stamps the page's
nonce on its scripts.

**Standalone server.** Add a writable directory to `lenspack.yaml`:

```yaml
state: ./state        # switches, definitions, open questions, review runs, the usage board
features:             # optional starting values; the panel can change them
  review.daily: false
```

With `state:` set, the audit log is kept there by month, unless `audit:` names a file. The panel is at
`/_lenspack/admin/`. With `cache:` set too, the saved answers' routes are at `/_lenspack/cache`, and the panel's
switches and settings apply to them. What the folder holds is in [What Lenspack keeps on disk](../operating/state.md).

---

**Next:** [Telemetry](telemetry.md).

**Related:** [Open questions and definitions](open-questions.md) · [Feature switches](../operating/switches.md) ·
[Rights](../access/rights.md#admin)
