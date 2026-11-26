# Telemetry

This page says what Lenspack records about how its chat is used, why, and how to switch each part on or off. It is
for admins. The record fields are in [Telemetry records](../reference/telemetry-records.md), and what it means for
privacy (kept recordings included) is in [Privacy and data handling](../operating/privacy.md#telemetry).

Lenspack keeps a short record of how its chat is used, so that a deployment can see who uses it, for what, how well
it answers, how fast and at what cost.

In short:

- **One record per chat turn**, written when the turn ends.
- **One record per transcription**, when a question is spoken.
- **One record per event a client reports**: a thumbs up or down, an answer left before it finished, a chart exported, and so on.
- **Every item has a switch.** What a deployment records is a list of items (daily active users, cost per question, thumbs down and their reasons, and so on), each with its own switch, one switch per section, and one for telemetry as a whole. See [The switchboard](#the-switchboard).
- **On by default**, except the privacy-sensitive items: question text, transcript text, kept recordings, and device and network detail. Those start off, and turning one on asks an admin to confirm.
- **An item that is off leaves its fields out** of the records, rather than writing them empty.
- **Kept for 90 days**, by month. `retentionDays` changes this.
- **Never stored:** the browser's user agent, keys, passwords or connection strings.

## Where it is kept

The records are JSON lines in `telemetry.jsonl` in the state directory. At the start of each month the previous
month moves to `telemetry-YYYY-MM.jsonl`, and a month is deleted once its last day is older than the retention.

Beside the log there are two more files:

- `telemetry-state.json`: a few short-lived values the next turn reads, such as a user's current conversation, their last questions, and transcripts waiting for their question. It is what lets a restart carry on where it left off.
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
  items:
    question-text: true # keep the words of each question (off by default: a keyed hash only)
```

## The switchboard

The Telemetry tab of the admin panel lists every item Lenspack can record, as a table: one row per item, grouped in
sections, each with its switch, its status, how many it saw in the last 7 days and when it last saw one. The same
list is the configuration:

- **Telemetry as a whole** is the `telemetry` feature switch (`features:` in the config, `LENSPACK_FEATURES`, the settings page). Off, nothing is recorded.
- **Each section** (`telemetry.groups.<section>`) and **each item** (`telemetry.items.<item>`) has a switch of its own. An item records only when its own switch, its section's and telemetry's are all on.
- **The deployment's config sets the starting values.** Admins change them from the Telemetry tab, or with `PUT <prefix>/settings/telemetry`.
- **A change applies to the next record**, without a restart. Each change is in the audit log, and the tab shows who turned an item off and when.
- **Turning something off stops new records only.** What was already recorded stays until its month ages out, or until it is deleted per user. To remove kept recordings, use the delete actions under [Kept recordings](../operating/privacy.md#kept-recordings).

Every key and its default:

```yaml
telemetry:
  groups:
    users: true
    volume-cost: true
    quality: true
    asks: true
    speed: true
    voice: true
    conversation: true
    trust-reuse: true
    device-network: true
  items:
    # Users
    users-active: true
    users-by-role: true
    users-by-country: true
    users-return: true
    # Volume and cost
    volume-per-user: true
    cost-per-question: true
    cost-per-user: true
    cost-voice: true
    # Quality
    quality-answer-rate: true
    quality-unanswered: true
    quality-thumbs-down: true
    quality-clarify: true
    # What people ask
    asks-top-by-role: true
    asks-repeated-direct: true
    asks-repeated-derived: true
    asks-mix: true
    question-text: false   # privacy-sensitive: confirm to turn on
    # Speed
    speed-p95: true
    speed-abandoned: true
    speed-queue: true
    # Voice and language
    voice-share: true
    voice-edit-rate: true
    voice-reask: true
    voice-not-sent: true
    language-mix: true
    voice-wer-proxy: true
    transcript-text: false   # privacy-sensitive: confirm to turn on
    voice-audio: false   # privacy-sensitive: confirm to turn on
    # Conversation
    conv-rephrase: true
    conv-follow-ups: true
    # Trust and reuse
    trust-explain: true
    trust-export-share: true
    trust-superset-actions: true
    reuse-hit-rate: true
    reuse-saved: true
    # Device and network
    device-class: false   # privacy-sensitive: confirm to turn on
    device-network: false   # privacy-sensitive: confirm to turn on
```

Some items have no switch of their own:

- **Not telemetry**: time saved against the old way, and the true word error rate. Records cannot measure them: time saved needs a baseline study, and the true error rate needs hand-made transcripts.
- **Kept by another feature**: the daily review's runs and proposals, and open questions. Their own feature's switch turns them on and off.
- **Owned by a feature that is off**: saved answers follow the `cache` switch, clarifying questions the `clarify` switch, and the voice items the `voice` switch. While that feature is off, the item's switch is disabled and the tab points to the feature's switch.
- **Waiting for configuration**: for example, users by country until `context:` maps a country.

### Privacy-sensitive items

Five items start off: `question-text`, `transcript-text`, `voice-audio`, `device-class` and `device-network`. Turning
one on needs an admin and a confirm step that shows what it records. For kept recordings, that step also shows the
consent notice users will see. Through the route, the request must carry `"confirm": true`; without it the answer is
`409` with what to confirm, and nothing changes.

Off, each of them still leaves something useful:

- **Question text off**: a keyed hash of each question, so repeats can be counted; the same for feedback comments and dashboard filter values.
- **Transcript text off**: a keyed hash of the transcript, so edits before sending can be counted.
- **Kept recordings off**: the clip lives only as long as its transcription takes.

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
| `GET /_superset/telemetry/checklist` | the switchboard as data; its fields are in [Telemetry records](../reference/telemetry-records.md#the-checklist) |
| `PUT /_superset/settings/telemetry` | admins: `{"telemetry": bool, "groups.<section>": bool, "items.<item>": bool, "retentionDays": n}`, any of them; `null` puts a switch back to the deployment's value; `"confirm": true` to turn on a privacy-sensitive item. Answers with the checklist. |
| `GET /_superset/telemetry/superset-actions?from=&to=` | exports and shares done in Superset itself on the dashboards Lenspack works on, from Superset's action log (`/api/v1/log/`) |

Two limits on the Superset action log:

- It reads at most ten pages of 100 rows per call.
- It recognises Superset's own event names for downloads, exports, permalinks and email shares. A new name in a later Superset version would be missed until it is added.

Every field of every record, the events a client can send and the JSON schema are in
[Telemetry records](../reference/telemetry-records.md).

---

**Next:** [Voice](voice.md).

**Related:** [The admin panel](admin-panel.md) · [Privacy and data handling](../operating/privacy.md#telemetry) ·
[Telemetry records](../reference/telemetry-records.md)
