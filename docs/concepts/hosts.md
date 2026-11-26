# Hosts

A host is the app Lenspack runs inside. This page explains what a host is responsible for and compares the four
that ship. It is for anyone choosing how to deploy Lenspack.

## What a host does

Lenspack's kernel never reaches a database or a model provider by itself, and it never decides who someone is.
A host supplies those things:

- **who is asking**: a signed-in identity, with roles and anything the host already limits;
- **where boards are kept**: a board store;
- **a connector** for the data;
- **the user interface**: a chat panel, a board app, or none;
- **the running turn**: models, metering, budget and audit.

In return, the kernel gives the host the pack, the checked queries, the agent's tools, the access decision and the
answer card.

## The hosts that ship

| host | who signs in | where boards live | access decided by |
|---|---|---|---|
| **[Superset](../hosts/superset/README.md)** | Superset, through a signed header on every request | Superset dashboards | Superset's dataset access, row-level security and dashboard rights, narrowed by Lenspack |
| **[Standalone server](../hosts/serve.md)** (`lenspack serve`) | Lenspack: a password, OpenID Connect, a login proxy or tokens | a DuckDB or Postgres store | sign-in claims, rights by role, and pack access rules |
| **[React components](../hosts/react.md)** | your app | your app, through callbacks | your app |
| **[MCP server](../hosts/mcp.md)** (`lenspack-mcp`) | nobody: one person on their own machine | a local store | none: it acts as the person who started it |

## The rule every host follows

**The host says who is asking and what it allows; Lenspack only narrows.** One function in the kernel's policy
package settles what a caller may use, from what the host says, and every host with more than one caller goes
through it. See [Policy](policy.md).

---

**Next:** [Policy](policy.md).

**Related:** [Choose a host](../hosts/README.md) · [How a host plugs in](../architecture/hosts.md)
