# Telemetry

This page says what Lenspack records about how its chat is used, where it is kept, who can read it, and how to
switch each part on or off. It is for admins and for whoever answers privacy questions about a deployment.

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
- **Turning something off stops new records only.** What was already recorded stays until its month ages out, or until it is deleted per user. To remove kept recordings, use the delete actions under [Kept recordings](#kept-recordings).

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

- **Not telemetry**: time saved against the old way, and the true word error rate. Records cannot measure them (see [Metrics coverage](#metrics-coverage)).
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

### Older settings

These still work, as the starting value of an item:

| setting | now |
|---|---|
| `telemetry.questionText`, `LENSPACK_TELEMETRY_QUESTION_TEXT` | `telemetry.items.question-text` |
| `speech.keepAudio`, `LENSPACK_SPEECH_KEEP_AUDIO` | `telemetry.items.voice-audio` |

`PUT <prefix>/settings/telemetry` also takes `questionText` and `keepAudio` as names for those two items. Changing
`keepAudio` through `PUT <prefix>/settings/speech` is refused, with a pointer to the item.

`telemetry.retentionDays` (default 90; also `LENSPACK_TELEMETRY_RETENTION_DAYS` and the Telemetry tab) sets how long
records are kept.

## The deployment's context: campaign, campaign type and country

Lenspack does not know how an organisation is arranged. The deployment says which campaign, campaign type and
country a board, a dataset or a role belongs to, once, in the `context:` section of its config:

```yaml
context:
  superset-12: { campaign: Round 2 }                                   # a board
  visits_round1: { campaign: Round 1, campaignType: door-to-door }     # a dataset, by its table name
  "role:Supervisor-North": { country: Country A }                      # anyone with this role
  "*": { country: Country B }                                          # everything else
```

Each field of a turn is taken from the first key that sets it, in this order:

1. the board;
2. each dataset the turn read, in the order it read them;
3. each of the user's roles;
4. `*`.

A field nothing sets is `null`.

This section belongs to the deployment's policy (`deploymentContextSchema` in `@lenspack/policy`). It will move,
unchanged, into the policy document when that arrives. Who belongs to which role is the sign-in's business: Lenspack
records the roles the host signs and leaves the granularity to the deployment.

## The turn record

One line per chat turn, written after the reply ends, even when the reader left before it did. Every turn record
has `type`, `v`, `turnId`, `at` (when the question arrived), `tenant`, `pack`, `board` and `datasets`. Every other
field belongs to an item, and is left out while that item is off. The Fields read line of each row on the Telemetry
tab says which.

| group | fields |
|---|---|
| identity | `turnId`, `at`, `tenant`, `user`, `roles` (the role names the host signed; `[]` when it signs none), `sessionId` |
| place | `board`, `pack`, `datasets` (what the turn's queries read, by the name the deployment knows them by), `selections` (the viewer's dashboard filter selections when they asked; values hashed when question text is off) |
| context | `campaign`, `campaignType`, `country` (from the deployment's context; `null` when unmapped) |
| language | `languagePicked` (the chat's menu, `auto` or a code), `replyLanguage`, `questionLanguage` (from speech to text for a spoken question, else guessed from its words) |
| input | `input` (`typed` or `spoken`), `question` (only with `question-text` on), `questionHash`, `questionWords` |
| spoken questions | `transcriptId`, `transcriptIds`, `transcript` (what speech to text returned; only with `transcript-text` on), `transcriptHash`, `transcriptEditDistance` (word edits between the transcript and the question sent; 0 when sent as heard) |
| what it was | `kind`: `direct`, `derived`, `chart` or `meta` |
| how it ended | `outcome`: `answered`, `declined`, `failed` or `clarify`, with `outcomeReason` |
| tool calls | `toolCalls`, `queries`, `queriesFailed`, `computeSteps`, `editsApplied`, `editsRefused` |
| timing | `firstTokenMs`, `totalMs`, `queueMs` (time waiting for a free slot; 0 for a saved answer), `abandoned`, `abandonedMs` |
| cost | `costUsd`, split into `modelUsd`, `speechUsd` and `reviewUsd`; `unpricedCalls`, `tokensIn`, `tokensOut`, `models`, `builder`, `effort` |
| review | `reviewRan`, `reviewMaterial` (material findings in the first review), `fixRound` |
| reuse | `reuse`: the tier of a saved answer the turn was answered from, `null` otherwise; `reuseSavedUsd`: what the saved answer saved |
| repeats | `rephraseOf`, `reAskAfterVoice` |
| client | `device` (`mobile`, `tablet`, `desktop`), `viewport` (`narrow`, `medium`, `wide`), `network` (`slow-2g` to `4g`), `saveData`; all off by default |

### What kind of question it was

`kind` is worked out from the turn's tool calls alone, never from the words:

| kind | when |
|---|---|
| `chart` | the turn called a tool that changes the board |
| `meta` | it ran no query (what is on the board, what the pack has, a greeting) |
| `derived` | its queries had compute steps (a share, a change, a rank), or it needed more than one distinct query. A failed query that was retried does not count. |
| `direct` | otherwise: one query |

### How it ended

`outcome` comes from structured results, never from the reply's words:

| outcome | when (`outcomeReason`) |
|---|---|
| `failed` | an error (`error`), a timeout (`timeout`), the step limit reached with no reply (`step-cap`), a change the reviewer still found misleading after its fix round (`rolled-back`), or staged changes that could not be saved (`not-saved`) |
| `clarify` | the turn ended by asking the user a question back |
| `declined` | the provider declined it (`content-filter`); every edit was refused (`refused`, or `read-only` for a viewer); no query returned data (`no-data`); or a turn with no query reported refusals (`refused`) |
| `answered` | anything else |

### Conversations and repeats

- **A conversation** (`sessionId`) continues until 30 minutes pass without a question, the user moves to another board, or they start a new chat.
- **`rephraseOf`** names the user's own earlier turn, within 2 minutes, that asked much the same thing. "Much the same" means at least 0.6 on the larger of two measures: word overlap, or overlap of three-letter pieces.
- **`reAskAfterVoice`** is set when that earlier turn was spoken.
- **When question text is off**, the comparison uses hashed words, so only word overlap counts.

### Answers left early

A turn is `abandoned` when the reader went away before the reply finished: they closed the page, navigated away or
lost the connection. The server sees the connection close. The panel also sends an `abandoned` event when the page
is hidden while an answer is still coming. There is no stop button yet, so "pressed stop" is not recorded.

## Transcripts

Each transcription is recorded when the speech endpoint returns it, when an item that reads transcripts is on:

- `transcriptId`, `at`, `pack` always; `user` and `roles` with the user items;
- `model`, `languageRequested`, `languageDetected`;
- `seconds`, `usd`, `ms`, `retried`;
- `transcript` (with `transcript-text` on), `transcriptHash`, `words`;
- `audio`, which links a kept recording: `{stored: true, bytes, format}`, or `null`.

How a transcript links to its question:

- The endpoint answers with the `transcriptId`. The chat request sends it back, and the turn record links the two, with the word edits between them.
- A transcript can be claimed once, and only by the user who spoke it.
- A transcript no question claims within an hour becomes an `abandoned` event with `stage: "after-transcription"`.
- For a client that cannot send the id, the panel can send a `transcript` event with both texts instead.

## Client events

Clients post events to `<api>/_telemetry`. Inside Superset that is `/lenspack/api/_telemetry`. The rules:

- The body is a JSON object of at most 8 KB.
- The caller must be signed in.
- An event about a turn names its `turnId`, and only the user whose turn it was may report on it. The kernel's policy decides this (`reportsOn` in `@lenspack/policy`).
- The answer is `202` when the event is accepted, with `recorded: false` when the item it belongs to is off.
- Otherwise:
  - `401`: not signed in;
  - `403`: someone else's turn;
  - `404`: no such turn, or telemetry is off;
  - `400`: a malformed event, or one this server does not record;
  - `413`: too large.

| event | fields |
|---|---|
| `feedback` | `turnId`, `rating` (`up` or `down`), optional `reason` (`wrong-number`, `wrong-place`, `misunderstood`, `too-slow`, `other`), optional `comment` (up to 1000 characters) |
| `transcript` | `turnId`, `transcript` (what speech to text returned), `sent` (what was sent): the edit distance is computed on the server |
| `abandoned` | `how` (for example `page-hidden`), `stage` |
| `explain-opened`, `quick-reply`, `chart-exported`, `board-shared` | optional `how`, `stage`, `choice` and `data` |

`data` is a flat map of up to 20 keys with short values. Keys that look like secrets (key, token, password and the
like) are dropped.

The thumbs sit under every answer in the Superset panel and in the demo app. They are labelled for screen readers
and translated into English, French, Portuguese and Hindi.

### For other features: how to add to the record

- **From the page:** `window.lenspackTelemetry.event(type, data)` posts an event about the latest answer. Examples are `explain-opened` and `quick-reply`. It does nothing while telemetry is off.
- **From the turn's code:** the turn's hooks (`TurnCapture.mark`) take `{ reuse: tier, reuseSavedUsd }`, `{ clarify: true }` and `{ queueMs }`.
- **From the reply stream:**
  - a `data-reuse` part (`{ tier, savedUsd }`) fills `reuse` and `reuseSavedUsd`;
  - a `data-clarify` or `data-quick-replies` part marks the turn `clarify`.
- **Review:** the review feature counts its own runs, proposals and open questions; the checklist reads them from it.
- **A new item** goes in the catalogue (`switchboard.ts` in `@lenspack/agent`) with the fields it keeps, its section and its default. A new event type needs an item there too, or the server answers `400`. The catalogue's test checks that each item's switch stops its capture.

## Reading it

These routes are on the Superset host, under `/_superset`. Who may use them is decided by `recordRights` in
`@lenspack/policy`: today, the host's admins. User names are shown as written only to admins who also have the
usage right. Other readers see a stable stand-in (`u_…`) for each name.

| route | what it gives |
|---|---|
| `GET /_superset/telemetry?from=&to=&type=&offset=&limit=` | records newest first, a page at a time (at most 5000; default the last 7 days) |
| `GET /_superset/telemetry/checklist` | the checklist and switchboard below |
| `PUT /_superset/settings/telemetry` | admins: `{"telemetry": bool, "groups.<section>": bool, "items.<item>": bool, "retentionDays": n}`, any of them; `null` puts a switch back to the deployment's value; `"confirm": true` to turn on a privacy-sensitive item. Answers with the checklist. |
| `GET /_superset/telemetry/superset-actions?from=&to=` | exports and shares done in Superset itself on the dashboards Lenspack works on, from Superset's action log (`/api/v1/log/`) |

Two limits on the Superset action log:

- It reads at most ten pages of 100 rows per call.
- It recognises Superset's own event names for downloads, exports, permalinks and email shares. A new name in a later Superset version would be missed until it is added.

### The checklist

`GET /_superset/telemetry/checklist` lists every item, which is also the switchboard. It is grouped as the pilot's
metrics are: users; volume and cost; quality; what people ask; speed; voice and language; conversation; trust and
reuse; device and network. Each section has `on` and `changed` (who changed its switch, and when), and the answer
has `telemetry` (the master switch) and `settings` (retention and the consent notice).

Each item has:

- `label` and the `decision` it helps make;
- `source`: `turn-record`, `client-event`, `transcript`, `audio`, `superset-logs` or `config`;
- the record `fields` it reads;
- `count7d` and `lastSeen`;
- what it means for `privacy`;
- a `status`, and `howToEnable` when the status is not `recording`;
- its `switch`: `key` (`items.<item>`, or `null` with no switch of its own), `on`, `default`, `editable`, and when not editable the `reason` and `blockedBy` (`not-telemetry`, `needs-config` or `feature`, with the `feature` to change instead); `sensitive` and `consent` for the confirm step; `changed`;
- `offSince` and `offBy`, when someone switched it off (its own switch, its section's or telemetry's).

`count7d` and `lastSeen` count only records that carry the item's fields, so an item switched off stops counting.

| status | meaning |
|---|---|
| `recording` | on, and seen in the last 7 days |
| `enabled-no-data` | on, but nothing seen yet |
| `off` | its switch is off, its section's or telemetry's, or the feature that owns it is not present or not on |
| `needs-config` | something is missing. Examples: a country or campaign nobody mapped in `context:`; role names that an older plugin does not sign; Superset's action log outside Superset, or unreadable. |
| `not-telemetry` | records cannot measure it. Examples: time saved against the old way, which needs a baseline study; true word error rate, which needs hand-made transcripts. |

Saved-answer measures belong to the reuse feature, and review measures to the review feature. Until that feature is
present and switched on, their items show `off`.

## Metrics coverage

How each of the pilot's metrics is answered.

**Covered:**

| metric | fields |
|---|---|
| Daily and weekly active users | `user`, `at` |
| By role | `roles` (needs a plugin that signs role names) |
| By country | `country` (needs `context:`) |
| Return next campaign | `user`, `campaign` (needs `context:`) |
| Questions per user | `user`, `turnId` |
| Cost per question and per user | `costUsd`, `modelUsd`, `speechUsd`, `reviewUsd`, `tokensIn`, `tokensOut`, `models` |
| Answer rate by campaign type and language | `outcome`, `outcomeReason`, `campaignType`, `questionLanguage` |
| Top unanswered questions | `outcome`, `question` or `questionHash` |
| Thumbs down and reasons | `feedback` events: `rating`, `reason`, `comment` |
| Top 10 by role | `questionHash`, `question`, `roles` |
| Repeated direct and derived questions | `kind`, `questionHash` |
| Direct, derived and chart mix | `kind` |
| Slowest answers by kind | `totalMs`, `firstTokenMs`, `kind` |
| Abandoned before the answer | `abandoned`, `abandonedMs`, `abandoned` events |
| Voice share | `input` |
| Transcript edit rate | `transcriptEditDistance`, `questionWords` |
| Re-ask after voice | `reAskAfterVoice` |
| Language mix | `questionLanguage`, `replyLanguage`, `languagePicked` |
| Rephrase rate | `rephraseOf` |
| Follow-ups per conversation | `sessionId` |
| Explanation opened | `explain-opened` events, from the panel that shows explanations |
| Export and share | `chart-exported` and `board-shared` events; Superset's action log |
| Waiting for a free slot | `queueMs` |
| Device and network | `device`, `viewport`, `network`, `saveData` (off by default) |

**Partly covered:**

| metric | what is there, and what is missing |
|---|---|
| Clarifying questions answered or dropped | `outcome: clarify`, `quick-reply` events, and the next turn in the same `sessionId`. |
| Word error rate | approximated by word edits over transcript words (`transcriptEditDistance` / `words`). An edit is not always a correction. |
| Saved answers: hit rate by tier, money saved | `reuse` and `reuseSavedUsd`. Money saved is the saved answer's own estimate of the turn it replaced. |
| Review runs, proposals, open questions | counted by the review feature, which owns them |

**Not telemetry:**

| metric | why |
|---|---|
| Time saved against the old way | needs a baseline: the same tasks timed the old way, in a small study |
| True word error rate | needs hand-made transcripts of real clips. Kept recordings and their export make this possible. |

## Kept recordings

**Off by default.** Kept recordings are the `voice-audio` item on the Telemetry tab; turning it on shows the
consent notice and asks the admin to confirm. Off:

- nothing is written;
- a clip lives only as long as its transcription takes;
- the transcript record says `audio: null`.

Either way, **the speech provider receives the audio** in order to transcribe it.

When it is on:

| | |
|---|---|
| what is stored | the bytes as uploaded, at `audio/<yyyy-mm>/<transcriptId>.<ext>` in the state directory, listed in `audio/index.jsonl` with the user and time. The transcript record links it: `audio: {stored: true, bytes, format}`. |
| retention | `speech.audioRetentionDays` (default 30) and `speech.maxStoredMb` (default 1000; the oldest are deleted first when over). Checked at start, daily, and after each saved clip. |
| access | admins only, through `GET /_superset/audio/<transcriptId>`. Each play is written to the audit log. No other route serves audio. |
| consent | with `speech.consentNotice` set, each user sees the notice once and must acknowledge it before the mic records. Changing the notice asks again. |
| deletion | `DELETE /_superset/audio/<transcriptId>`, `DELETE /_superset/audio?user=<name>`, `DELETE /_superset/audio?all=1`. Each deletion is audited. Turning the item off keeps what is stored; the settings page has a "delete stored audio" action. |
| export | `POST /_superset/audio/export` writes `audio/manifest.jsonl` in the speech benchmark's format (`id`, `set`, `lang`, `speaker`, `audio`, `ref`, `seconds`). The reference is the question as sent: the transcript itself when unchanged, the user's correction when edited. These go to `manifest-flagged.jsonl` instead: edits that changed most of the words (more than 40%, or the length by half), clips never sent, questions spoken in several clips, and clips whose text is not kept. Speakers are keyed hashes, not names. |

How long, how much and the consent notice can be changed in four places:

- the settings page;
- the config: `speech.audioRetentionDays`, `speech.maxStoredMb`, `speech.consentNotice`;
- the environment: `LENSPACK_SPEECH_AUDIO_RETENTION_DAYS`, `LENSPACK_SPEECH_MAX_STORED_MB`, `LENSPACK_SPEECH_CONSENT_NOTICE`;
- the admin route `PUT /_superset/settings/speech`.

Recordings sit behind their own storage interface (`AudioStore`). Object storage could serve several copies of
Lenspack through the same methods.

## Privacy notes

- **User names** are recorded while the user items are on, because each deployment wants to know who uses its tool. Only readers the policy allows see them as written. With them off, records carry no name, and feedback on a finished answer still works for the hour the turn stays open.
- **Question text** is off by default. Then each question is kept only as a keyed hash:
  - equal questions share a hash, so repeats can still be counted;
  - nobody without the key can test a guess against it;
  - working state keeps only hashed words.
- **The browser** reports only classes, and only with the device items on: phone, tablet or desktop; a network type; narrow, medium or wide. Never its user agent.
- **Secrets never reach a record.** Event data whose key looks like a secret is dropped, and no record holds a connection string or key.
- **Audio** is not kept unless switched on (above).
- **Switching off deletes nothing.** Records age out with their month; kept recordings can be deleted per user or all at once.

## JSON schema

The three record types share `type` and `v` (the schema version, now 2). Version 2 leaves out the fields of items
that are off, so only each type's core fields are required. New fields may be added; existing ones do not change
meaning.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Lenspack telemetry line",
  "oneOf": [{ "$ref": "#/$defs/turn" }, { "$ref": "#/$defs/transcript" }, { "$ref": "#/$defs/event" }],
  "$defs": {
    "text": { "type": ["string", "null"] },
    "count": { "type": "integer", "minimum": 0 },
    "ms": { "type": ["integer", "null"], "minimum": 0 },
    "usd": { "type": "number", "minimum": 0 },
    "turn": {
      "type": "object",
      "required": ["type", "v", "turnId", "at", "tenant", "pack", "board", "datasets"],
      "properties": {
        "type": { "const": "turn" },
        "v": { "const": 2 },
        "turnId": { "type": "string" },
        "sessionId": { "type": "string" },
        "at": { "type": "string", "format": "date-time" },
        "user": { "type": "string" },
        "roles": { "type": "array", "items": { "type": "string" } },
        "tenant": { "$ref": "#/$defs/text" },
        "board": { "$ref": "#/$defs/text" },
        "pack": { "type": "string" },
        "datasets": { "type": "array", "items": { "type": "string" } },
        "selections": { "type": ["object", "null"], "additionalProperties": { "type": "string" } },
        "campaign": { "$ref": "#/$defs/text" },
        "campaignType": { "$ref": "#/$defs/text" },
        "country": { "$ref": "#/$defs/text" },
        "languagePicked": { "$ref": "#/$defs/text" },
        "replyLanguage": { "$ref": "#/$defs/text" },
        "questionLanguage": { "$ref": "#/$defs/text" },
        "input": { "enum": ["typed", "spoken"] },
        "question": { "$ref": "#/$defs/text" },
        "questionHash": { "type": "string", "pattern": "^[0-9a-f]{24}$" },
        "questionWords": { "$ref": "#/$defs/count" },
        "transcriptId": { "$ref": "#/$defs/text" },
        "transcriptIds": { "type": "array", "items": { "type": "string" } },
        "transcript": { "$ref": "#/$defs/text" },
        "transcriptHash": { "$ref": "#/$defs/text" },
        "transcriptEditDistance": { "type": ["integer", "null"], "minimum": 0 },
        "kind": { "enum": ["direct", "derived", "chart", "meta"] },
        "outcome": { "enum": ["answered", "declined", "failed", "clarify"] },
        "outcomeReason": { "enum": [null, "error", "timeout", "step-cap", "rolled-back", "not-saved", "content-filter", "refused", "read-only", "no-data"] },
        "toolCalls": { "$ref": "#/$defs/count" },
        "queries": { "$ref": "#/$defs/count" },
        "queriesFailed": { "$ref": "#/$defs/count" },
        "computeSteps": { "$ref": "#/$defs/count" },
        "editsApplied": { "$ref": "#/$defs/count" },
        "editsRefused": { "$ref": "#/$defs/count" },
        "firstTokenMs": { "$ref": "#/$defs/ms" },
        "totalMs": { "type": "integer", "minimum": 0 },
        "abandoned": { "type": "boolean" },
        "abandonedMs": { "$ref": "#/$defs/ms" },
        "queueMs": { "$ref": "#/$defs/ms" },
        "costUsd": { "$ref": "#/$defs/usd" },
        "modelUsd": { "$ref": "#/$defs/usd" },
        "speechUsd": { "$ref": "#/$defs/usd" },
        "reviewUsd": { "$ref": "#/$defs/usd" },
        "unpricedCalls": { "$ref": "#/$defs/count" },
        "tokensIn": { "$ref": "#/$defs/count" },
        "tokensOut": { "$ref": "#/$defs/count" },
        "models": { "type": "array", "items": { "type": "string" } },
        "builder": { "type": "string" },
        "effort": { "$ref": "#/$defs/text" },
        "reviewRan": { "type": "boolean" },
        "reviewMaterial": { "$ref": "#/$defs/count" },
        "fixRound": { "type": "boolean" },
        "reuse": { "$ref": "#/$defs/text" },
        "reuseSavedUsd": { "type": ["number", "null"], "minimum": 0 },
        "rephraseOf": { "$ref": "#/$defs/text" },
        "reAskAfterVoice": { "$ref": "#/$defs/text" },
        "device": { "enum": [null, "mobile", "tablet", "desktop"] },
        "network": { "enum": [null, "slow-2g", "2g", "3g", "4g"] },
        "saveData": { "type": ["boolean", "null"] },
        "viewport": { "enum": [null, "narrow", "medium", "wide"] }
      }
    },
    "transcript": {
      "type": "object",
      "required": ["type", "v", "transcriptId", "at", "pack"],
      "properties": {
        "type": { "const": "transcript" },
        "v": { "const": 2 },
        "transcriptId": { "type": "string" },
        "at": { "type": "string", "format": "date-time" },
        "user": { "type": "string" },
        "roles": { "type": "array", "items": { "type": "string" } },
        "pack": { "$ref": "#/$defs/text" },
        "model": { "type": "string" },
        "languageRequested": { "$ref": "#/$defs/text" },
        "languageDetected": { "$ref": "#/$defs/text" },
        "seconds": { "type": ["number", "null"] },
        "usd": { "type": ["number", "null"] },
        "ms": { "type": "integer", "minimum": 0 },
        "retried": { "type": "boolean" },
        "transcript": { "$ref": "#/$defs/text" },
        "transcriptHash": { "type": "string" },
        "words": { "$ref": "#/$defs/count" },
        "audio": {
          "oneOf": [
            { "type": "null" },
            { "type": "object", "required": ["stored", "bytes", "format"], "properties": { "stored": { "const": true }, "bytes": { "$ref": "#/$defs/count" }, "format": { "type": "string" } } }
          ]
        }
      }
    },
    "event": {
      "type": "object",
      "required": ["type", "v", "event", "at", "turnId", "pack", "board", "data"],
      "properties": {
        "type": { "const": "event" },
        "v": { "const": 2 },
        "event": { "type": "string", "pattern": "^[a-z][a-z0-9-]{1,39}$" },
        "at": { "type": "string", "format": "date-time" },
        "user": { "type": "string" },
        "roles": { "type": "array", "items": { "type": "string" } },
        "turnId": { "$ref": "#/$defs/text" },
        "sessionId": { "$ref": "#/$defs/text" },
        "board": { "$ref": "#/$defs/text" },
        "pack": { "$ref": "#/$defs/text" },
        "rating": { "enum": [null, "up", "down"] },
        "reason": { "enum": [null, "wrong-number", "wrong-place", "misunderstood", "too-slow", "other"] },
        "comment": { "$ref": "#/$defs/text" },
        "commentHash": { "$ref": "#/$defs/text" },
        "transcriptId": { "$ref": "#/$defs/text" },
        "transcript": { "$ref": "#/$defs/text" },
        "transcriptSent": { "$ref": "#/$defs/text" },
        "transcriptEditDistance": { "type": ["integer", "null"], "minimum": 0 },
        "transcriptWords": { "type": ["integer", "null"], "minimum": 0 },
        "how": { "$ref": "#/$defs/text" },
        "stage": { "$ref": "#/$defs/text" },
        "choice": { "$ref": "#/$defs/text" },
        "data": { "type": ["object", "null"], "maxProperties": 20, "additionalProperties": { "type": ["string", "number", "boolean", "null"] } }
      }
    }
  }
}
```

---

**Next:** [Voice](voice.md).

**Related:** [The admin panel](admin-panel.md) · [Privacy and data handling](../operating/privacy.md) ·
[What Lenspack keeps on disk](../operating/state.md)
