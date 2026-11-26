# Install Lenspack in Superset

This page takes you through adding Lenspack to a running Superset: the plugin on Superset's side, the Lenspack
server, and the settings each needs. It is for whoever runs Superset.

You need Superset 6.1 or 5.0, a way to run one more container (or a Node.js 22 process), and a model key.

## 1. Add the plugin to Superset

Superset's side is one Python file, [`lenspack_superset.py`](../../../packages/hosts/superset/plugin/lenspack_superset.py).
It needs no fork, no custom image and no second web server. Put it on Superset's Python path (for example,
mounted into `/app/pythonpath/`) and import it at the end of `superset_config.py`:

```python
# superset_config.py
from lenspack_superset import *  # noqa: F401,F403
```

On the Helm chart, a `configOverrides` entry holding that line does the same. The import sets `FLASK_APP_MUTATOR`.
If your config already sets one, call `lenspack_app_mutator(app)` from yours and set `FLASK_APP_MUTATOR` back to
yours after the import.

The plugin adds:

- `/lenspack/...` on Superset's own host, forwarded to the Lenspack server for signed-in users, with a signed
  identity header (see [Who is asking](identity.md)). Chat replies stream through unbuffered, and a change sent
  from another site is refused. Browsers never reach Lenspack's port.
- the **Ask Lenspack** button on every page, through Superset's documented-overridable
  `tail_js_custom_extra.html`;
- **Settings → Manage → AI assistant** for admins: chat and speech models, languages, switches, spend, cost per
  answer and the audit log (see [Settings and switches](settings.md));
- `GET /api/v1/lenspack/identity-key` and `POST /api/v1/lenspack/bootstrap`, which the Lenspack server calls on
  start to fetch the signing key and to make its own account;
- `GET /api/v1/lenspack/access?user=&datasets=&dashboards=`, which the server calls for each user's Superset access:
  whether they may read each dataset and its row-level security clauses, whether they may open each dashboard, and,
  with dashboard roles on, which datasets they may read only on each dashboard (see
  [Access inside Superset](../../access/superset.md));
- `GET /api/v1/lenspack/version`, Superset's version, read by the server on start (admins and its own account);
- a fix for Flask-AppBuilder (4.x in Superset 5, 5.x in Superset 6.1), whose list endpoints share filters between
  concurrent requests;
- on Superset 6.1, the ClickHouse column-name fix (see [Versions](versions.md#clickhouse-column-names-on-superset-61)).

Superset's environment, for the plugin:

| variable | default | |
|---|---|---|
| `LENSPACK_INTERNAL_URL` | `http://lenspack:8795` | where Superset's server reaches the Lenspack server |
| `LENSPACK_SERVICE_USER` | `lenspack` | the Lenspack server's Superset account (`superset.username` in its config) |
| `LENSPACK_TEMPLATES` | none | a folder whose `tail_js_custom_extra.html` or `lenspack/settings.html` replaces the built-in one |
| `LENSPACK_CLICKHOUSE_LABEL_SUFFIX` | `on` | `off` keeps Superset 6.1's own ClickHouse column names (see [Versions](versions.md#clickhouse-column-names-on-superset-61)) |

A chat turn holds one of Superset's gunicorn threads while it streams (30 to 60 seconds), so raise
`SERVER_THREADS_AMOUNT` for more than about ten chats at once.

## 2. Write `superset.yaml`

```yaml
# superset.yaml: a string "env:NAME" anywhere reads that variable
datasets: [orders, public.customers]     # by id, or by table name
overlay: { instructions: "…", examples: [] }
# Each of these may be left out for its environment variable, then the default:
superset: { url: http://superset:8088 }  # LENSPACK_SUPERSET_URL (required one way or the other)
publicPath: /lenspack                    # LENSPACK_PUBLIC_PATH, "" (where Superset forwards this server)
host: 0.0.0.0                            # LENSPACK_HOST, 127.0.0.1 (0.0.0.0 in the image)
port: 8795                               # LENSPACK_PORT, 8795
state: /data/superset-boards.json        # LENSPACK_STATE_DIR/superset-boards.json, else state/superset-boards.json
budget: { usdPerDay: 20 }                # LENSPACK_BUDGET_USD_PER_DAY, LENSPACK_BUDGET_USD_PER_USER_PER_DAY
hostPolicy: superset                     # LENSPACK_HOST_POLICY: each user's own Superset access
```

Set `publicPath: /lenspack` (or `LENSPACK_PUBLIC_PATH=/lenspack`) so the server's pages and scripts use the path
Superset forwards. Every key is in [Configuration reference](../../reference/config.md#supersetyaml); what the
datasets and overlay do is in [Datasets and dashboards](datasets-and-dashboards.md).

## 3. Run the server

The repository's image runs it:

```sh
docker run -v "$PWD/config:/config:ro" -v lenspack-data:/data -p 8795:8795 \
  -e LENSPACK_SUPERSET_URL=http://superset:8088 -e ANTHROPIC_API_KEY \
  -e SUPERSET_ADMIN_PASSWORD \
  lenspack superset --config /config/superset.yaml
```

From the source tree, `npx tsx --tsconfig tsconfig.base.json packages/hosts/superset/bin/serve.ts superset.yaml`
does the same.

It is the same server runtime as `lenspack serve` (models, metering, budget, audit, `/healthz`, a clean exit on
SIGTERM), with Superset as its host.

**Its own Superset account.** On first start the server signs in once as a Superset admin
(`SUPERSET_ADMIN_USERNAME`, default `admin`, and `SUPERSET_ADMIN_PASSWORD`) and calls the plugin's bootstrap route,
which makes the `lenspack` user with the Admin role (it edits dashboards it does not own, which Superset allows only
owners and admins). The generated password stays in `superset-account.json` (mode 600) in the state directory;
after that the admin password can be removed. `LENSPACK_SUPERSET_PASSWORD` (with `superset.username`) uses an
account you manage instead.

**Models.** Set `LENSPACK_LLM_PROVIDERS` as for any Lenspack server (see [Chat models](../../operating/models.md)).
With only `ANTHROPIC_API_KEY` set, the chat offers Claude Sonnet 5.5 (the default), Opus 5.5 and Haiku 5.5, and the
settings page says where the key came from.

## 4. Check it

Open a dashboard in Superset: the **Ask Lenspack** button appears on it. The server's log prints
Superset's version and the map style it will use (`Superset 6.1.0; maps drawn on …`), and one warning line for
anything in a dataset it left out.

The chat opens as a floating window or as a side panel; the gear chooses. The window opens at the top right, below
Superset's menu bar: drag it by its header, and resize it with the grip in its bottom-left corner or from its left
and top edges. Size and position are remembered per browser.

---

**Next:** [Datasets and dashboards](datasets-and-dashboards.md).

**Related:** [Deploying](../../operating/deploying.md) · [Troubleshooting](../../operating/troubleshooting.md)
