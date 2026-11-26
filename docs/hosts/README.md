# Choose a host

This page helps you choose how to run Lenspack: inside Apache Superset, as its own server, inside your React app,
or as tools for an MCP client. It is for whoever is setting up a deployment.

| if you… | use | page |
|---|---|---|
| already have Superset dashboards and want a chat on them | the **Superset host** | [Superset](superset/README.md) |
| want Lenspack's own board app and API over a database, with your sign-in | the **standalone server** (`lenspack serve`) | [The standalone server](serve.md) |
| want boards inside your own product | the **React components**, with the board API or your own server | [React](react.md) |
| want a model in your editor or desktop app to build boards | the **MCP server** (`lenspack-mcp`) | [MCP](mcp.md) |

## How they compare

| | Superset | standalone | React | MCP |
|---|---|---|---|---|
| Sign-in | Superset's | password, OpenID Connect, proxy or tokens | your app's | none (one person) |
| Pack | built from Superset's datasets | a file | from your server | a file |
| Where boards live | Superset dashboards | DuckDB or Postgres | your server | a local DuckDB file |
| Chat | Superset's pages get a chat panel | the board app's chat | yours | the MCP client |
| Access | Superset's dataset access, row-level security and dashboard rights | sign-in roles and pack access rules | yours | none |
| Admin panel | yes | yes, with `state:` | no | no |
| Voice | yes | the route only | no | no |

All of them use the same kernel: the same packs, queries, checks, edit operations and tools. See
[How a host plugs in](../architecture/hosts.md). To write a host of your own, see
[Write a host](../extending/write-a-host.md).

---

**Next:** [Superset](superset/README.md).

**Related:** [Hosts](../concepts/hosts.md) · [Deploying](../operating/deploying.md)
