# What Lenspack keeps on disk

This page lists everything Lenspack writes to disk, where, and what survives a restart. It is for operators planning
volumes, backups and replicas.

## The state directory

**Inside Superset**, the state directory is the folder of `state:` (by default `superset-boards.json` in
`LENSPACK_STATE_DIR`, which is `/data` in the image, else `state/`). Everything below lives there.

**In the standalone server**, it is the folder named by `state:` in `lenspack.yaml`. Without it there is no admin panel
and no settings page; switches come from the config and the environment only. The password sign-in keeps its own
files in `auth.dir` (default `LENSPACK_STATE_DIR`, else `.lenspack` next to `lenspack.yaml`).

## The files

| file | what | host |
|---|---|---|
| `superset-boards.json` | the links between Lenspack's boards and Superset's dashboards and charts | Superset |
| `superset-account.json` | Lenspack's own Superset account password (mode 600) | Superset |
| `usage.jsonl` | one line per model call (who, which model, tokens, cost), so today's spend and budget survive a restart; only its last 32 MB is read at start, and nothing deletes old lines, so trim it now and then if it grows | Superset |
| `personal-dashboards.json`, `saved-layouts.json` | which dashboards are someone's own, and people's saved layouts (see [Personal dashboards](../features/personal-dashboards.md#where-it-is-kept)) | Superset |
| `settings.json` | switches, voice, language, saved-answer and queue settings, personal-dashboard limits, the edit scope, the assistant's name, and the review's settings, as set by an admin | both |
| `pack-layer.json` | changes admins made to the pack while the server ran, every version with who, when and why (mode 600; see [Changing the pack while it runs](../hosts/superset/pack-runtime.md)) | Superset |
| `definitions-<pack>.json` | the admins' definitions and their history | both |
| `open-questions-<pack>.json` | the open-questions log | both |
| `review-proposals.json` | the daily review's proposals and what became of them | both |
| `review-runs/<id>.json` | each review run's report (the last 90) | both |
| `review-state.json` | the last scheduled review time handled | both |
| `usage.duckdb` | the usage board's tables and its versions | both |
| `reuse.json` | saved answers and board edit counts (the `cache:` block's `file`, if set) | both |
| `audit.jsonl`, `audit-YYYY-MM.jsonl` | the audit log, by month, kept 90 days (with `state:` set and no `audit:` file) | both |
| `admin-password.hash`, `admin-password.txt`, `session.key` | the password sign-in's files (in `auth.dir`) | standalone |
| `<pack>.proposals.json` | measures the model proposed, unverified (beside `lenspack.yaml`, or in the `proposals:` folder) | standalone |

Files named in the config sit where the config says: `usage:` (one line per model call; see
[Costs](costs.md#where-calls-go)) and `audit:` (one line per change, refusal and turn).

Telemetry adds `telemetry.jsonl` (by month), `telemetry-state.json` and `telemetry.key`; see
[Telemetry](../features/telemetry.md).

## How the files are written

Everything except the usage tables sits behind a small document store: each file is one named document, read fresh on
every use and written only if it has not changed since it was read. Files are written whole (a temporary file renamed
into place), so a crash never leaves half a file. An unreadable board-state file is set aside as
`*.unreadable-<time>` instead of stopping the server. The password sign-in refuses a folder that is a link or writable
by everyone, and a file that is a link, belongs to another user or is writable by others.

When the folder cannot be written (a full disk, a read-only mount), Lenspack keeps answering: settings writes fail
with `503` and change nothing, and Superset board links are kept in memory until a save works again.

## What survives a restart

| what | survives? |
|---|---|
| boards and versions in a DuckDB or Postgres store | yes |
| boards in the in-memory store (`store:` left out) | **no** |
| Superset dashboards and charts | yes (Superset keeps them) |
| Lenspack's version history of Superset dashboards (the undo list) | **no**: kept in memory today; planned to move to a database |
| links between widgets and Superset charts | yes (`superset-boards.json`) |
| settings and switches an admin set | yes (`settings.json`) |
| changes to the pack made while the server ran | yes (`pack-layer.json`), laid over the deploy config's overlay at start |
| definitions, open questions, review runs and proposals | yes |
| saved answers | yes (`reuse.json`) |
| the queue and anyone waiting in it | **no**: waiting turns are dropped |
| usage totals and the day's budget | standalone: yes with `usage:` set (read back at start), otherwise they start from zero; inside Superset: yes (`usage.jsonl` in the state directory) |
| usage figures inside Superset (`GET /api/_usage`) | today's, yes (read back from `usage.jsonl`) |
| the audit log | yes |
| sign-in sessions | yes under the password and OpenID Connect sign-ins (signed cookies), as long as the session key or `sessionSecret` is unchanged |
| a turn that was running | **no** |
| the daily review's schedule | yes; a run missed while down runs once on start |

## Backups

Back up the state directory and any `usage:` and `audit:` files. Board stores in Postgres or DuckDB are backed up as
databases. Inside Superset, Superset's own database holds the dashboards.

---

**Next:** [Privacy and data handling](privacy.md).

**Related:** [Stores, and running several copies](../architecture/stores.md) · [Deploying](deploying.md)
