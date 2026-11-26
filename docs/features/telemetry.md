# Telemetry

This page says what Lenspack records about how its chat is used, why, and how to switch each part on or off. It is
for admins. The record fields are in [Telemetry records](../reference/telemetry-records.md), and what it means for
privacy (kept recordings included) is in [Privacy and data handling](../operating/privacy.md#telemetry).

Lenspack keeps a short record of how its chat is used, so that a deployment can see who uses it, for what, how well
it answers, how fast and at what cost.

In short:

- **What is recorded is simple facts.** One record per chat turn, written when the turn ends, with fields such as who
  asked, how it ended, what it cost and how long it took. One record per transcription, when a question is spoken.
  One record per event a client reports: a thumbs up or down, an answer left before it finished, a chart exported, and
  so on.
- **Metrics are worked out, not stored.** Active users, cost per question, answer rate and the rest are worked out from
  the records of the last 7 days when someone opens the Telemetry tab. See [What it tells you](#what-it-tells-you).
- **Every field has a switch.** The switches are on the facts themselves (the user name, the cost, the answer time, the
  words of a question), grouped in plain categories. There is one switch for telemetry as a whole. See
  [The switchboard](#the-switchboard).
- **On by default**, except the privacy-sensitive fields: question words, transcript words, recordings, and device and
  network detail. Those start off, and turning one on asks an admin to confirm.
- **A field that is off is left out** of the records, rather than written empty.
- **Kept for 90 days**, by month. `retentionDays` changes this.
- **Never stored:** the browser's user agent, keys, passwords or connection strings.

## Where it is kept

The records are JSON lines in `telemetry.jsonl` in the state directory. At the start of each month the previous
month moves to `telemetry-YYYY-MM.jsonl`, and a month is deleted once its last day is older than the retention.

Beside the log there are two more files:

- `telemetry-state.json`: a few short-lived values the next turn reads, such as a user's current conversation, their
  last questions, and transcripts waiting for their question. It is what lets a restart carry on where it left off.
- `telemetry.key` (mode 600): the key questions are hashed with. It is never written into the log.

The log and the state sit behind a small storage interface (`TelemetryStore` in `@lenspack/agent`). The files serve
one copy of Lenspack. A database-backed store can stand in for them, so that several copies share one log and one
state.

Where it runs:

- **Inside Superset**, telemetry is on with the state directory the host already uses.
- **The `lenspack` server** records it when its config has a `telemetry:` section:

```yaml
telemetry:
  dir: ./state          # relative to the config file
  retentionDays: 90     # 1 to 3650
  fields:
    question-text: true # keep the words of each question (off by default: a keyed hash only)
```

## The switchboard

The Telemetry tab of the admin panel has two views. **What's recorded** lists the fields a record can carry, as a
table: one row per field, grouped in categories, each row with its switch, its status, how many records from the
last 7 days carry it, and which metrics use it. That count is of records, not the value of a metric. The same list
is the configuration:

- **Telemetry as a whole** is the `telemetry` feature switch (`features:` in the config, `LENSPACK_FEATURES`, the
  settings page). Off, nothing is recorded.
- **Each field** (`telemetry.fields.<field>`) has a switch of its own. A field is recorded when its switch and
  telemetry's are both on, and nothing locks it.
- **Each category** (who and where, what was asked, what happened, cost and speed, feedback, voice, texts) has a switch
  that sets the switches inside it. It keeps no value of its own:
  - switching it **off** turns every field in it off;
  - switching it **on** turns on every field in it that is not privacy-sensitive. A privacy-sensitive field is only
    ever turned on by its own switch, after a confirm step. This is the safer of the two choices: one click on a
    category can never start keeping texts, recordings or device detail;
  - it shows **on** when every field it can turn on is on, **off** when every field is off, and **mixed** otherwise.
    The Texts category holds only privacy-sensitive fields, so its switch can turn them off but never on.
- **The deployment's config sets the starting values.** Admins change them from the Telemetry tab, or with `PUT
  <prefix>/settings/telemetry`.
- **A change applies to the next record**, without a restart. Each change is in the audit log, and the tab shows who
  turned a field off and when.
- **Turning something off stops new records only.** What was already recorded stays until its month ages out, or until
  it is deleted per user. To remove kept recordings, use the delete actions under [Kept
  recordings](../operating/privacy.md#kept-recordings).

Every key and its default:

```yaml
telemetry:
  fields:
    # Who and where
    user: true
    roles: true
    context: true
    conversation: true
    selections: true
    device-class: false   # privacy-sensitive: confirm to turn on
    device-network: false   # privacy-sensitive: confirm to turn on
    # What was asked
    question-hash: true
    language: true
    repeats: true
    # What happened
    outcome: true
    work: true
    review: true
    reuse: true
    superset-actions: true
    # Cost and speed
    cost: true
    timing: true
    queue: true
    abandoned: true
    # Feedback
    feedback: true
    quick-replies: true
    explain: true
    export-share: true
    personal-dashboards: true
    # Voice
    input: true
    transcript-links: true
    transcript-edits: true
    speech-cost: true
    voice-not-sent: true
    # Texts
    question-text: false   # privacy-sensitive: confirm to turn on
    transcript-text: false   # privacy-sensitive: confirm to turn on
    voice-audio: false   # privacy-sensitive: confirm to turn on
```

Some fields are locked: their switch can't be changed on the tab, and the row says why, with a button to the switch or
setting that owns it.

- **Kept by another feature**: the daily review's runs and proposals, and open questions. Their own feature's switch
  turns them on and off.
- **Owned by a feature that is off**: saved answers follow the `cache` switch, quick replies the `clarify` switch, own
  dashboards the `personalDashboards` switch, and the voice fields the `voice` switch (and a speech key).
- **Waiting for configuration**: the campaign and country tags until `context:` maps one of them, and exports and
  shares in Superset outside Superset.

### Privacy-sensitive fields

Five fields start off: `question-text`, `transcript-text`, `voice-audio`, `device-class` and `device-network`. Turning
one on needs an admin and a confirm step that shows what it records. For recordings, that step also shows the consent
notice users will see. Through the route, the request must carry `"confirm": true`; without it the answer is `409`
with what to confirm, and nothing changes. A category switch never turns one of them on.

Off, each of them still leaves something useful:

- **Question words off**: a keyed hash of each question, so repeats can be counted; the same for feedback comments and
  dashboard filter values.
- **Transcript words off**: a keyed hash of the transcript, so edits before sending can be counted.
- **Recordings off**: the clip lives only as long as its transcription takes.

The user name has a switch too. Its row says that names are visible to admins with the usage right. With it off, the
records name nobody, and metrics that count people say they are unavailable.

## What it tells you

The tab's second view lists the metrics a deployment is judged on, grouped as before (users, volume and cost,
quality, what people ask, speed, voice and language, conversation, trust and reuse, device and network). Each one is
worked out when the tab opens, from the records of the last 7 days, and shows its value, for example "14 users",
"$0.0045" per question or "84%" of questions answered, with a short breakdown. Nothing here is stored, and no metric
shows a user name or the words of a question.

Each metric lists the fields it uses. When it can't be worked out, it says why and offers a way to fix it:

- **Unavailable: needs a field (switched off)**, with a button to that field's switch;
- **Unavailable** because a field it needs is locked (a feature that is off, voice not set up), with a button to
  Settings;
- **Needs configuration**, for example "map dashboards, datasets or roles to a country", in the `context:` section of
  the config;
- **Not measured from records**: time saved against the old way needs a baseline study, and the true word error rate
  needs hand-made transcripts.

A metric reads only the records that carry the fields it needs. So a field switched off part of the week narrows the
reading to the records that have it.

### The older switch names

Before these field switches, telemetry was switched by metric (`telemetry.items.<metric>`) and by section of metrics
(`telemetry.groups.<section>`). A config or saved setting that uses those names still works: a field is on when some
metric that is on, in a section that is on, used it. That is the rule the older switches followed, so what is recorded
does not change. A field switch set in the same place wins over an older name. The five privacy-sensitive items kept
their names, so `items.question-text` is now `fields.question-text`. See
[Upgrading](../operating/upgrading.md#telemetry-switches-by-field).

## Tagging records with your own context

Lenspack does not know how an organisation is arranged. To read usage by, say, sales campaign or country, the
deployment tags boards, datasets and roles once, in the `context:` section of its config. The three fields are
`campaign`, `campaignType` and `country`; use them for whatever grouping your organisation reports by.

```yaml
context:
  superset-1: { campaign: Spring sale }                               # a board
  orders_eu: { campaign: Spring sale, campaignType: email }            # a dataset, by its table name
  "role:Sales-North": { country: Country A }                         # anyone with this role
  "*": { country: Country B }                                        # everything else
```

Each field of a turn is taken from the first key that sets it, in this order: the board; each dataset the turn read,
in the order it read them; each of the user's roles; `*`. A field nothing sets is `null`. The section is part of the
deployment's policy (`deploymentContextSchema` in `@lenspack/policy`). Who belongs to which role is the sign-in's
business: Lenspack records the roles the host signs.

## Reading it

These routes are on the Superset host, under `/_superset`. Who may use them is decided by `recordRights` in
`@lenspack/policy`: today, the host's admins. User names are shown as written only to admins who also have the
usage right. Other readers see a stable stand-in (`u_…`) for each name.

| route | what it gives |
|---|---|
| `GET /_superset/telemetry?from=&to=&type=&offset=&limit=` | records newest first, a page at a time (at most 5000; default the last 7 days) |
| `GET /_superset/telemetry/checklist` | both views of the tab as data: the fields with their switches, and the metrics with their values; see [Telemetry records](../reference/telemetry-records.md#the-checklist) |
| `PUT /_superset/settings/telemetry` | admins: `{"telemetry": bool, "fields.<field>": bool, "categories.<category>": bool, "retentionDays": n}`, any of them; `null` puts a field back to the deployment's value; `"confirm": true` to turn on a privacy-sensitive field. Answers with the checklist. |
| `GET /_superset/telemetry/superset-actions?from=&to=` | exports and shares done in Superset itself on the dashboards Lenspack works on, from Superset's action log (`/api/v1/log/`) |

Two limits on the Superset action log:

- It reads at most ten pages of 100 rows per call.
- It recognises Superset's own event names for downloads, exports, permalinks and email shares. A new name in a later
  Superset version would be missed until it is added.

Every field of every record, the events a client can send and the JSON schema are in
[Telemetry records](../reference/telemetry-records.md).

---

**Next:** [Voice](voice.md).

**Related:** [The admin panel](admin-panel.md) · [Privacy and data handling](../operating/privacy.md#telemetry) ·
[Telemetry records](../reference/telemetry-records.md)
