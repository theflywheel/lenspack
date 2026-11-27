# Question limits

This page explains how to limit how many questions each person may ask the assistant: a number per day, and a
number per minute and per hour. It is for admins setting up a deployment.

Limits are **off by default**. With none set, everyone may ask as much as they like, as before.

## What each limit does

| setting | what it limits | resets |
|---|---|---|
| `questionsPerDay` | questions answered by the model, per person, per day | at midnight UTC, like the [daily spend caps](../operating/costs.md#a-budget) |
| `perMinute` | questions per person in any 60 seconds | as each question becomes a minute old |
| `perHour` | questions per person in any 60 minutes | as each question becomes an hour old |
| `adminsExempt` | `true`: admins are never refused (they are still counted). Default `false`: admins are held to the limits like everyone else | |
| `users` | higher (or lower) limits for named people: `{ "<user name>": { questionsPerDay: 500 } }`; a field left out uses everyone's | |

`0` means no limit for that setting.

The minute and hour limits are rolling windows. "5 a minute" means at most 5 questions in any 60 seconds. A person
can ask several questions in a row, but a script or a stuck page that keeps sending is stopped within a minute.

## What the person sees

Over a limit, the question is refused **before the model is called and before any data is read**. The chat answers
with HTTP `429`, a `Retry-After` header (in seconds), and a short message saying which limit was reached and when
they can ask again, in the language of the chat (English, French, Hindi or Portuguese):

> You have asked 5 questions in the last minute, the most allowed per person. You can ask again in 40 seconds.

The chat panel shows that message under the conversation and puts the question back in the box, so it can be sent
again later. The JSON body also says `code: "limit"`, which limit (`limit`), its value (`max`), `retryAfterSeconds`
and `freeAt`, for other clients.

## What counts

- **A question answered from a saved answer** counts toward the minute and hour limits, but not toward the daily
  limit: it uses no model. Once the daily limit is used up, saved answers are refused too, because finding a saved
  answer can itself need a small model call.
- **A question turned away because the server is busy** (the [queue](busy-hours.md) is full) counts toward the minute
  and hour limits, but not toward the daily limit.
- **A refused question** does not count. It is written to the audit log (`action: chat`, `outcome: denied`,
  `detail: "limit: perMinute (5); free in 40 s"`), with the person's name.
- **Asking again after a reply was cut off** (the panel's Retry, with the same question key) is the same question, and
  does not count again.
- **The admin pages and the admin API** never count: they are not questions.

## Where the counts are kept

- Today's counts are kept in `limits.json` in the [state folder](../operating/state.md), readable only by the
  server's own user (file mode 600). A restart does not reset them. Without a state folder (`lenspack serve` with no
  `state:`), they are kept in memory only.
- The minute and hour windows are kept in memory. A restart forgets them, so after a restart a person may ask up to
  one window's worth again.
- With several copies of the server behind a load balancer, each copy counts on its own.

## Setting the limits

In `superset.yaml` (or `lenspack.yaml`):

```yaml
limits:
  perUser:
    questionsPerDay: 200
    perMinute: 5
    perHour: 60
    adminsExempt: false
```

Or with environment variables, which win over the file: `LENSPACK_LIMIT_QUESTIONS_PER_DAY`,
`LENSPACK_LIMIT_PER_MINUTE`, `LENSPACK_LIMIT_PER_HOUR` and `LENSPACK_LIMIT_ADMINS_EXEMPT` (`true` or `false`).

An admin's change on that card, or through the settings API, wins over both, and applies to the next question:
`PUT /_superset/settings/limits` with any of the settings above; `null` puts one back to the deployment's value.
`GET /_superset/settings` shows them under `limits`, with the deployment's values and where the current ones came
from. See [Superset settings](../hosts/superset/settings.md#the-routes-behind-it).

The start-up log says what is in force, for example:

```
limits per person: 200 questions a day (UTC), 60 an hour, 5 a minute; admins not exempt; today's counts in /data/limits.json
```

## Who reached a limit

On the admin pages, the **Settings** tab has a **Question limits per person** card: everyone's limits, whether admins
are held to them, other limits for named people, and a table of everyone counted today (UTC), with those at a limit
or refused first and a **Reset** button for each.

`GET /_superset/limits` lists who is at a limit now or was refused today, with their counts for today and the last
minute and hour. `?all=1` lists everyone counted today. `DELETE /_superset/limits?user=<name>` sets one person's
counts for today back to zero; the audit log records who did it. The API's usage report (`GET /api/_usage`, for those
with the usage right) includes the same list while limits are on.

## Limits and the spend caps

The [daily spend caps](../operating/costs.md#a-budget) (`budget: { usdPerDay, usdPerUserPerDay }`) limit money, for the
whole server and per person. Question limits limit how often each person asks. They work together: whichever is
reached first refuses the question.

## How it is built

Whether a question may go ahead is decided in `@lenspack/policy` (`decideQuestion`), from the person's counts and the
settings. The server keeps the counts and asks it before every question.

---

**Related:** [Busy hours](busy-hours.md) · [Costs](../operating/costs.md) · [Superset settings](../hosts/superset/settings.md)
