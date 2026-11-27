# The admin panel

This page describes the admin panel: who can open it, its tabs, and the usage board on its first tab. It is for
admins.

## Who can open it

The panel is served by Lenspack itself, so it looks the same in every host.

- **In Superset**, it is at `/lenspack/_superset/admin/`, linked from the Lenspack settings page (`/ai-assistant/`).
  Only admins can open it: Superset's admins by default, or the Superset roles `auth.admins` names.
- **In the standalone server**, it is at `/_lenspack/admin/`, behind the server's own sign-in. Admins by the
  `auth.admins` rule can open it; without a rule, anyone with a sign-in role named `admin`. It needs a `state:` directory in `lenspack.yaml`.

A deployment can also name its admins one by one, or give each a named password on a sign-in page of their own:
see [Who can use and administer the assistant](../access/admin-access.md).

Anyone else gets a refusal, and the refusal is written to the audit log. Who may open it is decided in one place, the
policy layer, from the roles the host says the caller holds and the deployment's `admins` rule, never a dashboard's
edit right. In Superset, the rule lists Superset role names and defaults to `["Admin"]`; Superset's signed admin flag
does not decide it. In the standalone server, the rule lists user names and `role:<name>` entries and defaults to any
sign-in role or group named `admin`; the built-in password user and the one local user when sign-in is off are always
admins. Being an admin opens these pages and gives no more data. See [Rights](../access/rights.md#admin). The settings page and the saved answers'
routes ask the same question. Usernames (on the usage board and in review reports) are shown only to those who may also
read usage; an admin without that right sees the same figures with the user, the question text and the session hidden.

It has nine tabs, in English and French, in light and dark, and it works at phone width:

| Tab | What it shows |
| --- | --- |
| **Overview** | A board of how people use the server (see [Usage is a board](#usage-is-a-board)), what waits for a decision, and a chat for questions about usage. |
| **Review** | The daily review's settings, a **Run now** button that shows the cost first, and each run's report. |
| **Open questions** | Each question with its readings, each reading's figures, and buttons to answer, dismiss, edit or compare. |
| **Proposals** | The review's proposed changes, each with why and the questions it would fix. Accept, edit then accept, or reject. |
| **Definitions** | What admins have added to the pack: the entries, how much of their size budget they use, undo, and the full history with restore. The pack's own instructions are shown read-only beside them. |
| **Telemetry** | A checklist of every signal Lenspack can record for this deployment (see [What is recorded](#what-is-recorded)). |
| **Cache** | [Saved answers](saved-answers.md): how many questions they answered and what they saved, each entry with pin, unpin and evict, the last refresh with a **Refresh now** button, the most-asked questions per board, chart candidates and settled boards, and **Clear saved answers**, which removes them all at once. With saved answers switched off it lists nothing and says how many are still kept, with the same button. A server that keeps none says caching is not enabled. |
| **Access** | Who is an admin and who may use the assistant, as the deployment set them; the admins owners added and the people admins added, with who added each and when. See [Who can use and administer the assistant](../access/admin-access.md). |
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

The usage pack is an ordinary pack (`packs/usage/pack.yaml` in the server package, with its default boards in
`packs/usage/boards/`: `overview.json` for the Overview tab, `telemetry.json` for the Telemetry tab's What it tells
you). It reads from a small adapter, the usage source, the way other packs read from a
database. The adapter turns the server's own records into tables.

### The data

One row per chat turn, read into an in-process DuckDB table, and beside it each turn's roles and features, each event a
client reported (a rating, a quick reply, an answer left early) and each transcription:

- from the turn telemetry (`telemetry*.jsonl` in the state directory) when the server writes it;
- otherwise from the audit log's chat-turn lines, which carry less (no sessions, roles, countries, feedback or reply
  times from older servers).

The table is read again when the board is opened, at most every 30 seconds.

### What it measures

- **Measures**: turns, questions and edits, active users, cost (model, reviewer and speech), tokens in and out, answers
  from saved answers and the money they saved, failures, refusals, declines, reviewer checks and material findings, fix
  rounds, clarifying questions, open questions logged, rephrased questions, median and 95th-percentile reply time, time
  to first words, speech seconds, thumbs up and down, different questions and different questions not answered,
  answers left early, waits for a free slot and the 95th-percentile wait, transcripts edited and the words changed,
  transcriptions, their cost and seconds, quick replies, explanations opened, exports, shares and transcripts never
  sent.
- **Dimensions**: day and hour, user, role, session, board, pack, campaign and country (when the telemetry has them),
  model, language, typed or spoken, answer or edit, kind of answer (direct, derived, chart, meta), outcome, saved-answer
  tier, feature used, device, network, feedback reason, why a question was not answered, question (its keyed hash
  when the words are not kept), transcript language and speech model.

### The default boards

Overview (`overview.json`):

- Figures: turns today, cost today, saved-answer rate, failure rate, answer rate, spoken share, active users and the
  95th-percentile reply time.
- Lines: turns per day, cost per day by model, daily active users by the `country` label from
  [`context:`](telemetry.md#tagging-records-with-your-own-context), and the spoken share.
- Bars: weekly active users by role, top users, top boards by cost, outcomes and answer rate by language, the
  95th-percentile reply time by kind of answer, and thumbs-down reasons.
- A pie of direct, derived and chart answers.
- A table of the most-asked questions with their outcomes.
- Reply time over time.

The Telemetry tab's What it tells you (`telemetry.json`) is described in
[Telemetry](telemetry.md#what-it-tells-you).

### Who sees it

The usage board is for admins only. It names users as they sign in, so it is never listed beside the deployment's own
packs, and an admin who may not read usage sees it with the user, question and session hidden.

The usage chat's turns are logged and costed like any other. They are marked internal, and left out of the daily review,
so the review never reviews itself.

## What is recorded

The **Telemetry** tab has two views.

**What's recorded** is the switchboard: a compact table of the facts a record can carry, one row per field, grouped
in plain categories (who and where, what was asked, what happened, cost and speed, feedback, voice, texts). Each row
shows:

- its switch. A field that can't be switched here has a disabled switch, and the row itself says why, with a button
  to the switch that owns it (for example "Owned by the daily review switch", with Open Settings);
- the field's plain name, with the record fields it switches on hover or focus and in the detail;
- a status: ✓ recording, ◐ on but nothing yet, ○ off (since when, and by whom), ⚠ needs configuration;
- how many records from the last seven days carry it. This counts records, not the value of a metric;
- the widgets on the What it tells you board that read it;
- an eye for the fields that say something about people, such as user names (visible to admins with the usage
  right) and the texts, with the privacy note on the row and on hover or focus.

Each row opens a detail with the longer text: what it records, where it comes from, its default and config key, when
it was last seen, and its privacy note. Each category's header row folds the category away and has the category's
switch: off turns every field in it off; on turns on every field in it except the privacy-sensitive ones, which are
only turned on one at a time with their confirm step. When some fields are on and some off, the category's switch
shows a middle position. Above the table are a summary line (for example "23 of 34 fields recording · 3 on, nothing
yet · 1 need configuration · 7 off"), the switch for telemetry as a whole, and how long records are kept. On a phone
the table keeps the switch, the name and the status, and the rest moves into the detail.

**What it tells you** is a board over the same usage pack as Overview, drawn by the same renderer, with the same chat
beside it, and the chat's turns are marked internal. It has a section per question a deployment is judged on (users,
volume and cost, quality, what people ask, speed, voice and language, trust and reuse, device and network). A widget
that needs a field that is off says so in place of its figure, for example "Needs the Device and screen width field,
which is switched off", with **Show the field** (to that row under What's recorded) or **Open Settings**. See
[Telemetry](telemetry.md#what-it-tells-you).

A change applies to the next question. Turning something off keeps what was already recorded until it ages out; the
tab says so. Turning on a privacy-sensitive field (question words, transcript words, recordings, device and network
detail) shows what it records, and for recordings the consent notice, and asks to confirm. Only admins can change
switches, and every change is in the audit log.

The page prints cleanly for a usage report, and **Copy as Markdown** copies What's recorded as text, with each switch
as it stands and the widgets that read each field. Both follow the panel's language (English or French) and its light or dark theme.

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
