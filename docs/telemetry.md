# Usage telemetry

Lenspack keeps a short record of how its chat is used, so that a deployment can see who uses it, for what, how well
it answers, how fast and at what cost. This page says what is recorded, where it is kept, who can read it, and how
to change or switch off each part.

In short:

- **One record per chat turn**, written when the turn ends.
- **One record per transcription**, when a question is spoken.
- **One record per event a client reports**: a thumbs up or down, an answer left before it finished, a chart exported, and so on.
- **On by default.** The `telemetry` switch turns it off.
- **Kept for 90 days**, by month. `retentionDays` changes this.
- **Question text is kept** unless `questionText` is false. Then only a keyed hash of each question is stored.
- **Recordings of spoken questions are not kept** unless `speech.keepAudio` is turned on (see [Kept recordings](#kept-recordings)).
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
  questionText: true    # false: keep a keyed hash instead of the words
```

## Settings

| setting | default | where to change it |
|---|---|---|
| `telemetry` switch | on | settings page (features), `features:` in the config, `LENSPACK_FEATURES` |
| `telemetry.retentionDays` | 90 | settings page, config, `LENSPACK_TELEMETRY_RETENTION_DAYS` |
| `telemetry.questionText` | true | settings page, config, `LENSPACK_TELEMETRY_QUESTION_TEXT` |
| `speech.keepAudio` and the other recording settings | off | see [Kept recordings](#kept-recordings) |

The settings page wins over the environment, and the environment over the config. Setting `questionText` to false
covers question text, transcript text, feedback comments and the free text of other events. It applies from then
on: records already written keep what they had until their month expires.

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

One line per chat turn, written after the reply ends, even when the reader left before it did.

| group | fields |
|---|---|
| identity | `turnId`, `sessionId`, `at` (when the question arrived), `user`, `roles` (the role names the host signed; `[]` when it signs none), `tenant` |
| place | `board`, `pack`, `datasets` (what the turn's queries read, by the name the deployment knows them by), `selections` (the viewer's dashboard filter selections when they asked; values hashed when question text is off) |
| context | `campaign`, `campaignType`, `country` (from the deployment's context; `null` when unmapped) |
| language | `languagePicked` (the chat's menu, `auto` or a code), `replyLanguage`, `questionLanguage` (from speech to text for a spoken question, else guessed from its words) |
| input | `input` (`typed` or `spoken`), `question`, `questionHash`, `questionWords` |
| spoken questions | `transcriptId`, `transcriptIds`, `transcript` (what speech to text returned), `transcriptHash`, `transcriptEditDistance` (word edits between the transcript and the question sent; 0 when sent as heard) |
| what it was | `kind`: `direct`, `derived`, `chart` or `meta` |
| how it ended | `outcome`: `answered`, `declined`, `failed` or `clarify`, with `outcomeReason` |
| tool calls | `toolCalls`, `queries`, `queriesFailed`, `computeSteps`, `editsApplied`, `editsRefused` |
| timing | `firstTokenMs`, `totalMs`, `abandoned`, `abandonedMs` |
| cost | `costUsd`, split into `modelUsd`, `speechUsd` and `reviewUsd`; `unpricedCalls`, `tokensIn`, `tokensOut`, `models`, `builder`, `effort` |
| review | `reviewRan`, `reviewMaterial` (material findings in the first review), `fixRound` |
| reuse | `reuse`: the tier of a saved answer the turn was answered from; `null` otherwise |
| repeats | `rephraseOf`, `reAskAfterVoice` |
| client | `device` (`mobile`, `tablet`, `desktop`), `network` (`slow-2g` to `4g`), `saveData`, `viewport` (`narrow`, `medium`, `wide`) |

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

Each transcription is recorded when the speech endpoint returns it:

- `transcriptId`, `at`, `user`, `roles`, `pack`;
- `model`, `languageRequested`, `languageDetected`;
- `seconds`, `usd`, `ms`, `retried`;
- `transcript`, `transcriptHash`, `words`;
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
- The answer is `202` when the event is kept.
- Otherwise:
  - `401`: not signed in;
  - `403`: someone else's turn;
  - `404`: no such turn, or telemetry is off;
  - `400`: a malformed event;
  - `413`: too large.

| event | fields |
|---|---|
| `feedback` | `turnId`, `rating` (`up` or `down`), optional `reason` (`wrong-number`, `wrong-place`, `misunderstood`, `too-slow`, `other`), optional `comment` (up to 1000 characters) |
| `transcript` | `turnId`, `transcript` (what speech to text returned), `sent` (what was sent): the edit distance is computed on the server |
| `abandoned` | `how` (for example `page-hidden`), `stage` |
| `explain-opened`, `quick-reply`, `chart-exported`, `board-shared`, … | any short lower-case name; optional `how`, `stage`, `choice` and `data` |

`data` is a flat map of up to 20 keys with short values. Keys that look like secrets (key, token, password and the
like) are dropped.

The thumbs sit under every answer in the Superset panel and in the demo app. They are labelled for screen readers
and translated into English, French, Portuguese and Hindi.

### For other features: how to add to the record

- **From the page:** `window.lenspackTelemetry.event(type, data)` posts an event about the latest answer. Examples are `explain-opened` and `quick-reply`. It does nothing while telemetry is off.
- **From the turn's code:** the turn's hooks (`TurnCapture.mark`) take `{ reuse: tier }` and `{ clarify: true }`.
- **From the reply stream:**
  - a `data-reuse` part (`{ tier }`) fills `reuse`;
  - a `data-clarify` or `data-quick-replies` part marks the turn `clarify`.
- **Review:** the review feature reports `review-run`, `review-proposal` and `review-open-question` events.

## Reading it

These routes are on the Superset host, under `/_superset`. Who may use them is decided by `recordRights` in
`@lenspack/policy`: today, the host's admins. User names are shown as written only to admins who also have the
usage right. Other readers see a stable stand-in (`u_…`) for each name.

| route | what it gives |
|---|---|
| `GET /_superset/telemetry?from=&to=&type=&offset=&limit=` | records newest first, a page at a time (at most 5000; default the last 7 days) |
| `GET /_superset/telemetry/checklist` | the checklist below |
| `PUT /_superset/settings/telemetry` | `{retentionDays, questionText}`; `null` puts a field back to the deployment's value |
| `GET /_superset/telemetry/superset-actions?from=&to=` | exports and shares done in Superset itself on the dashboards Lenspack works on, from Superset's action log (`/api/v1/log/`) |

Two limits on the Superset action log:

- It reads at most ten pages of 100 rows per call.
- It recognises Superset's own event names for downloads, exports, permalinks and email shares. A new name in a later Superset version would be missed until it is added.

### The checklist

`GET /_superset/telemetry/checklist` lists every measure the pilot is judged on. It is grouped as the pilot's
metrics are: users; volume and cost; quality; what people ask; speed; voice and language; conversation; trust and
reuse; device and network.

Each item has:

- `label` and the `decision` it helps make;
- `source`: `turn-record`, `client-event`, `transcript`, `audio`, `superset-logs` or `config`;
- the record `fields` it reads;
- `count7d` and `lastSeen`;
- what it means for `privacy`;
- a `status`, and `howToEnable` when the status is not `recording`.

| status | meaning |
|---|---|
| `recording` | on, and seen in the last 7 days |
| `enabled-no-data` | on, but nothing seen yet |
| `off` | its switch is off, or the feature that owns it is not present or not on |
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
| Device and network | `device`, `viewport`, `network`, `saveData` |

**Partly covered:**

| metric | what is there, and what is missing |
|---|---|
| Clarifying questions answered or dropped | `outcome: clarify` and the next turn in the same `sessionId`. The turn is only marked once the clarifying feature sends its part. |
| Word error rate | approximated by word edits over transcript words (`transcriptEditDistance` / `words`). An edit is not always a correction. |
| Saved answers: hit rate by tier, money saved | `reuse` once answer reuse fills it. Money saved compares with turns of the same kind that were not reused. |
| Review runs, proposals, open questions | events the review feature sends |
| Waiting for a free slot | there is no queue yet, so nothing waits. A `queueMs` field arrives with one. |

**Not telemetry:**

| metric | why |
|---|---|
| Time saved against the old way | needs a baseline: the same tasks timed the old way, in a small study |
| True word error rate | needs hand-made transcripts of real clips. Kept recordings and their export make this possible. |

## Kept recordings

**Off by default.** Then:

- nothing is written;
- a clip lives only as long as its transcription takes;
- the transcript record says `audio: null`.

Either way, **the speech provider receives the audio** in order to transcribe it.

When `speech.keepAudio` is on:

| | |
|---|---|
| what is stored | the bytes as uploaded, at `audio/<yyyy-mm>/<transcriptId>.<ext>` in the state directory, listed in `audio/index.jsonl` with the user and time. The transcript record links it: `audio: {stored: true, bytes, format}`. |
| retention | `speech.audioRetentionDays` (default 30) and `speech.maxStoredMb` (default 1000; the oldest are deleted first when over). Checked at start, daily, and after each saved clip. |
| access | admins only, through `GET /_superset/audio/<transcriptId>`. Each play is written to the audit log. No other route serves audio. |
| consent | with `speech.consentNotice` set, each user sees the notice once and must acknowledge it before the mic records. Changing the notice asks again. |
| deletion | `DELETE /_superset/audio/<transcriptId>`, `DELETE /_superset/audio?user=<name>`, `DELETE /_superset/audio?all=1`. Each deletion is audited. Turning `keepAudio` off keeps what is stored; the settings page has a "delete stored audio" action. |
| export | `POST /_superset/audio/export` writes `audio/manifest.jsonl` in the speech benchmark's format (`id`, `set`, `lang`, `speaker`, `audio`, `ref`, `seconds`). The reference is the question as sent: the transcript itself when unchanged, the user's correction when edited. These go to `manifest-flagged.jsonl` instead: edits that changed most of the words (more than 40%, or the length by half), clips never sent, questions spoken in several clips, and clips whose text is not kept. Speakers are keyed hashes, not names. |

These settings can be changed in four places:

- the settings page;
- the config: `speech.keepAudio`, `speech.audioRetentionDays`, `speech.maxStoredMb`, `speech.consentNotice`;
- the environment: `LENSPACK_SPEECH_KEEP_AUDIO`, `LENSPACK_SPEECH_AUDIO_RETENTION_DAYS`, `LENSPACK_SPEECH_MAX_STORED_MB`, `LENSPACK_SPEECH_CONSENT_NOTICE`;
- the admin route `PUT /_superset/settings/speech`.

Recordings sit behind their own storage interface (`AudioStore`). Object storage could serve several copies of
Lenspack through the same methods.

## Privacy notes

- **User names** are recorded, because each deployment wants to know who uses its tool. Only readers the policy allows see them as written.
- **Question text** is kept unless `questionText` is false. Then each question is kept only as a keyed hash:
  - equal questions share a hash, so repeats can still be counted;
  - nobody without the key can test a guess against it;
  - working state keeps only hashed words.
- **The browser** reports only classes: phone, tablet or desktop; a network type; narrow, medium or wide. Never its user agent.
- **Secrets never reach a record.** Event data whose key looks like a secret is dropped, and no record holds a connection string or key.
- **Audio** is not kept unless switched on (above).

## JSON schema

The three record types share `type` and `v` (the schema version, now 1). New fields may be added; existing ones do
not change meaning.

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
      "required": ["type", "v", "turnId", "sessionId", "at", "user", "roles", "board", "pack", "datasets", "kind", "outcome", "input", "questionHash", "totalMs", "costUsd"],
      "properties": {
        "type": { "const": "turn" },
        "v": { "const": 1 },
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
      "required": ["type", "v", "transcriptId", "at", "user", "model", "transcriptHash", "words", "audio"],
      "properties": {
        "type": { "const": "transcript" },
        "v": { "const": 1 },
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
      "required": ["type", "v", "event", "at", "user"],
      "properties": {
        "type": { "const": "event" },
        "v": { "const": 1 },
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
