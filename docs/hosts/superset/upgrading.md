# Upgrading Lenspack in Superset

This page lists the steps to upgrade Lenspack inside Superset, and the changes that need your attention when you
do. It is for whoever runs Superset. Upgrading Superset itself between 5.0 and 6.1 is covered in
[Versions](versions.md).

## The steps

1. **Read the changes below** for anything between your version and the new one.
2. **Update the plugin file** (`lenspack_superset.py`) on Superset's Python path, and restart Superset. The plugin
   and the server are released together; a newer server keeps working with an older plugin, but features that need
   the plugin stay off (each is listed below).
3. **Update the Lenspack server's image** and restart it. The state directory carries over: board links, settings,
   saved answers, definitions, open questions and the audit log.
4. **Check the log** for Superset's version line and any warnings about datasets, and open a dashboard.

What a restart loses is listed in [What Lenspack keeps on disk](../../operating/state.md#what-survives-a-restart):
inside Superset, mainly Lenspack's own version history (the undo list). Superset's dashboards are never affected.

## Changes that need attention

**Each person's Superset access is now the default (`hostPolicy: superset`).** Earlier releases defaulted to
`hostPolicy: off`, which answered everyone with Lenspack's service account. A deployment that left `hostPolicy`
unset applies each user's Superset access when it upgrades: users without access to a dataset stop seeing its
numbers through the chat, and row-level security narrows their answers. Check your Superset roles before upgrading,
or set `hostPolicy: off` to keep the old behaviour while you do. Lenspack warns at every start while it is off. See
[Access inside Superset](../../access/superset.md).

**Dashboard roles need the new plugin.** With `DASHBOARD_RBAC` on, a person who opens a dashboard through its
dashboard roles can ask about that dashboard's data only with a plugin that reports dashboard grants. With an older
plugin, a dashboard role opens the dashboard but none of its data in the chat.

**Older plugins and the access route.** Without the plugin's `/api/v1/lenspack/access` route, the server reads
row-level security rules from Superset's REST API and matches them to the roles in the identity header. That route
cannot read dataset permissions or dashboard access, or render templates: every dataset counts as readable, a
templated clause keeps its dataset from the user, and only the dashboard a request is about is listed. Update the
plugin.

**Board and pack in the signed identity.** A plugin from before the identity carried the board and pack (`b`, `p`)
signs only the dashboard id; the server then checks `superset-<id>` against its route. Update the plugin.

**Superset 6.1 and ClickHouse.** Superset 6.1 needs `clickhouse-connect` 0.13 or later, and the plugin's column-name
fix. See [Versions](versions.md#clickhouse-column-names-on-superset-61).

---

**Next:** [The standalone server](../serve.md).

**Related:** [Upgrading](../../operating/upgrading.md) · [Versions](versions.md)
