# @lenspack/mcp

Lenspack as tools for any MCP client. The `lenspack-mcp` command serves one pack and one board over stdio (the
default) or streamable HTTP; the model reads and edits the board through the same tools the Lenspack chat uses, so
every query goes through the pack.

```bash
lenspack-mcp --pack ./pack.yaml --db ./data.duckdb
```

Install it from GitHub Packages as `@theflywheel/lenspack-mcp`, or run `node packages/hosts/mcp/dist/cli.js` from a
built clone; it is not on the public npm registry.

It is for one person on their own machine: it has no sign-in and no access rules of its own. As a library,
`createMcpServer(tools)` registers the agent's board tools on any MCP transport, and the package re-exports
`@lenspack/agent`.

Options, HTTP and its safeguards, and how the data is kept read-only:
[docs/hosts/mcp.md](../../../docs/hosts/mcp.md).
