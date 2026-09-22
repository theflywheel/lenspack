import * as React from "react";
import GridLayout, { WidthProvider, type Layout } from "react-grid-layout";

import type { Widget } from "@lenspack/core";

import { useBoard } from "./provider";
import { type WidgetRegistry, defaultWidgets } from "./widgets";

const Grid = WidthProvider(GridLayout);

export function WidgetFrame({ id, widget, registry }: { id: string; widget: Widget; registry: WidgetRegistry }) {
  const { data, currency } = useBoard();
  const Body = (registry[widget.kind] ?? defaultWidgets[widget.kind]) as React.ComponentType<{ widget: Widget; data?: unknown; currency?: string }>;
  return (
    <div className="lp-widget" data-widget={id} data-kind={widget.kind}>
      <div className="lp-widget-title lp-drag-handle">{widget.title}</div>
      <div className="lp-widget-body">
        <Body widget={widget} data={data[id]} currency={currency} />
      </div>
    </div>
  );
}

/** The renderer: a pure function of the board config. */
export function Board({ widgets = {}, emptyMessage }: { widgets?: WidgetRegistry; emptyMessage?: React.ReactNode }) {
  const { board, editable, saveLayout, host } = useBoard();
  const config = board.config;
  const [saving, setSaving] = React.useState(false);

  const onLayoutChange = async (layout: Layout[]) => {
    if (!editable || !host.saveLayout) return;
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

  return (
    <div className="lp-board" data-testid="lp-board" data-widgets={Object.keys(config.widgets).length}>
      {saving && <div className="lp-saving">Saving layout…</div>}
      <Grid
        className="layout"
        layout={config.layout as Layout[]}
        cols={config.grid.cols}
        rowHeight={config.grid.rowHeight}
        margin={[12, 12]}
        compactType="vertical"
        isDraggable={editable && !!host.saveLayout}
        isResizable={editable && !!host.saveLayout}
        draggableHandle=".lp-drag-handle"
        onLayoutChange={onLayoutChange}
      >
        {config.layout.map((item) => {
          const widget = config.widgets[item.i];
          if (!widget) return <div key={item.i} />;
          return (
            <div key={item.i}>
              <WidgetFrame id={item.i} widget={widget} registry={widgets} />
            </div>
          );
        })}
      </Grid>
    </div>
  );
}
