import * as React from "react";
import { Responsive, WidthProvider, type Layout } from "react-grid-layout";

import { type Widget, describeQuery } from "@lenspack/core";

import { useBoard } from "./provider";
import { type WidgetRegistry, defaultWidgets } from "./widgets";

const Grid = WidthProvider(Responsive);

// A board authored on a wide screen is unreadable as twelve columns on a
// phone. Below `md` the grid collapses to a single column and every widget
// takes the full width, in the order the author laid them out.
const BREAKPOINTS = { lg: 1000, md: 680, sm: 480, xs: 0 };
const COLS = { lg: 12, md: 12, sm: 6, xs: 1 };

export function narrowLayout(layout: Layout[], cols: number): Layout[] {
  return [...layout]
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .reduce<Layout[]>((acc, item) => {
      const y = acc.reduce((max, prev) => Math.max(max, prev.y + prev.h), 0);
      acc.push({ ...item, x: 0, y, w: cols, h: item.h });
      return acc;
    }, []);
}

export function WidgetFrame({ id, widget, registry, showQuery }: { id: string; widget: Widget; registry: WidgetRegistry; showQuery?: boolean }) {
  const { data, currency } = useBoard();
  const Body = (registry[widget.kind] ?? defaultWidgets[widget.kind]) as React.ComponentType<{ widget: Widget; data?: unknown; currency?: string }>;
  return (
    <div className="lp-widget" data-widget={id} data-kind={widget.kind}>
      <div className="lp-widget-head lp-drag-handle">
        <span className="lp-widget-title">{widget.title}</span>
        {/* What this widget is actually asking for. Naming it in the frame
            keeps the vocabulary visible while someone edits the board. */}
        {showQuery && widget.kind !== "text" && <span className="lp-widget-query">{describeQuery(widget.query)}</span>}
      </div>
      <div className="lp-widget-body">
        <Body widget={widget} data={data[id]} currency={currency} />
      </div>
    </div>
  );
}

/** The renderer: a pure function of the board config. */
export function Board({ widgets = {}, emptyMessage, showQueries = false }: { widgets?: WidgetRegistry; emptyMessage?: React.ReactNode; showQueries?: boolean }) {
  const { board, editable, saveLayout, host } = useBoard();
  const config = board.config;
  const [saving, setSaving] = React.useState(false);

  // Only the authored breakpoint is saved: dragging on a phone must not
  // rewrite the layout everyone else sees.
  const [breakpoint, setBreakpoint] = React.useState<keyof typeof COLS>("lg");

  const onLayoutChange = async (layout: Layout[]) => {
    if (!editable || !host.saveLayout || breakpoint !== "lg") return;
    const next = layout.map((item) => ({ i: item.i, x: item.x, y: item.y, w: item.w, h: item.h }));
    if (JSON.stringify(next) === JSON.stringify(config.layout)) return;
    setSaving(true);
    // A drag is an edit, so it gets a version of its own and can be rolled
    // back exactly like one made by chat.
    await saveLayout(next);
    setSaving(false);
  };

  if (config.layout.length === 0) {
    return <p className="lp-empty-board">{emptyMessage ?? "Nothing on this board yet."}</p>;
  }

  const compactMode = config.grid.density === "compact";
  return (
    <div className="lp-board" data-testid="lp-board" data-widgets={Object.keys(config.widgets).length} data-density={config.grid.density}>
      {saving && <div className="lp-saving">Saving layout…</div>}
      <Grid
        className="layout"
        layouts={{
          lg: config.layout as Layout[],
          md: config.layout as Layout[],
          sm: narrowLayout(config.layout as Layout[], COLS.sm),
          xs: narrowLayout(config.layout as Layout[], COLS.xs),
        }}
        breakpoints={BREAKPOINTS}
        cols={{ ...COLS, lg: config.grid.cols, md: config.grid.cols }}
        rowHeight={compactMode ? Math.round(config.grid.rowHeight * 0.75) : config.grid.rowHeight}
        margin={compactMode ? [6, 6] : [12, 12]}
        containerPadding={[0, 0]}
        compactType="vertical"
        isDraggable={editable && !!host.saveLayout && breakpoint === "lg"}
        isResizable={editable && !!host.saveLayout && breakpoint === "lg"}
        draggableHandle=".lp-drag-handle"
        onBreakpointChange={(bp) => setBreakpoint(bp as keyof typeof COLS)}
        onLayoutChange={onLayoutChange}
      >
        {config.layout.map((item) => {
          const widget = config.widgets[item.i];
          if (!widget) return <div key={item.i} />;
          return (
            <div key={item.i}>
              <WidgetFrame id={item.i} widget={widget} registry={widgets} showQuery={showQueries} />
            </div>
          );
        })}
      </Grid>
    </div>
  );
}
