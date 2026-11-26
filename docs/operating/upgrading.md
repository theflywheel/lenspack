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

## Code using the packages

**From 0.1.0:** the pack loader `@lenspack/spec` is now `@lenspack/pack` (published as `@theflywheel/lenspack-pack`).
Its exports are unchanged; change the import path and the dependency name.

The packages now sit in folders by job (`packages/kernel`, `sources`, `packs`, `hosts`; see
[Architecture overview](../architecture/README.md#how-the-code-is-laid-out)), which changes no package name. The image
keeps links at the old paths `packages/serve` and `packages/superset`.

Installing from GitHub Packages is in [Packages](../reference/packages.md#installing-from-github-packages).

---

**Next:** [Troubleshooting](troubleshooting.md).

**Related:** [Deploying](deploying.md) · [Upgrading in Superset](../hosts/superset/upgrading.md)
