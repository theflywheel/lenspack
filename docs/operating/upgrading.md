# Upgrading

This page covers moving a deployment to a new release of Lenspack, and the renames that affect code using its
packages. It is for operators and developers.

## A server deployment

1. Read the [changelog](../../CHANGELOG.md) entries between your version and the new one. Inside Superset, also read
   [Upgrading Lenspack in Superset](../hosts/superset/upgrading.md).
2. Pull the new image (`ghcr.io/theflywheel/lenspack:<commit>`) or rebuild from the repository.
3. Run `lenspack check --config lenspack.yaml` with the new image against your config: a pack or config the new
   release reads differently fails here, with every problem listed, before anyone notices. There is no such check
   for `superset.yaml`: start the new server and read its first log lines. A file it cannot read (bad YAML, or an
   `env:` variable that is not set) stops it with the reason, and anything it left out of a dataset is a warning
   line. A misspelt key is not reported, so check renamed keys against the
   [configuration reference](../reference/config.md#supersetyaml).
4. Restart. The state directory carries over. What a restart loses is in
   [What survives a restart](state.md#what-survives-a-restart).

A pack's `version` is recorded on the boards built against it. Bump it when you change keys.

## KPIs saved with `aggregate`

Boards saved by older releases carry an `aggregate` field on a KPI: how the renderer used to fold a series into one
number. Lenspack reads it when the board loads and never saves it again. Nothing needs doing by hand:

| saved `aggregate` | read as |
|---|---|
| none, or `last` | dropped: the KPI shows the series' latest bucket, as before |
| `sum`, `avg`, `max`, `min`, on a series | a `value` over the same window and filters, with `compute: { grain: <the series' grain>, steps: [<its steps>, { op: "over_time", fn }] }` (`avg` becomes `mean`) |
| anything else | dropped, and the KPI shows the series' latest bucket |

"Anything else" is `count` (how many buckets came back, which no step gives), a series split by a dimension (the old
fold added every split's buckets together), a series that already has four steps, and any value on a `value` query,
where the field never did anything. A summary read this way obeys the [compute step's
rules](../features/compute.md#how-zeros-and-gaps-are-treated): a percentage or an average is not added up, so such a
`sum` is refused on the widget, with a way forward, instead of showing a wrong number.

## Telemetry switches by field

Telemetry used to be switched by metric (`telemetry.items.<metric>`) and by section of metrics
(`telemetry.groups.<section>`). It is now switched by field: the facts a record carries, such as the user name, the
cost or the answer time (`telemetry.fields.<field>`). Metrics are no longer switched or listed one by one: they are
figures on a board over the usage pack, worked out from the records, in the Telemetry tab's What it tells you.

**Nothing needs doing by hand.** Older names in the config and in the settings an admin saved are still read, with
the rule they always followed: a field is recorded when some metric that is on, in a section that is on, used it. So
the same fields are recorded after the upgrade as before. For example, a deployment that switched the speed section
off now has the answer time, wait for a free slot and answers left early fields off. The five privacy-sensitive items
kept their names: `items.question-text` is `fields.question-text`, and the same for `transcript-text`, `voice-audio`,
`device-class` and `device-network`.

To move to the new names, list the fields you want off under `telemetry.fields:` (every key and its default is in
[Telemetry](../features/telemetry.md#the-switchboard)) and remove `items` and `groups`. A field set under `fields:`
wins over an older name.

What changes for scripts:

- `PUT <prefix>/settings/telemetry` takes `fields.<field>` and `categories.<category>`. It refuses `items.<metric>`
  and `groups.<section>` with `400`, and the message names the fields to switch instead. `items.<field>` for the five
  privacy-sensitive fields, `questionText` and `keepAudio` still work.
- `GET <prefix>/telemetry/checklist` answers with `categories` (the fields), instead of `groups`. See
  [the checklist](../reference/telemetry-records.md#the-checklist). The figures are on the usage board API, at
  `<prefix>/admin/api/usage/telemetry/data`.
- `GET <prefix>/telemetry` lists the fields that are on as `fields`, instead of `items`.
- In `@lenspack/agent`, the switchboard exports `FIELD_GROUPS` and `FIELD_CATEGORIES` instead of `TELEMETRY_ITEMS`
  and `TELEMETRY_GROUPS`, and `turnTelemetry` takes `fields` instead of `items`. The older metric and section names
  are kept only to translate older settings, as `LEGACY_ITEMS` and `LEGACY_SECTIONS`.

## Code using the packages

**Unreleased** (see the [changelog](../../CHANGELOG.md)): the pack loader `@lenspack/spec` is now `@lenspack/pack`
(published as `@theflywheel/lenspack-pack`).
Its exports are unchanged; change the import path and the dependency name.

The packages now sit in folders by job (`packages/kernel`, `sources`, `packs`, `hosts`; see
[Architecture overview](../architecture/README.md#how-the-code-is-laid-out)), which changes no package name. The image
keeps links at the old paths `packages/serve` and `packages/superset`.

Installing from GitHub Packages is in [Packages](../reference/packages.md#installing-from-github-packages).

---

**Next:** [Troubleshooting](troubleshooting.md).

**Related:** [Deploying](deploying.md) · [Upgrading in Superset](../hosts/superset/upgrading.md)
