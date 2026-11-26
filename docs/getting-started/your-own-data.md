# Your own data

This page takes you from a database you already have to a running Lenspack server over it, with sign-in. It is
for a developer or analyst with read access to a database. Allow half an hour, most of it for the pack.

The commands below use `lenspack`, the command of the `@lenspack/serve` package. Install it as described in
[Packages](../reference/packages.md), or, from a clone of this repository, run `pnpm build` and use
`node packages/hosts/serve/dist/cli.js` in its place.

You will write two files:

- **`lenspack.yaml`**, the deployment's config: which databases exist, which pack reads which database, and where
  boards are kept.
- **a pack**, which describes the data: tables, joins, dimensions and measures.

## 1. Describe where the data is

```yaml
# lenspack.yaml. Secrets are env: references, never values.
sources:
  shop: { url: env:DATABASE_URL }          # postgres://, mysql://, clickhouse://, sqlite:… or duckdb:…
packs:
  - { pack: ./shop.pack.yaml, source: shop }
store: { kind: duckdb, path: ./boards.duckdb }   # boards never live in a source
```

A SQL source is a connection URL, and its scheme picks the driver. Connect with a database role that can only
read. See [SQL databases](../sources/sql.md) for every URL form, or [Elasticsearch](../sources/elasticsearch.md).

See what the database holds:

```bash
lenspack sources --config lenspack.yaml     # tables, columns, types and row counts
```

## 2. Write a small pack

Start with one or two tables and a few keys. You can add more later.

```yaml
# shop.pack.yaml
pack: shop
version: 1
entities:
  orders:
    source: orders
    grain: one row per order
    time: placed_at
    joins:
      - { to: customers, on: orders.customer_id = customers.id, type: many_to_one }
  customers: { source: customers, grain: one row per customer }
dimensions:
  - { key: country, entity: customers, field: country, synonyms: [market] }
  - { key: status,  entity: orders,    field: status,  type: enum }
measures:
  - { key: orders,  entity: orders, agg: count }
  - { key: revenue, entity: orders, agg: sum, sql: total_cents / 100.0, format: currency }
```

Keep measures simple: counts and sums. Rates, changes and averages per day come from the
[compute step](../concepts/measures.md#the-compute-step), not from a new measure for each. [Write a
pack](../extending/write-a-pack.md) walks through every choice.

## 3. Check it

```bash
lenspack check --config lenspack.yaml       # loads the pack, draws every board, exits 1 on any error
```

A pack with a mistake is refused at load, with every problem listed.

## 4. Serve it

```bash
lenspack serve --config lenspack.yaml       # the board API on :8787
```

The board app is a folder of built files that the server serves when you name it: `--ui <dir>`, `LENSPACK_UI`, or
`ui:` in the config. The Docker image below includes it.

With no `auth:` block, sign-in is one built-in user, `admin`, with a password. Set `LENSPACK_ADMIN_PASSWORD` (at least
12 characters), or read the one Lenspack makes at first start from `.lenspack/admin-password.txt` next to
`lenspack.yaml`, then delete that file. For named people, use your sign-in provider: see
[Sign-in](../access/sign-in.md).

Give the chat a model the same way as in the [quick start](quickstart.md#2-turn-on-the-chat), and set a daily
budget before anyone else uses it:

```yaml
budget: { usdPerDay: 20, usdPerUserPerDay: 2 }
```

## 5. Or run the image

The repository's Dockerfile builds one image that serves any deployment from a mounted folder:

```bash
docker build -t lenspack .
docker run -v "$PWD/config:/config:ro" -v lenspack-data:/data -p 8787:8787 \
  -e DATABASE_URL -e LENSPACK_ADMIN_PASSWORD lenspack
```

It reads `/config/lenspack.yaml` and keeps its state in `/data`. See [Deploying](../operating/deploying.md).

---

**Next:** [Concepts](../concepts/README.md), to understand what each part of the pack does.

**Related:** [The standalone server](../hosts/serve.md) · [Configuration keys](../reference/config.md) ·
[Pack file reference](../reference/pack.md)
