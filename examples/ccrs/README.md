# CCRS on lenspack

CCRS (egovernments/Citizen-Complaint-Resolution-System) already describes its
complaint dashboards as data: MDMS `dss.KpiDefinition` records hold each KPI's
query and visual spec, and `dss.DashboardPack` places KPIs on a 12-column
grid. This example migrates that catalog to lenspack and serves CCRS's own
dashboard UI from it, so the page looks exactly as it does today. The
analytics come from lenspack; the page's own code is unchanged.

## What is where

| | |
|---|---|
| `compile.ts` | `@lenspack/ccrs` compiles a KPI catalog into `pack.yaml`, `boards/*.json` and `skin.json` |
| `pack.yaml` | complaint facts, workflow events and daily open-state snapshots as entities; every KPI number defined once |
| `boards/` | one board per dashboard pack, on its exact grid |
| `skin.json` | each KPI's visual spec and how lenspack's result maps onto the columns CCRS's components read |
| `server.ts` | answers CCRS's analytics API (`/pgr-services/v2/analytics/*`) from lenspack; passes everything else to the CCRS deployment |

## Run it

```sh
# 1. The catalog: the one seeded in the CCRS repo, or a deployment's live MDMS export
#    (a directory with KpiDefinition.json, DashboardPack.json, DashboardConfig.json).
tsx examples/ccrs/compile.ts [catalog-dir]

# 2. A read-only connection to pgr-services' database (the analytics views
#    complaint_facts, complaint_events, complaint_open_state_daily), and the CCRS
#    deployment whose UI, login and access decisions stay authoritative.
CCRS_PG_URL=postgres://… CCRS_UPSTREAM=https://ccrs.example.org PORT=8795 \
  tsx examples/ccrs/server.ts

# 3. Open http://localhost:8795/digit-ui/public-dashboard.html
#    (or /digit-ui/employee/dashboard after signing in).
```

## How faithful it is

Checked against Bomet's live deployment:

- **Numbers:** every public KPI under 18 filter combinations (wards, complaint
  types, complaint-type tree paths, date ranges) returns the same rows, the
  same tie order and the same error codes as pgr-services.
- **Pixels:** screenshots of the public dashboard are identical at 1280, 1456
  and 1920 px, by default and after choosing a ward, a complaint type or a
  date range, with every analytics call answered by lenspack.
- **Signed in:** the supervisor dashboard, as the same employee on both sides,
  is identical to the pixel, and all 20 of its analytics results (tiles,
  prior-period deltas, sparklines, map pins, filter menus) match pgr-services
  byte for byte, with CCRS's department and jurisdiction scope applied.
- **The whole catalog:** all 40 KPIs, including the executive pack CCRS never
  shows, under 817 parameter combinations (date ranges, windows, wards, types,
  complaint-type levels 1–4 and paths, prior-period and daily-series
  companions), as a signed-in employee. 770 are byte-identical. 43 differ only
  where pgr-services' own SQL leaves the order open (unsorted queries, ties,
  an unsorted 1,000-row cap), which varies between calls on pgr-services
  itself. 4 are refused: a daily series of a KPI grouped by two dimensions,
  which CCRS's UI never asks for.

Access control stays CCRS's. A signed-in caller's capabilities come from CCRS's
own `/_access`, and their row scope (HRMS departments, jurisdictions, own
records) comes from CCRS's own resolution. lenspack applies both.

## Semantics carried over

- **Windows:** a date range in the tenant's time zone; rolling (`last_Nd`) and
  calendar (`dtd`, `wtd`, `mtd`, `qtd`, `ytd`) windows; prior period = the span
  before the range, or the previous calendar week.
- **Live tiles:** tiles that read the current open state ignore the window;
  their sparklines still follow a selected range.
- **Pinned windows:** a KPI pinned to its own period ("created today") keeps it
  under any range; its prior period is the span before it; a range that does
  not cover it answers nothing, flagged `suppressed`.
- **Complaint-type levels:** `hierLevel` (1–12) rolls types up to a level of
  the tree and drops the service group it now names; `complaintPath` narrows
  to a subtree.
- **Formatting:** ratios are rounded to four places; dates are returned as
  UTC-midnight epochs.
- **Ordering:** unsorted KPIs keep the database's grouping order, and KPIs
  sorted by a measure leave ties as the database does. This lenspack gets by
  giving Postgres the same plan (epoch windows compare the raw column).
  Rows ordered by one column break ties by the remaining columns, as
  Postgres's grouped sort does.
