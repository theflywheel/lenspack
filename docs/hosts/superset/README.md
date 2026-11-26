# Lenspack in Superset

This page explains what Lenspack does inside Apache Superset and maps the pages that follow. It is for Superset
admins deciding whether to add it, and for anyone running it.

Lenspack adds an **Ask Lenspack** button and a chat panel to Superset's dashboards, without forking Superset. People
ask questions about the dashboard they are on and, if Superset lets them edit it, change it by asking. Every number
comes from Superset itself, through Superset's own metrics, and every change is saved as an ordinary Superset
dashboard and chart.

## How it fits

```
browser ──► Superset ──/lenspack/…──► Lenspack server ──/api/v1/chart/data──► Superset ──► your database
            (plugin signs              (pack from datasets,
             who is asking)              boards = dashboards)
```

- **One Python file in Superset** (the plugin) adds the button, a settings page, a few small API routes, and a
  route at `/lenspack/...` that forwards to the Lenspack server with a signed header naming the user. Browsers never
  reach the Lenspack server directly.
- **The Lenspack server** (`lenspack superset`, port 8795) builds a pack from the datasets you list, reads numbers
  through Superset's chart-data API, keeps boards in step with dashboards, and runs the chat.

Superset 6.1 is the version it is built for, and 5.0 is tested the same way. See [Versions](versions.md).

## What it does

- **The catalogue comes from Superset.** A dataset becomes an entity, its saved metrics become measures and its
  columns become dimensions. You add what Superset has no field for (instructions, examples, hierarchies).
- **Numbers come from Superset**, so a metric means the same in the chat as on the dashboard.
- **Dashboards are boards.** Charts become widgets, the filter bar becomes the board's filters, and every change
  Lenspack makes is sent to Superset before it counts.
- **Each person sees what Superset lets them see**: their dataset access, row-level security and dashboard rights.
  See [Access inside Superset](../../access/superset.md).

## The pages

1. [Install](install.md): the plugin, the server, and their settings.
2. [Datasets and dashboards](datasets-and-dashboards.md): how the pack and boards are built from Superset.
3. [Computed charts](computed-charts.md): how rates and changes are saved as Superset charts.
4. [Who is asking](identity.md): the signed identity, edit rights, Lenspack's own account and the audit log.
5. [Settings and switches](settings.md): the settings page, voice and language settings, switches, and what
   happens when storage fails.
6. [Versions](versions.md): Superset 6.1 and 5.0, the content security policy, and ClickHouse.
7. [Upgrading](upgrading.md): updating the plugin and server, and what changed.

---

**Next:** [Install](install.md).

**Related:** [Access inside Superset](../../access/superset.md) · [Choose a host](../README.md)
