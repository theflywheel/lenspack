# Deploying

This page covers running Lenspack in production: the Docker image, its ports and volume, health checks, putting it
behind a proxy, and running more than one copy. It is for operators.

## The image

The repository's `Dockerfile` builds one image for both server hosts. Images are published from the main branch
only, as `ghcr.io/theflywheel/lenspack`, tagged with the short commit hash and `latest`. Config, packs and boards
are mounted at run time, so one image serves every deployment.

| | |
|---|---|
| base | `node:22-slim`, running as the `node` user |
| entry point | `node packages/hosts/serve/dist/cli.js` (the `lenspack` command) |
| default command | `serve --config /config/lenspack.yaml` |
| ports | 8787 (`lenspack serve`), 8795 (`lenspack superset`) |
| volume | `/data`, the state directory (`LENSPACK_STATE_DIR=/data`) |
| environment set | `NODE_ENV=production`, `LENSPACK_UI=examples/demo/dist` (the board app is included), `LENSPACK_HOST=0.0.0.0`, `LENSPACK_STATE_DIR=/data` |

The old paths `packages/serve` and `packages/superset` are links to their new folders, so commands written for
earlier images still work.

Because the image sets `LENSPACK_UI`, a `ui:` folder in `lenspack.yaml` is ignored; `--ui` on the command line, or
your own `LENSPACK_UI`, still wins. `ui:` settings such as `title` and `intro` still apply.

```sh
docker pull ghcr.io/theflywheel/lenspack:latest   # or build your own: docker build -t lenspack .

# the standalone server
docker run -v "$PWD/config:/config:ro" -v lenspack-data:/data -p 8787:8787 \
  -e DATABASE_URL -e LENSPACK_ADMIN_PASSWORD -e ANTHROPIC_API_KEY ghcr.io/theflywheel/lenspack:latest

# inside Superset: on Superset's network, named lenspack, with no published port
docker run --name lenspack --network <superset's network> -v "$PWD/config:/config:ro" -v lenspack-data:/data \
  -e LENSPACK_SUPERSET_URL=http://superset:8088 -e LENSPACK_PUBLIC_PATH=/lenspack \
  -e ANTHROPIC_API_KEY -e SUPERSET_ADMIN_PASSWORD \
  ghcr.io/theflywheel/lenspack:latest superset --config /config/superset.yaml
```

Inside Superset, `SUPERSET_ADMIN_PASSWORD` is needed on the first start only, to make Lenspack's own Superset account. A
complete Compose example, and the same on Kubernetes, are in [Install in
Superset](../hosts/superset/install.md#3-run-the-server).

Mount the config read-only and keep `/data` on a volume. Inside Superset, `/data` is the state directory by default.
For `lenspack serve`, `/data` holds the password sign-in's files; set `state: /data` (and `cache:`, `usage:`,
`audit:` paths under it) in `lenspack.yaml` to keep settings, saved answers, definitions and the audit log there too.
See [What Lenspack keeps on disk](state.md).

## Health and shutdown

`GET /healthz` answers `{ "ok": true }` (with a few host-specific fields) without sign-in, for as long as the process
runs: use it for liveness. `GET /readyz` answers `200 { "ready": true }` once the server can answer requests, and
`503 { "ready": false, "reason": … }` until then: use it for readiness. Don't point the liveness probe at `/readyz`,
or a Superset that is down restarts the server in a loop.

**Starting before Superset is ready.** Inside Superset, the server listens as soon as its config is read, and is not
ready until it has signed in to Superset, read the datasets and dashboards, built the pack and been given the
identity key. If Superset can't be reached, answers with an error (5xx), refuses Lenspack's sign-in (401 or 403) or
closes the connection, the server does not stop: it tries again after 2, 5, 10 and 30 seconds, then every minute,
for as long as it takes, and logs one line per try with the cause and the next wait, such as:

```
reading the datasets from Superset failed: Superset answered 503 (not up yet, or restarting); trying again in 10 s (try 3; the server stays up, not ready)
```

Meanwhile `/healthz` answers 200, `/readyz` answers 503 with the same words as `reason`, and every other request
answers 503 "starting", which the chat shows as "restarting, reconnecting". It becomes ready by itself as soon as
Superset answers: no restart is needed. `LENSPACK_STARTUP_RETRY_SECONDS` changes the waits (`2,5,10,30,60`, the
last one repeating).

A mistake that waiting can't fix still stops the server at once, with a message saying what to change: a config
file that isn't valid YAML, a setting with a wrong value (`LENSPACK_ADMIN_API_KEYS` with a key that is too short, for
example), a dataset or dashboard that Superset says doesn't exist once Lenspack is signed in, a dataset name that
matches more than one dataset, or no password to make Lenspack's Superset account with. These are checked before
Superset is asked anything, where they can be.

```yaml
livenessProbe:  { httpGet: { path: /healthz, port: 8795 } }
readinessProbe: { httpGet: { path: /readyz, port: 8795 } }
```

On SIGTERM or SIGINT the server closes its sources and stores and exits.

## Behind a proxy

- **Put TLS in front.** The password form sends the password as typed, and session cookies are marked `Secure` only on
  https. Set `auth.baseUrl` to the address people use.
- **Inside Superset**, browsers never reach Lenspack: Superset's plugin forwards `/lenspack/...` to it. Keep port
  8795 on a private network. A chat turn holds one of Superset's threads while it streams, so raise Superset's
  `SERVER_THREADS_AMOUNT` for more than about ten chats at once.

## More than one copy

- **The standalone server** runs as several copies when boards are in Postgres (`store: { kind: postgres }`) and every
  copy shares one state directory (or, under the password sign-in, the same password and `sessionSecret`). Each copy
  still runs its own queue and keeps its own saved answers.
- **Inside Superset**, run one copy: board bookkeeping and version history are per process.

What each store keeps and what is planned so that every part can be shared is in
[Stores, and running several copies](../architecture/stores.md).

## On Kubernetes

The same image works. Mount the config from a ConfigMap (read-only is fine: definitions and proposals are written to
the state directory or the `proposals:` folder, never to the pack file) and the state directory from a volume. A
volume shared with a group (`fsGroup`) is accepted for the password sign-in's files.

## Before others use it

- a sign-in that names people (see [Sign-in](../access/sign-in.md));
- a daily budget (see [Costs](costs.md#a-budget));
- a read-only database role for every source (see [SQL databases](../sources/sql.md#the-guards-belong-to-the-driver));
- inside Superset, Superset roles checked, since each person's Superset access applies (see
  [Access inside Superset](../access/superset.md)).

---

**Next:** [What Lenspack keeps on disk](state.md).

**Related:** [Install in Superset](../hosts/superset/install.md) · [The standalone server](../hosts/serve.md)
