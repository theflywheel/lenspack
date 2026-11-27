# Operating Lenspack

This page maps the pages for running Lenspack in production: configuring it, choosing models, controlling cost,
deploying, upgrading, privacy and fixing problems. It is for operators.

| page | covers |
|---|---|
| [Configuration](configuration.md) | the config files, `env:` references, the environment, and what wins over what |
| [Chat models](models.md) | providers, roles in a turn, and the two adapters |
| [Query safety](query-safety.md) | the limits on the queries Lenspack sends, heavy datasets, and limits to set on the database user |
| [Costs and budgets](costs.md) | metering, the usage ledger and file, daily caps, prompt caching |
| [Feature switches](switches.md) | every switch, its default, and where it can be set |
| [Deploying](deploying.md) | the Docker image, ports, volumes, health checks, several copies |
| [What Lenspack keeps on disk](state.md) | the state directory, every file in it, and what survives a restart |
| [Privacy and data handling](privacy.md) | what is stored, who can read it, how long it is kept |
| [Upgrading](upgrading.md) | moving to a new release, and package renames |
| [Troubleshooting](troubleshooting.md) | common problems and what to check |

Before letting other people use a deployment, check three things: a sign-in that names people (see
[Sign-in](../access/sign-in.md)), a daily budget (see [Costs](costs.md#a-budget)), and a read-only database role for
every source (see [SQL databases](../sources/sql.md#the-guards-belong-to-the-driver)).

---

**Next:** [Configuration](configuration.md).

**Related:** [Choose a host](../hosts/README.md) · [Configuration reference](../reference/config.md)
