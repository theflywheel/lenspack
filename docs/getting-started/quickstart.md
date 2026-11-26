# Quick start

In about five minutes you will have the board app running on your machine over a made-up online shop, and a chat
that can answer questions and change the board. No database server is needed. This page is for anyone trying
Lenspack for the first time.

## 1. Seed the data and start the app

```bash
git clone https://github.com/theflywheel/lenspack && cd lenspack && pnpm install
pnpm seed commerce ./commerce.duckdb      # 5,000 made-up orders in a DuckDB file
pnpm demo                                 # http://localhost:5173
```

Open <http://localhost:5173>. You see the shop's overview board: revenue and orders for the last 30 days, weekly
revenue, revenue by country, and line revenue by category. Drag a widget, then open the version history and
restore the earlier version.

The demo serves every `<name>.duckdb` file it finds, so you can seed more example packs: `pnpm seed events
./events.duckdb`, `pnpm seed tickets ./tickets.duckdb` and so on. In the app, `/?example=<pack>&board=<board>`
opens one. The examples are listed in [Architecture](../architecture/README.md#the-example-packs).

## 2. Turn on the chat

The board app needs a model to chat. Lenspack itself never holds a model key; you give the demo one through the
environment. Any OpenAI-compatible endpoint works:

```bash
LENSPACK_LLM_BASE_URL=https://openrouter.ai/api/v1 LENSPACK_LLM_API_KEY=… LENSPACK_LLM_MODEL=z-ai/glm-4.5 pnpm demo
```

or Claude, through Anthropic's API:

```bash
LENSPACK_LLM_PROVIDERS='[{"name":"claude-sonnet-5-5","kind":"anthropic","model":"claude-sonnet-5-5","apiKeyFile":"/path/to/anthropic.key"}]' pnpm demo
```

[Chat models](../operating/models.md) covers every provider setting.

## 3. Try it

Ask the chat:

- *"Revenue for the last 30 days, and how it compares with the 30 days before."* It answers with numbers. Open
  **How this was worked out** under the reply to see the measure, the SQL and the rows.
- *"Put weekly orders under the totals, as a line."* The board gains a widget, as a new version.
- *"Revenue by product category."* The assistant explains it cannot: revenue is counted per order, and an order
  has many products, so splitting it by category would count orders more than once. It offers line revenue
  instead. This refusal is the point: a number that silently multiplies is worse than no number.
- *"Revenue by contry."* The typo is caught, and the nearest real key, `country`, is suggested.

## Or: let an AI assistant build the board

Point any MCP client at the same data, with no app at all. Build the packages once, then start the MCP server from
the clone:

```bash
pnpm build
node packages/hosts/mcp/dist/cli.js --pack examples/commerce/pack.yaml --db ./commerce.duckdb
```

An MCP client starts it itself, from its own folder, so give it absolute paths:

```json
{ "mcpServers": { "commerce": { "command": "node", "args": ["/path/to/lenspack/packages/hosts/mcp/dist/cli.js", "--pack", "/path/to/lenspack/examples/commerce/pack.yaml", "--db", "/path/to/lenspack/commerce.duckdb"] } } }
```

Then ask: *"Put revenue for the last 30 days as a KPI across the top, weekly revenue below it, and a pie of line
revenue by category."* Every step is a checked edit, and every refusal names the nearest real key. See
[MCP server](../hosts/mcp.md).

---

**Next:** [Your own data](your-own-data.md), or [Concepts](../concepts/README.md) to learn what you just used.

**Related:** [The standalone server](../hosts/serve.md) · [The example pack](../../examples/commerce/pack.yaml)
