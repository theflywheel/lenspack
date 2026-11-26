# Feature switches

This page lists every switch that turns a part of Lenspack on or off, its default, and where it can be set. It is for
operators and admins.

## Where a switch is set

A switch's value comes from, lowest first: the default, `features:` in the config, `LENSPACK_FEATURES`, then an admin
on the settings page (the admin panel's Settings tab, or Superset's AI assistant page). The page can turn a switch the
environment set back on; `null` (or **Reset**) hands it back to the environment.

```yaml
features: { voice: false, reviewer: false }      # in lenspack.yaml or superset.yaml
```
```sh
LENSPACK_FEATURES="voice=off,maps=on"             # or "-voice,+maps", or a JSON object
```

In the standalone server, the settings page needs a `state:` directory; without one, switches come from the config
and the environment only.

## The switches

All are on by default except the daily review, which costs money.

| switch | label | off means | enforced by |
|---|---|---|---|
| `overlay` | Ask Lenspack button | no button or chat panel on any Superset dashboard | the page |
| `voice` | Voice input | no mic; `/api/_stt` answers 503 | the server (the key is withheld) |
| `spaceHold` | Hold Space to talk | holding Space does not talk; the mic button still does | the page |
| `languageMenu` | Language menu | no language picker; the deployment's default language applies, and a pick saved earlier is ignored | the page |
| `markdown` | Formatted replies | replies as plain text | the page |
| `inPlaceRefresh` | Refresh in place | after a change the page reloads instead of redrawing the dashboard | the page |
| `newChat` | New chat button | no New chat button | the page |
| `boardEdits` | Dashboard edits | the chat answers questions only, for everyone, admins included; edit tools say edits are turned off | the server |
| `heatmap` | Heatmaps | new heatmaps are refused (existing ones stay) | the server |
| `maps` | Maps | map queries are refused (existing map charts stay in Superset) | the server |
| `reviewer` | Reviewer | no second model call checking each change: edits are saved as they are made, and a wrong one is not caught before the reply | the server |
| `turnCost` | Cost per answer | no cost line under each reply and no running total in the chat menu; the audit log still records each turn's cost | the page |
| `cache` | Saved answers | every question goes to the model, even one answered a minute ago (see [Saved answers](../features/saved-answers.md)) | the server |
| `explain` | How this was worked out | no explanation under answers, and none in the audit log; `explain: { sql: false }` in the config keeps it without the SQL (see [How this was worked out](../features/explain.md)) | the server |
| `clarify` | Clarify intent | the assistant never asks which reading is meant and logs no open questions | the server |
| `review.daily` | Daily review | (off by default) no daily review of the day's questions | the server |
| `review.compare` | Compare readings | open questions' readings are not run on the data after a review | the server |

| `telemetry` | Telemetry | no usage records, no thumbs under answers; `/api/_telemetry` answers 404 (see [Telemetry](../features/telemetry.md)) | the server |

> **Coming soon.** A `personalDashboards` switch. See [Personal dashboards](../features/personal-dashboards.md).

## Reading them

`GET /_superset/settings` (inside Superset) and the admin panel's settings route return `features: {values, defaults,
source, options, writable}`: `defaults` is what the deployment says without the admin, `source` is `default`, `config`,
`env` or `settings` per switch, and `options` gives each switch's label and help text. `/_superset/info` returns the
effective values for the chat panel. A page holding an old copy picks up a change on its next dashboard load.

---

**Next:** [Deploying](deploying.md).

**Related:** [Configuration](configuration.md) · [Settings and switches in Superset](../hosts/superset/settings.md) ·
[The admin panel](../features/admin-panel.md)
