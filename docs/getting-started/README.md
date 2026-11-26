# Getting started

This page helps you pick the shortest path to a working Lenspack for what you have in front of you. Each path
takes minutes, not hours.

| You have… | Start with | You will end with |
|---|---|---|
| nothing yet, and want to look around | [Quick start](quickstart.md) | a board app on made-up shop data, with the chat if you give it a model key |
| a few minutes to learn how a pack is written | [Tutorial: build a pack](tutorial.md) | a pack, a board and a server over made-up support tickets |
| a database you want to ask questions of | [Your own data](your-own-data.md) | `lenspack serve` on your database, with sign-in |
| an Apache Superset | [Install into Superset](../hosts/superset/install.md) | an "Ask Lenspack" button on every dashboard |
| your own web app | [React components](../hosts/react.md) | boards drawn inside your app |
| an MCP client such as a desktop assistant | [MCP server](../hosts/mcp.md) | your data as tools the assistant can call |

You need Node.js 22 or later and pnpm 9 for the first three paths. The Superset path needs Docker, or a place to run
the Lenspack image.

There is also a live demo, with made-up example packs, a chat that builds the board, drag-and-drop editing and
version history: <https://lenspack.proto.theflywheel.in>.

---

**Next:** [Quick start](quickstart.md).

**Related:** [The example packs](examples.md) · [What Lenspack is](../introduction/README.md) ·
[Choose a host](../hosts/README.md)
