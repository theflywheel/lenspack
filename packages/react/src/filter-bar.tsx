import * as React from "react";

import { useBoard } from "./provider";
import type { FilterOption } from "./types";

// What a board filters by is configuration; what you have selected is not.
// Selections live in the provider (and, if the host wants, in the URL).
/**
 * Where a drill-down stands: All › Eastern › Chipata. Each step goes back up to
 * it; the finer levels below are cleared.
 */
export function DrillPath() {
  const { catalogue, selections, drill } = useBoard();
  const label = (key: string) => catalogue.dimensions.find((d) => d.key === key)?.label ?? key;
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

export function FilterBar() {
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

  const drilling = Object.values(catalogue.hierarchies ?? {}).some((ls) => ls.some((l) => selections[l]));
  if (filters.length === 0 && !drilling) return null;
  const active = filters.filter((f) => selections[f.field]);
  const titles = Object.fromEntries(Object.entries(board.config.widgets).map(([id, w]) => [id, w.title]));

  return (
    <div className="lp-filter-bar" data-testid="lp-filter-bar">
      <DrillPath />
      {filters.map((filter) => {
        const covers = filter.applies.includes("*") ? "everything" : filter.applies.map((id) => titles[id] ?? id).join(", ");
        return (
          <label key={filter.id} className="lp-filter" title={`Narrows ${covers}`}>
            <span className="lp-filter-label">{filter.label}</span>
            <select data-testid={`filter-${filter.field}`} value={selections[filter.field] ?? ""} onChange={(e) => setSelection(filter.field, e.target.value)}>
              <option value="">All</option>
              {(options[filter.field] ?? []).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.value} ({o.count.toLocaleString()})
                </option>
              ))}
            </select>
          </label>
        );
      })}
      {active.length > 0 && (
        <button type="button" className="lp-link" onClick={clearSelections}>
          Clear
        </button>
      )}
    </div>
  );
}
