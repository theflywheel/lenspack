# Telemetry records

This page lists every field Lenspack's usage telemetry writes, the events a client can send, the checklist's fields
and the JSON schema. It is for whoever builds reports on the records or adds to them. What telemetry is for, and its
switches, are in [Telemetry](../features/telemetry.md).

## The turn record

One line per chat turn, written after the reply ends, even when the reader left before it did. Every turn record
has `type`, `v`, `turnId`, `at` (when the question arrived), `tenant`, `pack`, `board` and `datasets`. Every other
field belongs to a field switch, and is left out while that switch is off. The details of each row under What's
recorded on the Telemetry tab list the record fields it switches.

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

- **A conversation** (`sessionId`) continues until 30 minutes pass without a question, the user moves to another board,
  or they start a new chat.
- **`rephraseOf`** names the user's own earlier turn, within 2 minutes, that asked much the same thing. "Much the same"
  means at least 0.6 on the larger of two measures: word overlap, or overlap of three-letter pieces.
- **`reAskAfterVoice`** is set when that earlier turn was spoken.
- **When question text is off**, the comparison uses hashed words, so only word overlap counts.

### Answers left early

A turn is `abandoned` when the reader went away before the reply finished: they closed the page, navigated away or
lost the connection. The server sees the connection close. The panel also sends an `abandoned` event when the page
is hidden while an answer is still coming. There is no stop button yet, so "pressed stop" is not recorded.

## Transcripts

Each transcription is recorded when the speech endpoint returns it, when a field that reads transcripts is on:

- `transcriptId`, `at`, `pack` always; `user` and `roles` with the user name and role names fields;
- `model`, `languageRequested`, `languageDetected`;
- `seconds`, `usd`, `ms`, `retried`;
- `transcript` (with `transcript-text` on), `transcriptHash`, `words`;
- `audio`, which links a kept recording: `{stored: true, bytes, format}`, or `null`.

How a transcript links to its question:

- The endpoint answers with the `transcriptId`. The chat request sends it back, and the turn record links the two, with
  the word edits between them.
- A transcript can be claimed once, and only by the user who spoke it.
- A transcript no question claims within an hour becomes an `abandoned` event with `stage: "after-transcription"`.
- For a client that cannot send the id, the panel can send a `transcript` event with both texts instead.

## Client events

Clients post events to `<api>/_telemetry`. Inside Superset that is `/lenspack/api/_telemetry`. The rules:

- The body is a JSON object of at most 8 KB.
- The caller must be signed in.
- An event about a turn names its `turnId`, and only the user whose turn it was may report on it. The kernel's policy
  decides this (`reportsOn` in `@lenspack/policy`).
- The answer is `202` when the event is accepted, with `recorded: false` when the field it belongs to is off.
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
| `personal-dashboard`, `saved-layout` | sent by the Superset host itself, not the browser: `how` (`create`, `copy`, `delete`; `save`, `apply`, `rename`, `delete`) and `data` with ids and counts only: the dashboard's id (for a copy, also the original's id and how many charts were copied), or the layout's id (for an apply, how many widgets were left out). Kept by the `personal-dashboards` field, which is off whenever the `personalDashboards` switch is (see [Personal dashboards](../features/personal-dashboards.md#usage-telemetry)) |

`data` is a flat map of up to 20 keys with short values. Keys that look like secrets (key, token, password and the
like) are dropped.

The thumbs sit under every answer in the Superset panel and in the demo app. They are labelled for screen readers
and translated into English, French, Portuguese and Hindi.

### For other features: how to add to the record

- **From the page:** `window.lenspackTelemetry.event(type, data)` posts an event about the latest answer. Examples are
  `explain-opened` and `quick-reply`. It does nothing while telemetry is off.
- **From the turn's code:** the turn's hooks (`TurnCapture.mark`) take `{ reuse: tier, reuseSavedUsd }`, `{ clarify:
  true }` and `{ queueMs }`.
- **From the reply stream:**
  - a `data-reuse` part (`{ tier, savedUsd }`) fills `reuse` and `reuseSavedUsd`;
  - a `data-clarify` or `data-quick-replies` part marks the turn `clarify`.
- **Review:** the review feature counts its own runs, proposals and open questions; the checklist reads them from it.
- **A new field** goes in the catalogue (`switchboard.ts` in `@lenspack/agent`) with the record fields it keeps, its
  category and its default. A new event type needs a field there too, or the server answers `400`. The catalogue's
  test checks that each field's switch stops its capture.
- **A new metric** is a widget on the usage pack's `telemetry` board (`packs/usage/boards/telemetry.json` in the
  server package). If it needs a new base measure, add it to `packs/usage/pack.yaml` as a count, sum, distinct count
  or percentile, and leave rates and averages to the widget's compute step. If it reads a new record field, add the
  column to the usage source (`usage-source.ts`); the column's entry there names the record field it comes from, so
  the widget says which switch it needs when that field is off. A metric is never stored.

## The checklist

`GET /_superset/telemetry/checklist` is the Telemetry tab's What's recorded view as data. Besides `generatedAt`, it
has `telemetry` (the switch for telemetry as a whole, and who changed it last), `settings` (retention and the consent
notice) and `categories`. What it tells you is a board; its data comes from the board API (see
[What it tells you](#what-it-tells-you-the-board)).

### What's recorded: `categories`

Seven categories: who and where; what was asked; what happened; cost and speed; feedback; voice; texts. Each has a
`title`, its `rows`, and:

- `state`: `on`, `off` or `mixed`, worked out from the switches inside it. It keeps no value of its own.
- `next`: what clicking its switch does, `true` (turn on every field in it that is not privacy-sensitive), `false`
  (turn every field off), or `null` when there is nothing to do.
- `note`: `sensitive-apart` when some fields in it are privacy-sensitive and so left out of turning the category on,
  `sensitive-only` when every field is.

Each row is one field, and has:

- `label`, and `about` saying what it records;
- `source`: `turn-record`, `client-event`, `transcript`, `audio`, `superset-logs` or `feature`;
- the record `fields` it switches, such as `turn.user` or `event:feedback`;
- `count7d` and `lastSeen`: records from the last 7 days that carry it. Records, not the value of a metric;
- `privacy`, what it means for privacy (for example, that user names are visible to admins with the usage right);
- `usedBy`: the widgets on the What it tells you board that read it (`id` and `label`);
- a `status`, and `howToEnable` when the status is not `recording`;
- its `switch`: `key` (`fields.<field>`), `on`, `default`, `editable`, `sensitive` and `consent` for the confirm step,
  and `changed`. When it can't be changed here: `lock` (`owned`, `feature`, `voice`, `needs-config` or `superset`),
  `reason` in words, and `fix`, where to change it instead (`{"kind": "settings", "feature": …}` or
  `{"kind": "config", "key": "context"}`);
- `offSince` and `offBy`, when someone switched it off (its own switch, its category's or telemetry's).

| status | meaning |
|---|---|
| `recording` | on, and seen in the last 7 days |
| `enabled-no-data` | on, but nothing seen yet |
| `off` | its switch is off, telemetry's is, or the feature that owns it is not present or not on |
| `needs-config` | something is missing. Examples: a country or campaign nobody mapped in `context:`; role names that an older plugin does not sign; Superset's action log outside Superset. |

### What it tells you: the board

`GET /_superset/admin/api/usage/telemetry/data` answers with each widget's data, as for any board: its `rows`, the
`format`, and a comparison when the widget asks one. No row carries the words of a question; a user name only for an
admin with the usage right.

When a widget reads a field that is not recording, its data has no figures, an `error` for any caller that only
reads errors, and a `notice` that a renderer shows instead:

```json
{
  "rows": [],
  "error": "\"user\" can't be answered right now: Needs the User name field, which is switched off.",
  "notice": {
    "text": "Needs the User name field, which is switched off.",
    "action": { "label": "Show the field", "href": "#telemetry/field/user" }
  }
}
```

`action` is absent when nothing on the page can fix it; the link is `#settings` when a feature switch owns the field.
Which fields a widget reads is found from the usage pack: each column a measure, dimension or filter reads, and each
event a measure counts, is matched to the field that fills it.

## Older settings

These still work, as the starting value of a field:

| setting | now |
|---|---|
| `telemetry.questionText`, `LENSPACK_TELEMETRY_QUESTION_TEXT` | `telemetry.fields.question-text` |
| `speech.keepAudio`, `LENSPACK_SPEECH_KEEP_AUDIO` | `telemetry.fields.voice-audio` |
| `telemetry.items.<metric>`, `telemetry.groups.<section>` | `telemetry.fields.<field>`: a field is on when a metric that is on, in a section that is on, used it ([more](../features/telemetry.md#the-older-switch-names)) |

`PUT <prefix>/settings/telemetry` also takes `questionText`, `keepAudio` and `items.<field>` as names for the five
privacy-sensitive fields. It refuses `items.<metric>` and `groups.<section>` with `400`, naming the fields to switch
instead. Changing `keepAudio` through `PUT <prefix>/settings/speech` is refused, with a pointer to the field.

`telemetry.retentionDays` (default 90; also `LENSPACK_TELEMETRY_RETENTION_DAYS` and the Telemetry tab) sets how long
records are kept.

## JSON schema

The three record types share `type` and `v` (the schema version, now 2). Version 2 leaves out the fields whose switches
are off, so only each type's core fields are required. New fields may be added; existing ones do not change
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

**Next:** [Refusal codes](errors.md).

**Related:** [Telemetry](../features/telemetry.md) · [Privacy and data handling](../operating/privacy.md#telemetry) ·
[Stream parts](stream-parts.md)
