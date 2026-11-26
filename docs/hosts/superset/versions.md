# Superset versions

This page lists the Superset versions Lenspack supports and what differs between them, including the content
security policy and a ClickHouse fix. It is for whoever runs or upgrades Superset.

**Superset 6.1** is the version Lenspack is built for. **Superset 5.0** still works, and is tested the same way.
Superset 6.0 sits between the two and has not been tested.

Lenspack reads Superset's version when it starts and prints it (`Superset 6.1.0; maps drawn on …`). It asks the
plugin first (`/api/v1/lenspack/version`), then Superset 6.1's own `/version`; with neither, it assumes 5.

## What differs

| | Superset 6.1 | Superset 5.0 |
|---|---|---|
| Maps' default basemap | OpenStreetMap streets, no key needed. `overlay.mapStyle` may name a Mapbox style, a `tile://` URL or an OpenStreetMap URL | Mapbox light (`mapbox://styles/mapbox/light-v9`), which needs Superset's `MAPBOX_API_KEY`. `overlay.mapStyle` must be a Mapbox style |
| How Superset draws a map | through the chart-data API, from the chart's settings | through its older `explore_json` path, from the chart's settings |
| Settings → AI assistant | its own page frame, with a link back to Superset, light or dark as Superset is (Superset 6 has no server-drawn pages left to borrow) | inside Superset's server-drawn page |
| Dark theme | the chat button, window and settings page follow it | Superset 5 has none |
| Charts as Superset returns them | each setting's keys in alphabetical order; Lenspack compares settings by value, so this changes nothing | as saved |
| ClickHouse | needs `clickhouse-connect` 0.13 or later; the plugin puts back a column-name suffix (below) | `clickhouse-connect` 0.8 or later |
| Filter bar | also keeps "chart customizations" and a timestamp switch beside the filters; Lenspack leaves both untouched | |
| Dashboard roles | the same grant as 5.0; drill to detail and drill by read the same datasets, so they add nothing | |

Everything else Lenspack uses is the same on both: the chart-data requests and their post-processing steps, the
chart settings for every chart type it writes, native filters, dashboard layouts, row-level security and dataset
permissions. Flask-AppBuilder's shared-filter fault is still there in Superset 6.1, so the plugin keeps its fix.

## The content security policy

The chat button's script carries the page's nonce, which Superset 6.1's stricter Content-Security-Policy requires.
The admin panel works with Superset's default policy too: the plugin stamps the page's nonce on the panel's scripts
as it passes the page on. You do not need to loosen Superset's policy.

## ClickHouse column names on Superset 6.1

Up to 6.0, Superset gave every column in a ClickHouse query a short suffix (`SUM(x) AS x_9dd4e4`) and renamed the
results back. Superset 6.1 dropped the suffix ([apache/superset#38280](https://github.com/apache/superset/pull/38280),
in `superset/db_engine_specs/clickhouse.py`).

ClickHouse lets one column of a query refer to another by its name, so a saved metric named like the column it adds
up (`SUM(x)` saved as `x`) now hides that column: another metric in the same chart that uses `x`, such as
`SUM(x) / COUNT(*)`, adds up the first metric instead, and ClickHouse refuses the query (error 184, an aggregate
function inside another).

**The plugin puts the suffix back** when Superset starts. Results keep their names, so charts and Lenspack see no
change. With `LENSPACK_CLICKHOUSE_LABEL_SUFFIX=off`, Superset 6.1's own names stay; then rename such metrics
(`x_total`, say) so that no metric is named like a column.

One thing 6.1's change had made work goes back to how it was on 5.0: in Superset's own Explore, a heatmap with weeks
or months on its axis fails on ClickHouse (Lenspack never writes one).

## Tests on both versions

The plugin's tests run in Superset's image, once for each supported version:
[`test_lenspack_superset.py`](../../../packages/hosts/superset/plugin/test_lenspack_superset.py) has the command for
each. The access suite runs Lenspack against real Superset 6.1 and 5.0; see
[How access is tested](../../access/testing.md).

---

**Next:** [Upgrading](upgrading.md).

**Related:** [What Superset 6 could add](roadmap.md) · [SQL databases: ClickHouse](../../sources/sql.md#clickhouse)
