# Extending Lenspack

This page lists the ways to extend Lenspack, from the one almost every deployment needs (a pack) to the ones few
will (a host). It is for developers.

| to | write | page |
|---|---|---|
| describe your data | a **pack** | [Write a pack](write-a-pack.md) |
| reach a database or system Lenspack does not ship with | a **driver** (SQL) or a **connector** (anything else) | [Write a source](write-a-source.md) |
| run Lenspack inside your own app | a **host** | [Write a host](write-a-host.md) |
| use a model API Lenspack does not speak | a **model adapter** | [Add a model provider](model-adapter.md) |
| bring dashboards from another system | an **importer** | [Importers](importers.md) |
| draw charts with your own chart library | a **chart adapter** | [React: chart libraries are adapters](../hosts/react.md#chart-libraries-are-adapters) |

Each extension point is a small interface with a registry or a constructor argument, and a test suite that proves
an implementation right. None of them needs a change to the kernel. If you find yourself editing the kernel to add
one, that is a bug report we want.

**Planned:** adapters that map a deployment's own data model onto packs (so a pack can be generated from a
description of the data rather than written by hand), and a registry of sources for `lenspack.yaml`.

---

**Next:** [Write a pack](write-a-pack.md).

**Related:** [Architecture overview](../architecture/README.md) · [Packages](../reference/packages.md)
