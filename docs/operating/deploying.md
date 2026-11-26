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
| environment set | `NODE_ENV=production`, `LENSPACK_UI=examples/demo/dist` (the board app is included), `LENSPACK_HOST=0.0.0.0` |

The old paths `packages/serve` and `packages/superset` are links to their new folders, so commands written for
earlier images still work.

```sh
docker build -t lenspack .

# the standalone server
docker run -v "$PWD/config:/config:ro" -v lenspack-data:/data -p 8787:8787 \
  -e DATABASE_URL -e LENSPACK_ADMIN_PASSWORD -e ANTHROPIC_API_KEY lenspack

# inside Superset
docker run -v "$PWD/config:/config:ro" -v lenspack-data:/data -p 8795:8795 \
  -e LENSPACK_SUPERSET_URL=http://superset:8088 -e ANTHROPIC_API_KEY \
  lenspack superset --config /config/superset.yaml
```

Mount the config read-only and keep `/data` on a volume. Inside Superset, `/data` is the state directory by default.
For `lenspack serve`, `/data` holds the password sign-in's files; set `state: /data` (and `cache:`, `usage:`,
`audit:` paths under it) in `lenspack.yaml` to keep settings, saved answers, definitions and the audit log there too.
See [What Lenspack keeps on disk](state.md).

## Health and shutdown

`GET /healthz` answers `{ "ok": true }` (with a few host-specific fields) without sign-in. On SIGTERM or SIGINT the
server closes its sources and stores and exits.

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
