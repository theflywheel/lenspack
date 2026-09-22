import * as React from "react";

import { useBoard } from "./provider";
import type { FilterOption } from "./types";

// What a board filters by is configuration; what you have selected is not.
// Selections live in the provider (and, if the host wants, in the URL).
export function FilterBar() {
  const { board, selections, setSelection, clearSelections, host } = useBoard();
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

  if (filters.length === 0) return null;
  const active = filters.filter((f) => selections[f.field]);
  const titles = Object.fromEntries(Object.entries(board.config.widgets).map(([id, w]) => [id, w.title]));

  return (
    <div className="lp-filter-bar" data-testid="lp-filter-bar">
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
