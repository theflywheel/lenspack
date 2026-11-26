# Features

This page lists everything Lenspack does for the people who use it, one page per feature, with which hosts have it
and whether it is released. It is for anyone deciding whether Lenspack fits, and for admins turning features on
and off.

**Status:** *Released* is on the main branch. *Coming soon* is built and in review. *Planned* is designed, not built.

## Answering

| feature | what it does | hosts | status |
|---|---|---|---|
| [Answering questions](answering.md) | Ask in words; get numbers from the pack's measures, in the language you asked in. | all | Released |
| [The compute step](compute.md) | Rates, changes, rolling averages and summaries per group, worked out on the source's answer. | all | Released |
| [How this was worked out](explain.md) | Under each answer: each data call in plain words, its SQL and its rows. | Superset, standalone | Released |
| [Saved answers](saved-answers.md) | A repeated question is answered again on fresh data, without the model. | Superset, standalone | Released |
| [Busy hours](busy-hours.md) | A queue with a place in line, retries on rate limits, one change at a time per board. | Superset, standalone | Released |

## Changing dashboards

| feature | what it does | hosts | status |
|---|---|---|---|
| [Dashboard edits, versions and undo](dashboard-edits.md) | Change a board by asking; a reviewer checks each change; every change is a version you can restore. | all | Released |
| [Charts, maps and heatmaps](charts.md) | KPIs, bar, line, area and pie charts, tables, text, heatmaps and point maps. | all | Released |
| [Personal dashboards and saved layouts](personal-dashboards.md) | Your own copy of a dashboard, and a layout you keep. | Superset | Coming soon |

## Keeping answers right

| feature | what it does | hosts | status |
|---|---|---|---|
| [Daily review, open questions and definitions](review.md) | Find questions with two readings, settle them, and review the day's use. | Superset, standalone | Released |
| [The admin panel](admin-panel.md) | Usage as a board, open questions, definitions, saved answers and every switch. | Superset, standalone | Released |
| [Telemetry](telemetry.md) | One record per turn, feedback, and a switch for each item recorded. | Superset, standalone | Released |

## Talking to it

| feature | what it does | hosts | status |
|---|---|---|---|
| [Voice](voice.md) | A mic in the chat, with transcription checked before it is sent. | Superset | Released |
| [Languages](languages.md) | English, French, Hindi and Portuguese for the panel; replies in any language. | Superset (panel); all (replies) | Released |
| [Naming the assistant](naming.md) | Call it by your deployment's own name. | Superset, standalone | Coming soon |

## Turning features off

Most of these can be turned off, per deployment, from the admin panel or the config. See
[Feature switches](../operating/switches.md).

---

**Next:** [Answering questions](answering.md).

**Related:** [Offerings](../introduction/offerings.md) · [Feature switches](../operating/switches.md)
