# Importers: packs from another system

This page covers the two importers that compile another system's dashboard configuration into a Lenspack pack and
boards, and how to write one. It is for teams moving dashboards from those systems, and for developers writing an
importer of their own.

An importer reads a configuration that already says what each number means, and writes it as a pack (each number
defined once) and boards (what to draw where), with a report of what did not translate. It lives in
`packages/packs/` and uses `packBuilder` from `@lenspack/pack`.

## DIGIT DSS dashboards (`@lenspack/dss`)

Compiles DIGIT DSS dashboard configs (`ChartApiConfig.json`, and optionally `MasterDashboardConfig.json`) into a
pack, boards and a report:

```sh
lenspack dss ChartApiConfig.json --dashboards MasterDashboardConfig.json --out packs/dss
#   [--placeholders PVAR,…] [--pack name]
# writes packs/dss/pack.yaml, packs/dss/boards/<id>.json and packs/dss/report.md
```

On a 140-chart health config: 124 charts translate (48 exactly, the rest with notes), 343 drawn numbers become 118
measures, and `report.md` lists what did not translate (painless scripts, `date_range`, differences of measures) and
the 13 target and stock numbers DSS stores once per hierarchy level. The `campaign` example pack has the same index
shapes, with made-up data.

## CCRS analytics (`@lenspack/ccrs`)

Compiles a CCRS analytics KPI catalogue (KPI definitions and dashboard packs) into a pack, boards, and a skin map (a
file saying which result column fills which part of each CCRS chart), so CCRS's own dashboard components draw
Lenspack's results column for column. Its API answers CCRS's analytics
route with Lenspack: each `{ kpiId, params }` a CCRS dashboard sends becomes a Lenspack query over the compiled pack,
and each result goes back in CCRS's own envelope and column names, so CCRS's interface runs unchanged and a migration
is a change of base URL.

The caller's CCRS row scope (departments, jurisdictions, own records) goes through the same access path as every
host: it becomes the caller's scope, so every query carries it, filter-menu queries included, and no parameter or KPI
filter can drop it. A KPI whose entity cannot be narrowed by a scope dimension is refused (`OUT_OF_SCOPE`, reported
as `query_failed`) rather than failing on an unknown join. The capabilities CCRS's access route returns are the
caller's grants; with none returned (a trusted deployment), every tile is visible.

## Writing an importer

1. Read the other system's configuration and walk its charts.
2. Build the pack with `packBuilder()`: one measure per distinct number (`whereSig` helps spot two charts drawing the
   same number with the same filters), dimensions for what they group by, entities for what they read.
3. Emit each board as edit operations (`{ title, ops }`), so the same checks apply as to any other edit.
4. Write a report of everything that did not translate, and why. A number that would be computed differently is
   left out and reported, never approximated.
5. Run the result through `lenspack check`, and add the configuration's shapes to an example pack with made-up data
   so the tests cover them.

---

**Next:** [Access and policy](../access/README.md).

**Related:** [Packs](../concepts/packs.md#where-a-pack-comes-from) · [Write a pack](write-a-pack.md) · [CLI](../reference/cli.md)
