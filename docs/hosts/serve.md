# The standalone server

This page describes `lenspack serve`: Lenspack's own server, with a board API, a chat, sign-in, an admin panel and
the board app. It is for developers and operators running Lenspack without Superset.

## What it is

`lenspack serve` (the `@lenspack/serve` package) reads one config file, `lenspack.yaml`, and serves:

- the **board API** at `/api/...`: catalogues, boards, data, edits, versions and the chat (see
  [HTTP API](../reference/http-api.md));
- the **chat**, with the reviewer, saved answers, the queue, metering and a budget;
- **sign-in**: a built-in password, OpenID Connect, a login proxy or tokens (see [Sign-in](../access/sign-in.md));
- the **admin panel** at `/_lenspack/admin/` when `state:` is set (see [The admin panel](../features/admin-panel.md));
- the **board app**, when given one (`--ui <dir>`, `LENSPACK_UI` or `ui:` in the config);
- `/healthz` for a load balancer.

## Run it

```bash
lenspack serve --config lenspack.yaml          # or: lenspack --config lenspack.yaml
lenspack serve --config lenspack.yaml --port 9000 --ui ./examples/demo/dist --host 0.0.0.0
```

The port is `--port`, else `port:` in the config, else `PORT`, else 8787. It listens on `--host`, else `host:`,
else on every address (`0.0.0.0`) when a sign-in is set and on this machine only (`127.0.0.1`) with `auth: none`.
The Docker image includes the board app. The whole command line is in [CLI](../reference/cli.md); deployment is in [Deploying](../operating/deploying.md).

## A config

```yaml
# lenspack.yaml: a string "env:NAME" anywhere reads that variable; secrets are env: references, never values
sources:
  shop:   { url: env:DATABASE_URL }                  # postgres://, mysql://, clickhouse://, sqlite:…, duckdb:…
  search: { kind: elasticsearch, url: env:ES_URL, apiKey: env:ES_API_KEY }
packs:
  - { pack: ./packs/commerce.pack.yaml, source: shop, boards: ./packs/commerce/boards }
store: { kind: postgres, url: env:BOARDS_URL }      # boards never live in a source; default: memory
auth: { kind: oidc, issuer: https://idp.example.com, clientId: lenspack, baseUrl: https://lens.example.com,
        sessionSecret: env:LENSPACK_SESSION_SECRET, maintainers: ["role:analysts"] }
state: ./state                                      # switches, definitions, open questions, review; the admin panel
audit: ./audit.jsonl
usage: ./usage.jsonl
budget: { usdPerDay: 20, usdPerUserPerDay: 2 }
cache: {}                                           # saved answers
```

Every key and its default is in [Configuration reference](../reference/config.md#lenspackyaml); what each part is
for is in [Configuration](../operating/configuration.md).

## The board app

The board app (`examples/demo` in this repository) is a React app over the board API: a chat that builds the board,
drag-and-drop editing, filters, version history and "How this was worked out". Its look carries one idea: colour is
provenance. A key the pack declares is always mono and blue, in prose, in the metrics reference or in a board title.
Something the compiler refuses is always ochre.

`pnpm demo` serves every example pack with a seeded database in the current folder (`<name>.duckdb`) through this
server, with the board app. In the app, `/?example=<pack>&board=<board>` opens one. See
[Quick start](../getting-started/quickstart.md).

## Boards

Boards live in the store named by `store:`: in memory (the default, lost on restart), a DuckDB file, or Postgres.
Boards a pack ships (`boards:` beside the pack) are everyone's to read and a maintainer's to change. A board someone
makes is theirs, hidden until they share it. See [Rights](../access/rights.md#boards-have-owners).

## Embedding a board in another page

The board renderer is also built as one script, `board.js` with `board.css`, that draws a board from a board API on
a page with no build of its own. The admin panel draws its usage board this way. See
[React](react.md#one-script-tag).

## As a library

`@lenspack/serve` exports `createApp`, which the CLI and the Superset host both use, so you can run the same server
in a Node.js process of your own with hosts, stores, models and an `access(request)` hook you build in code. The
demo's `examples/demo/server.ts` is a short example.

---

**Next:** [React](react.md).

**Related:** [Your own data](../getting-started/your-own-data.md) · [Sign-in](../access/sign-in.md) ·
[Configuration reference](../reference/config.md)
