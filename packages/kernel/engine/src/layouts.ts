import { type BoardConfig, type Filter, type Widget, boardConfigSchema } from "@lenspack/core";
import type { Pack } from "@lenspack/pack";

import type { Capabilities, Ctx } from "./resolve";
import { checkOps } from "./run";

// A saved layout put on another board (or back on its own): which of its widgets the board can take, for
// the person applying it. A widget whose measures or datasets the pack no longer has, or the person may not
// use, is left out and named; so is one that stood for a host chart Lenspack cannot redraw, unless the
// board already has that very chart. Nothing here writes: the caller saves the result as one change.

export type SkippedWidget = { id: string; title: string; why: string };

export type FittedLayout = {
  config: BoardConfig;
  skipped: SkippedWidget[];
  /** Filters left out (on a key the person may not use, or a host filter of another dashboard). */
  skippedFilters: { label: string; why: string }[];
  /** The saved layout was written against another version of the pack. */
  packChanged: boolean;
  /** How many of the saved layout's widgets the board takes, of how many, and how many of those left out are host charts that stay with their own dashboard. */
  carried: { widgets: number; of: number; stayed: number };
};

export type FitOptions = {
  ctx?: Ctx;
  capabilities?: Capabilities;
  /** Widgets of the saved layout that stood for host charts (never copied as text). */
  savedLocked?: string[];
  /** Widgets of the board that are host charts Lenspack keeps as they are. */
  targetLocked?: string[];
};

/**
 * The board as it would be with a saved layout applied: the saved widgets, grid, layout and filters, under
 * the board's own title and pack, less what this board or this person cannot take.
 */
export function fitSavedLayout(saved: BoardConfig, target: BoardConfig, pack: Pack, o: FitOptions = {}): FittedLayout {
  const savedLocked = new Set(o.savedLocked ?? []);
  const targetLocked = new Set(o.targetLocked ?? []);
  const skipped: SkippedWidget[] = [];
  let stayed = 0;
  const widgets: Record<string, Widget> = {};
  // A saved widget id that names a host chart on this board would take that chart over: it gets a new id.
  const rename = new Map<string, string>();
  const taken = new Set([...Object.keys(target.widgets), ...Object.keys(saved.widgets)]);
  const fresh = (id: string) => {
    let k = `${id.slice(0, 34)}-l`;
    for (let i = 2; taken.has(k); i++) k = `${id.slice(0, 34)}-l${i}`;
    taken.add(k);
    return k;
  };
  for (const [id, w] of Object.entries(saved.widgets)) {
    if (savedLocked.has(id)) {
      // The very chart is on this board (the layout came from here): it stays as the board has it.
      if (targetLocked.has(id) && target.widgets[id]) widgets[id] = target.widgets[id]!;
      else {
        skipped.push({ id, title: w.title, why: "it is a chart made in Superset, which the assistant can't redraw, so it stays with the dashboard it was made on" });
        stayed++;
      }
      continue;
    }
    const checked = checkOps([{ op: "add_widget", id, widget: w } as never], pack, { ctx: o.ctx, capabilities: o.capabilities });
    if (!checked.ok) {
      skipped.push({ id, title: w.title, why: checked.error });
      continue;
    }
    const key = targetLocked.has(id) ? fresh(id) : id;
    if (key !== id) rename.set(id, key);
    widgets[key] = w;
  }
  const layout = saved.layout.flatMap((l) => {
    const key = rename.get(l.i) ?? l.i;
    return widgets[key] ? [{ ...l, i: key }] : [];
  });
  const hidden = o.ctx?.hidden;
  const skippedFilters: FittedLayout["skippedFilters"] = [];
  const filters: Filter[] = [];
  for (const f of saved.filters) {
    if (f.type === "host" && !target.filters.some((t) => t.id === f.id)) {
      skippedFilters.push({ label: f.label, why: "it is a Superset filter of the dashboard the layout came from" });
      continue;
    }
    if (f.field && f.field !== "time" && f.type !== "host" && (hidden?.has(f.field) || !pack.dimensions.some((d) => d.key === f.field))) {
      skippedFilters.push({ label: f.label, why: `its field "${f.field}" is not one you can use here` });
      continue;
    }
    const applies = f.applies.includes("*") ? ["*"] : f.applies.map((a) => rename.get(a) ?? a).filter((a) => widgets[a]);
    if (!applies.length) {
      skippedFilters.push({ label: f.label, why: "none of the charts it applied to could be applied" });
      continue;
    }
    filters.push({ ...f, applies });
  }
  const config = boardConfigSchema.parse({ ...saved, pack: pack.pack, packVersion: pack.version, title: target.title, layout, widgets, filters });
  return { config, skipped, skippedFilters, packChanged: saved.pack !== pack.pack || saved.packVersion !== pack.version, carried: { widgets: Object.keys(widgets).length, of: Object.keys(saved.widgets).length, stayed } };
}
