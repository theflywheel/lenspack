# Features

This page lists everything Lenspack does for the people who use it, one page per feature, with which hosts have it
and whether it is released. It is for anyone deciding whether Lenspack fits, and for admins turning features on
and off.

Every feature listed here is on the main branch. No version has been released since 0.1.0, so what changed lately is in
the [changelog](../../CHANGELOG.md). Features still in review get their pages when they merge.

## Answering

| feature | what it does | hosts |
|---|---|---|
| [Answering questions](answering.md) | Ask in words; get numbers from the pack's measures, in the language you asked in. | all |
| [The compute step](compute.md) | Rates, changes, rolling averages and summaries per group, worked out on the source's answer. | all |
| [How this was worked out](explain.md) | Under each answer: each data call in plain words, its SQL and its rows. | Superset, standalone |
| [Saved answers](saved-answers.md) | A repeated question is answered again on fresh data, without the model. | Superset, standalone |
| [Busy hours](busy-hours.md) | A queue with a place in line, retries on rate limits, one change at a time per board. | Superset, standalone |

## Changing dashboards

| feature | what it does | hosts |
|---|---|---|
| [Dashboard edits, versions and undo](dashboard-edits.md) | Change a board by asking; a reviewer checks each change; every change is a version you can restore. | all |
| [Charts, maps and heatmaps](charts.md) | KPIs, bar, line, area and pie charts, tables, text, heatmaps and point maps. | all |
| [Personal dashboards and saved layouts](personal-dashboards.md) | Your own copy of a dashboard to change, and layouts kept by name. | Superset |

## Keeping answers right

| feature | what it does | hosts |
|---|---|---|
| [Open questions and definitions](open-questions.md) | Find questions with two readings, settle them, and review the day's use. | Superset, standalone |
| [The admin panel](admin-panel.md) | Usage as a board, open questions, definitions, saved answers and every switch. | Superset, standalone |
| [Telemetry](telemetry.md) | One record per turn, feedback, and a switch for each item recorded. | Superset, standalone |

## Talking to it

| feature | what it does | hosts |
|---|---|---|
| [Voice](voice.md) | A mic in the chat, with transcription checked before it is sent. | Superset |
| [Languages](languages.md) | English, French, Hindi and Portuguese for the panel; replies in any language. | Superset (panel); all (replies) |

## Turning features off

Most of these can be turned off, per deployment, from the admin panel or the config. See
[Feature switches](../operating/switches.md).

---

**Next:** [Answering questions](answering.md).

**Related:** [Offerings](../introduction/offerings.md) · [Feature switches](../operating/switches.md)
