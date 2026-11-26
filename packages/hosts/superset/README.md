# @lenspack/superset

Lenspack inside Apache Superset 6.1 (or 5.0), without forking Superset.

This package puts a chat on every Superset dashboard. People ask questions in their own words and get numbers they can
check; people allowed to edit a dashboard can change it by asking. It reads the pack from Superset's datasets, gets
numbers through Superset's chart API (so a metric means the same in both, and Superset's row-level security applies),
keeps boards in step with Superset's dashboards, and takes the signed-in person from Superset.

It has two halves:

- **`plugin/lenspack_superset.py`**, one Python file added to Superset's `superset_config.py`. It signs who is asking,
  forwards `/lenspack/…` to the Lenspack server, answers Lenspack's questions about a person's access, and adds the
  settings page.
- **The Lenspack server**, `lenspack superset --config superset.yaml` (the root image runs it).

```yaml
# superset.yaml
superset:
  url: http://superset:8088
datasets: [orders, customers]      # by id, or by table name
```

```python
# superset_config.py
from lenspack_superset import *    # noqa: F401,F403
```

Everything else is in the docs:

- [Lenspack in Apache Superset](../../../docs/hosts/superset/README.md): what it does and how it fits.
- [Install into Superset](../../../docs/hosts/superset/install.md): the plugin, the server, the content security policy.
- [Datasets and dashboards](../../../docs/hosts/superset/datasets-and-dashboards.md): how datasets become a pack and
  dashboards become boards.
- [Who is asking](../../../docs/hosts/superset/identity.md) and [Access inside Superset](../../../docs/access/superset.md):
  what each user sees.
- [Settings](../../../docs/hosts/superset/settings.md), [Versions](../../../docs/hosts/superset/versions.md) and
  [Upgrading](../../../docs/hosts/superset/upgrading.md).

Apache-2.0.
