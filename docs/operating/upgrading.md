# Upgrading

This page covers moving a deployment to a new release of Lenspack, and the renames that affect code using its
packages. It is for operators and developers.

## A server deployment

1. Read the changes between your version and the new one. Inside Superset, also read
   [Upgrading Lenspack in Superset](../hosts/superset/upgrading.md).
2. Pull the new image (`ghcr.io/theflywheel/lenspack:<commit>`) or rebuild from the repository.
3. Run `lenspack check --config lenspack.yaml` with the new image against your config: a pack or config the new
   release reads differently fails here, with every problem listed, before anyone notices.
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
where the field never did anything. A summary read this way obeys the [compute step's rules](../features/compute.md#how-zeros-and-gaps-are-treated): a percentage or an average is not
added up, so such a `sum` is refused on the widget, with a way forward, instead of showing a wrong number.

## Code using the packages

**After 0.1.0** (on the main branch since 24 November 2026; no version has been tagged since 0.1.0): the pack
loader `@lenspack/spec` is now `@lenspack/pack` (published as `@theflywheel/lenspack-pack`).
Its exports are unchanged; change the import path and the dependency name.

The packages now sit in folders by job (`packages/kernel`, `sources`, `packs`, `hosts`; see
[Architecture overview](../architecture/README.md#how-the-code-is-laid-out)), which changes no package name. The image
keeps links at the old paths `packages/serve` and `packages/superset`.

Installing from GitHub Packages is in [Packages](../reference/packages.md#installing-from-github-packages).

---

**Next:** [Troubleshooting](troubleshooting.md).

**Related:** [Deploying](deploying.md) · [Upgrading in Superset](../hosts/superset/upgrading.md)
