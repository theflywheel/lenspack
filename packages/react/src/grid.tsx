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

/** A widget removed from the board by its ×, and the version to restore to undo it. */
export type RemovedWidget = { id: string; title: string; restore: number };

const CrossIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
  </svg>
);

export function WidgetFrame({ id, widget, registry, showQuery, onRemove }: { id: string; widget: Widget; registry: WidgetRegistry; showQuery?: boolean; onRemove?: () => void }) {
  const { data, currency } = useBoard();
  const Body = (registry[widget.kind] ?? defaultWidgets[widget.kind]) as React.ComponentType<{ widget: Widget; data?: unknown; currency?: string }>;
  return (
    <div className="lp-widget" data-widget={id} data-kind={widget.kind}>
      <div className="lp-widget-head lp-drag-handle">
        <span className="lp-widget-title">{widget.title}</span>
        {/* What this widget is actually asking for. Naming it in the frame
            keeps the vocabulary visible while someone edits the board. */}
        {showQuery && widget.kind !== "text" && <span className="lp-widget-query">{describeQuery(widget.query)}</span>}
        {data[id]?.notes?.map((n) => <span key={n} className="lp-widget-note">{n}</span>)}
      </div>
      {/* No confirmation: removing is a version like any edit, and the host offers an undo. */}
      {onRemove && (
        <button type="button" className="lp-widget-remove" aria-label={`Remove ${widget.title}`} title={`Remove ${widget.title}`} data-testid={`remove-${id}`} onClick={onRemove}>
          <CrossIcon />
        </button>
      )}
      <div className="lp-widget-body">
        <Body widget={widget} data={data[id]} currency={currency} />
      </div>
    </div>
  );
}

/** The renderer: a pure function of the board config. */
export function Board({
  widgets = {},
  emptyMessage,
  showQueries = false,
  onWidgetRemoved,
}: {
  widgets?: WidgetRegistry;
  emptyMessage?: React.ReactNode;
  showQueries?: boolean;
  /** After a widget's × removed it: the host may offer to undo (host.revertTo(restore)). */
  onWidgetRemoved?(removed: RemovedWidget): void;
}) {
  const { board, editable, saveLayout, apply, host } = useBoard();
  const config = board.config;
  const [saving, setSaving] = React.useState(false);
  // While a widget is dragged or resized the others glide out of its way;
  // otherwise they move at once (a first paint, a container that resizes).
  const [gesture, setGesture] = React.useState(false);

  // Only the authored layout is saved: dragging on a phone must not rewrite
  // the layout everyone else sees. md draws the same columns as lg, so a
  // board beside a wide chat panel is still edited in place.
  const [breakpoint, setBreakpoint] = React.useState<keyof typeof COLS>("lg");
  const authored = breakpoint === "lg" || breakpoint === "md";
  const movable = editable && !!host.saveLayout && authored;
  const removable = editable && !!host.applyOps;

  // Saved only when a person finishes a drag or a resize. The grid also
  // reports a "layout change" on mount, after compacting whatever it was
  // given — saving that turned merely opening an older version into a new one.
  const onGesture = async (layout: Layout[], summary: string) => {
    setGesture(false);
    if (!movable) return;
    const next = layout.map((item) => ({ i: item.i, x: item.x, y: item.y, w: item.w, h: item.h }));
    if (JSON.stringify(next) === JSON.stringify(config.layout)) return;
    setSaving(true);
    // A drag is an edit, so it gets a version of its own and can be rolled
    // back exactly like one made by chat.
    await saveLayout(next, summary);
    setSaving(false);
  };
  const titleOf = (id: string) => `“${config.widgets[id]?.title ?? id}”`;

  const remove = async (id: string) => {
    const restore = board.version;
    const title = config.widgets[id]?.title ?? id;
    const r = await apply([{ op: "remove_widget", id }]);
    if (r.ok) onWidgetRemoved?.({ id, title, restore });
  };

  if (config.layout.length === 0) {
    return <p className="lp-empty-board">{emptyMessage ?? "Nothing on this board yet."}</p>;
  }

  const compactMode = config.grid.density === "compact";
  return (
    <div
      className="lp-board"
      data-testid="lp-board"
      data-widgets={Object.keys(config.widgets).length}
      data-density={config.grid.density}
      data-editable={movable || undefined}
      data-gesture={gesture || undefined}
    >
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
        isDraggable={movable}
        isResizable={movable}
        draggableHandle=".lp-drag-handle"
        // The × is inside the frame, not the handle, but a press on it must never start a drag.
        draggableCancel=".lp-widget-remove"
        onBreakpointChange={(bp) => setBreakpoint(bp as keyof typeof COLS)}
        onDragStart={() => setGesture(true)}
        onResizeStart={() => setGesture(true)}
        onDragStop={(layout, from, to) => void onGesture(layout, from && to && (from.x !== to.x || from.y !== to.y) ? `moved ${titleOf(to.i)}` : "")}
        onResizeStop={(layout, _from, to) => void onGesture(layout, to ? `resized ${titleOf(to.i)}` : "")}
      >
        {config.layout.map((item) => {
          const widget = config.widgets[item.i];
          if (!widget) return <div key={item.i} />;
          return (
            <div key={item.i}>
              <WidgetFrame id={item.i} widget={widget} registry={widgets} showQuery={showQueries} onRemove={removable ? () => void remove(item.i) : undefined} />
            </div>
          );
        })}
      </Grid>
    </div>
  );
}
