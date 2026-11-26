# Privacy and data handling

This page says what Lenspack sends to model providers, what it stores about the people who use it, who can read it,
and how long it is kept. It is for whoever answers privacy questions about a deployment.

## What goes to the model provider

On each chat turn, the provider receives:

- the pack's catalogue as the person may see it (keys, labels, hints, synonyms), its instructions and examples, and
  the admins' definitions;
- the current board (widget titles, queries, filters);
- the conversation (the recent turns, 8 by default);
- **the rows the assistant's tools read**, so it can write its reply. These are aggregates (counts, sums, groups) or,
  for a rows query, the records asked for, never more than the query's limit.

A key hidden from a person is left out of all of this. The provider never receives table names it could misuse, SQL
fragments, database addresses or credentials. Errors are passed on with URLs, hosts, ports and IP addresses taken
out. The daily review sends the period's turns with users named u1, u2 and so on.

**Voice:** the audio clip goes to the transcription provider and is not kept by Lenspack.

Choose a provider whose terms suit your data, and keep pack instructions, hints and examples free of real values:
everyone who may open the pack sees them, and the model receives them on every turn.

## What Lenspack stores

| record | holds | who can read it | kept |
|---|---|---|---|
| audit log | each change, refusal, denied request and chat turn, with the user, the question, the answer, the tool calls, "How this was worked out" (bounded to about 32 KB a turn, credentials masked) and the cost | admins | 90 days by month (`audit.retentionDays`); `audit: false` turns it off |
| usage file (`usage:`) | one line per model call: user, pack, board, role, tokens, cost | whoever has the usage right | until you delete it |
| saved answers | the question, its plan, the reply and the rows it was written from, tied to an access fingerprint | admins (Cache tab) | `ttlHours` (one week by default), unless pinned |
| open questions and review runs | questions people asked, with readings; the daily review's report | admins | review runs: the last 90 |
| boards and versions | who changed what, when | per board rights | as long as the board |

Names on the usage board and in review reports are shown only to admins who also hold the usage right; others see the
same figures with the user, question text and session hidden. The browser keeps each answer's "How this was worked
out" beside the conversation in the tab; it is never sent back to the server.

## Telemetry

Telemetry keeps one record per turn, per transcription and per client event, each field switched on its own. Question
words, transcript words, recordings and device detail start off and ask an admin to confirm. Records are kept 90
days. What is recorded, and the switches, are in [Telemetry](../features/telemetry.md).

### Privacy notes

- **User names** are recorded while the user items are on, because each deployment wants to know who uses its tool. Only
  readers the policy allows see them as written. With them off, records carry no name, and feedback on a finished answer
  still works for the hour the turn stays open.
- **Question text** is off by default. Then each question is kept only as a keyed hash:
  - equal questions share a hash, so repeats can still be counted;
  - nobody without the key can test a guess against it;
  - working state keeps only hashed words.
- **The browser** reports only classes, and only with the device items on: phone, tablet or desktop; a network type;
  narrow, medium or wide. Never its user agent.
- **Secrets never reach a record.** Event data whose key looks like a secret is dropped, and no record holds a
  connection string or key.
- **Audio** is not kept unless switched on (below).
- **Switching off deletes nothing.** Records age out with their month; kept recordings can be deleted per user or all at
  once.

### Kept recordings

**Off by default.** Kept recordings are the `voice-audio` field on the Telemetry tab; turning it on shows the
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
| deletion | `DELETE /_superset/audio/<transcriptId>`, `DELETE /_superset/audio?user=<name>`, `DELETE /_superset/audio?all=1`. Each deletion is audited. Turning the field off keeps what is stored; the settings page has a "delete stored audio" action. |
| export | `POST /_superset/audio/export` writes `audio/manifest.jsonl` in the speech benchmark's format (`id`, `set`, `lang`, `speaker`, `audio`, `ref`, `seconds`). The reference is the question as sent: the transcript itself when unchanged, the user's correction when edited. These go to `manifest-flagged.jsonl` instead: edits that changed most of the words (more than 40%, or the length by half), clips never sent, questions spoken in several clips, and clips whose text is not kept. Speakers are keyed hashes, not names. |

How long, how much and the consent notice can be changed in four places:

- the settings page;
- the config: `speech.audioRetentionDays`, `speech.maxStoredMb`, `speech.consentNotice`;
- the environment: `LENSPACK_SPEECH_AUDIO_RETENTION_DAYS`, `LENSPACK_SPEECH_MAX_STORED_MB`,
  `LENSPACK_SPEECH_CONSENT_NOTICE`;
- the admin route `PUT /_superset/settings/speech`.

Recordings sit behind their own storage interface (`AudioStore`). Object storage could serve several copies of
Lenspack through the same methods.

## What is never stored

Passwords (only a scrypt hash of the built-in admin's), model keys, database credentials, and the browser's user agent.

## The data itself

Lenspack never copies your data into its own store. It reads it through the source, read-only, for each query. Saved
answers keep the rows a reply was written from, under the access they were read with, and run the queries again for
fresh numbers. The usage board reads only Lenspack's own records, copied into a separate in-process database; it
cannot reach the deployment's data.

---

**Next:** [Upgrading](upgrading.md).

**Related:** [How this was worked out](../features/explain.md) · [What Lenspack keeps on disk](state.md) ·
[Why the model cannot break things](../architecture/safety.md)
