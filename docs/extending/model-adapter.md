# Add a model provider

This page shows how to teach Lenspack a model API it does not speak yet, by writing an adapter. It is for
developers. Configuring the providers that ship is in [Chat models](../operating/models.md).

A provider's `kind` picks its **adapter**, the way a source URL's scheme picks a SQL driver. The adapter turns the
provider's config into a model (an AI SDK `LanguageModel`) and shapes calls for that provider's API. Nothing else in
Lenspack knows which API a model speaks. Two adapters ship: `openai-compatible` (the default) and `anthropic`.

## Writing one
An adapter is an object registered once, before providers are built:

```ts
import { registerLlmAdapter, type LlmAdapter } from "@lenspack/serve";

const mine: LlmAdapter = {
  kind: "my-api",
  defaultBaseUrl: "https://api.example.com/v1", // omit to require baseUrl
  ownKeys: [],                                   // config keys only this kind reads
  build(cfg, { apiKey, fetch }) {                // returns an AI SDK LanguageModel
    return createMyProvider({ baseURL: cfg.baseUrl, apiKey, fetch })(cfg.model);
  },
  pricing: (cfg) => undefined,                   // published prices, if known
  prepare: undefined,                            // reshape calls (cache markers); absent, calls go as written
  efforts: (cfg) => undefined,                   // { levels, default } if the model has an effort setting
};
registerLlmAdapter(mine);
```

`prepare` receives the system prompt in parts, stable first and the part that changes most last, with the messages and tools, and returns what `generateText` / `streamText` take. Callers go through `shapeCall(provider, call)`, which joins the parts into one string when an adapter has no `prepare`, so the adapters that need no shaping receive exactly what they always did. A call's `effort` arrives in `prepare` as `call.effort`. Only an adapter that declares `efforts` is given one.

## Metering comes free

`buildProvider` wraps every provider's model, whatever its adapter, so every call is recorded: chat rounds, the
reviewer, the start-up probe, evals. A new adapter is metered without writing any metering code. It only declares
`pricing(cfg)` for the models it knows and, if its provider reports usage in an unusual way, `tokens(usage)`. See
[Costs](../operating/costs.md#metering).

## Check it

Name it in `LENSPACK_LLM_PROVIDERS` with `"kind": "my-api"`. At start-up each provider is probed; `GET /api` lists it
under `models`, and `available: true` means the key and model work. A setting that belongs to another kind is refused
at start-up, so declare your kind's own keys in `ownKeys`.

---

**Next:** [Importers](importers.md).

**Related:** [Chat models](../operating/models.md) · [Costs](../operating/costs.md)
