import * as React from "react";

import { labelOf } from "./format";
import { useBoard } from "./provider";
import type { FilterOption } from "./types";

/**
 * Where a drill-down stands: All › Eastern › Chipata. Each step goes back up to
 * it; the finer levels below are cleared.
 */
export function DrillPath() {
  const { catalogue, selections, drill } = useBoard();
  const label = (key: string) => labelOf(catalogue.dimensions, key) ?? key;
  const paths = Object.entries(catalogue.hierarchies ?? {})
    .map(([name, levels]) => ({ name, levels, chosen: levels.filter((l) => selections[l]) }))
    .filter((h) => h.chosen.length > 0);
  if (paths.length === 0) return null;
  return (
    <>
      {paths.map((h) => (
        <nav key={h.name} className="lp-drill-path" aria-label={`Drill-down by ${label(h.levels[0]!)}`} data-testid={`drill-${h.name}`}>
          <button type="button" className="lp-link" onClick={() => drill(h.levels[0]!, "")}>
            All
          </button>
          {h.chosen.map((level, i) => (
            <React.Fragment key={level}>
              <span aria-hidden="true" className="lp-drill-sep">›</span>
              {i === h.chosen.length - 1 ? (
                <span className="lp-drill-here" title={label(level)} aria-current="location">{selections[level]}</span>
              ) : (
                <button type="button" className="lp-link" title={label(level)} onClick={() => drill(h.chosen[i + 1]!, "")}>
                  {selections[level]}
                </button>
              )}
            </React.Fragment>
          ))}
        </nav>
      ))}
    </>
  );
}

/**
 * Everything a filter bar needs, without the markup: the board's filters with
 * their value, options and what they narrow, whether there is anything to
 * show, and how to change or clear the selection. `<FilterBar>` draws it with
 * plain controls; a host with a design system of its own draws it with that.
 */
export function useFilters() {
  const { board, selections, setSelection, clearSelections, host, catalogue } = useBoard();
  const filters = board.config.filters;
  const [options, setOptions] = React.useState<Record<string, FilterOption[]>>({});

  React.useEffect(() => {
    if (!host.loadFilterOptions) return;
    let cancelled = false;
    for (const filter of filters) {
      void host.loadFilterOptions(filter.field).then((opts) => {
        if (!cancelled) setOptions((prev) => ({ ...prev, [filter.field]: opts }));
      });
    }
    return () => {
      cancelled = true;
    };
  }, [host, filters]);

  const titles = Object.fromEntries(Object.entries(board.config.widgets).map(([id, w]) => [id, w.title]));
  const drilling = Object.values(catalogue.hierarchies ?? {}).some((ls) => ls.some((l) => selections[l]));
  return {
    filters: filters.map((f) => ({
      ...f,
      value: selections[f.field] ?? "",
      options: options[f.field] ?? [],
      /** What the filter applies to, for a tooltip: "Narrows everything", "Narrows <widget titles>". */
      narrows: `Narrows ${f.applies.includes("*") ? "everything" : f.applies.map((id) => titles[id] ?? id).join(", ")}`,
    })),
    /** False with no filter and no drill-down: draw nothing. */
    shown: filters.length > 0 || drilling,
    /** Some filter has a value: offer Clear. */
    active: filters.some((f) => selections[f.field]),
    select: setSelection,
    clear: clearSelections,
  };
}

export function FilterBar() {
  const { filters, shown, active, select, clear } = useFilters();
  if (!shown) return null;
  return (
    <div className="lp-filter-bar" data-testid="lp-filter-bar">
      <DrillPath />
      {filters.map((filter) => (
        <label key={filter.id} className="lp-filter" title={filter.narrows}>
          <span className="lp-filter-label">{filter.label}</span>
          <select data-testid={`filter-${filter.field}`} value={filter.value} onChange={(e) => select(filter.field, e.target.value)}>
            <option value="">All</option>
            {filter.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.value} ({o.count.toLocaleString()})
              </option>
            ))}
          </select>
        </label>
      ))}
      {active && (
        <button type="button" className="lp-link" onClick={clear}>
          Clear
        </button>
      )}
    </div>
  );
}
