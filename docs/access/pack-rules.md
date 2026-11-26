# Pack access rules

This page covers the rules a deployment writes in `lenspack.yaml` to decide, by role, who may open each pack, which of
its keys they may use, and which rows. It is for operators of the standalone server. Inside Superset, Superset's own
access does this job; see [Access inside Superset](superset.md).

## Writing rules

Each pack in `lenspack.yaml` may carry `access:` rules. The first rule whose `roles` the caller has decides; a caller no rule matches does not see the pack at all (404, as if absent). A pack without rules is open to everyone signed in.

```yaml
packs:
  - pack: ./support.pack.yaml
    source: warehouse
    access:
      - roles: [staff]                                  # everything
      - roles: [partner]
        hide: [customer_phone, message_text]            # every other key
        scope: [{ dimension: region, op: eq, value: north }]
      - roles: [auditor]
        only: [region, week, tickets_opened]            # these keys and no others
```

- `hide` names dimensions and measures the caller may not use; `only` names the ones they may. A measure computed from a hidden one (derived, or a per-level measure) is hidden with it. A key the pack does not have stops the server at startup, so a typo cannot leave a key showing.
- A measure over the same column as a hidden dimension is not hidden by itself: a distinct count of it is an aggregate, but a `min` or `max` of a text column returns its values. Hide such measures too, or prefer `only`.
- `scope` adds row filters to every query the caller runs, like a principal's own scope. It may filter on a hidden key: the server set it, not the caller.

Put the most trusted rule first. A rule with `roles: ["*"]` matches everyone signed in, so it makes a good last rule.

## Where it is enforced

Resolution refuses any query that names a hidden key (`NOT_PERMITTED`), whatever built it: a board widget, a board filter or selection, a filter menu, explain, the chat's tools. Every path to a source goes through it, so nothing is compiled or run over a hidden key. On top of that, everything that describes the pack leaves hidden keys out:

- the catalogue in every API response, its hierarchies cut above the first hidden level (a drill never steps into one), and suggestions in refusals;
- the chat model's prompt (catalogue and the pack's examples) and its `list_metrics` tool; `run_sql` is refused for such a caller, as raw SQL does not pass through the pack;
- the pack file (`GET /api/<pack>/pack`), which is refused to a caller with any hidden key, and the compiled statement, which reads like it: explain leaves it out, and so do the chat's `query` and `explain` tools.

A board that has a widget on a hidden key still opens: that widget draws as "not available to you" and the rest as usual. This holds for shared boards and for a copy of one. In every board config and version sent to such a caller, a widget filter on a hidden key keeps its key and shows its value as `(hidden)`, and so does a board filter's default selection. That is the only view of a board such a caller gets: a copy they make stores it (the value is not saved under their name), and the chat model's prompt, its tools' results and the reviewer read the board the same way. Titles and text widgets are what their authors wrote: they are shown as written.

Hidden keys are kept from use, not secret as names: a widget error names its key, and explain answers a hidden key differently from an unknown one.

Pack descriptions, instructions and hints are shown to everyone who may open the pack: keep values out of them.

## Why rules live in `lenspack.yaml`

Access rules live in the deployment's config, not in the pack, because role names belong to a deployment and one
pack serves several.

---

**Next:** [Row scope and tenancy](scope-and-tenancy.md).

**Related:** [Who sees what](README.md) · [Configuration reference](../reference/config.md#packs) · [Refusal codes](../reference/errors.md)
