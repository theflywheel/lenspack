# Configuration

This page explains how Lenspack is configured: the two config files, secrets as `env:` references, the environment
variables, and which source wins when several set the same thing. It is for operators. Every key with its default is
in the [Configuration reference](../reference/config.md).

## Two config files, one per host

| host | file | describes |
|---|---|---|
| standalone server | `lenspack.yaml` | sources, packs, the board store, sign-in, state, audit, usage, budget, saved answers, switches |
| Superset | `superset.yaml` | Superset's address, the datasets, the overlay, edit and access policy, state, budget, voice, languages, switches |

Both are YAML (or JSON). Relative paths are read from the config file's folder.

## Secrets are references

A string `env:NAME` anywhere in either file reads that environment variable. Put every secret there, never in the
file:

```yaml
sources:
  shop: { url: env:DATABASE_URL }
auth:
  kind: oidc
  clientSecret: env:LENSPACK_OIDC_SECRET
  sessionSecret: env:LENSPACK_SESSION_SECRET
```

Model providers and their keys live only in the environment (`LENSPACK_LLM_PROVIDERS` and friends), because they
carry keys and per-deployment prices; the config file describes data. See [Chat models](models.md).

## What wins

For settings that can come from several places, the order is, lowest first:

1. the built-in default;
2. the config file;
3. the environment variable;
4. a value an admin set on a running server (the admin panel or Superset's settings page), kept in the state
   directory.

An admin's value can be handed back with **Reset** (or `null` through the settings routes). This holds for the
switches, voice and language settings, saved answers and the queue. For `superset.yaml`, most keys can be left out
for their environment variable, then the default (for example `superset.url` or `LENSPACK_SUPERSET_URL`).

## The settings an admin can change while it runs

Without a restart, from the admin panel or Superset's settings page:

- every [feature switch](switches.md);
- [saved answers](../features/saved-answers.md#the-switches) and the [queue](../features/busy-hours.md);
- the [daily review](../features/review.md#the-daily-review) and the definitions;
- inside Superset, the chat and speech models, [voice](../features/voice.md) and [languages](../features/languages.md).

Everything else (sources, packs, sign-in, the store) needs a restart.

## Check a config

```bash
lenspack check --config lenspack.yaml     # loads every pack, draws every board; exit 1 on any error
lenspack sources --config lenspack.yaml   # what each source holds
```

A config with a value of the wrong kind, a pack with a mistake, or an access rule naming a key the pack lacks stops the server at
start, with every problem listed. (Most blocks ignore a key they do not know, so check spelling against the
[reference](../reference/config.md); `budget`, `cache`, `queue` and `explain` refuse one.)

---

**Next:** [Chat models](models.md).

**Related:** [Configuration reference](../reference/config.md) · [Feature switches](switches.md)
