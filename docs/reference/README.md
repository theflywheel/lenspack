# Reference

This section lists every setting, format, route, command and code, for looking things up. It is for anyone who
already knows what they want and needs the exact detail. The pages that explain each idea are in
[Concepts](../concepts/README.md).

| page | what it lists |
|---|---|
| [Configuration reference](config.md) | every key of `lenspack.yaml` and `superset.yaml`, and every environment variable |
| [Pack file reference](pack.md) | the pack format, the rules checked at load, and how the compiler reads it |
| [Query format](query.md) | the five query shapes, time ranges, filters and the compute step |
| [Board format](board.md) | boards, widgets, filters and the ten edit operations |
| [HTTP API](http-api.md) | the board API, speech, usage, the admin API and the Superset routes |
| [Command line](cli.md) | `lenspack`, `lenspack-mcp` and the repository's scripts |
| [Stream parts](stream-parts.md) | what a chat turn sends back while it runs |
| [Refusal codes](errors.md) | every code a query can be refused with, and what to do |
| [Packages](packages.md) | the npm packages and how to install them |
| [Evals](evals.md) | how models are measured on real tasks |
| [Glossary](glossary.md) | the words these docs use |

The key tables in the configuration and pack pages are generated from the code by `pnpm docs:keys`, and `pnpm check`
fails when they fall behind.

---

**Next:** [Configuration reference](config.md).

**Related:** [Operating Lenspack](../operating/README.md) · [Concepts](../concepts/README.md)
