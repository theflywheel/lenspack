import * as React from "react";

import type { Widget } from "@lenspack/core";

import { buildChartSpec } from "./charts";
import { formatDelta, formatValue } from "./format";
import { useBoard } from "./provider";
import type { WidgetData } from "./types";

// Every option is mapped explicitly rather than spread from the config, which
// is what makes the schema closed in practice and not just on paper. Colours
// are CSS variables: a config names a scheme, never a colour.

export type WidgetProps<K extends Widget["kind"]> = { widget: Extract<Widget, { kind: K }>; data?: WidgetData; currency?: string };
export type WidgetRegistry = { [K in Widget["kind"]]?: React.ComponentType<WidgetProps<K>> };

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="lp-empty">{children}</div>;
}

// The chart widget is library-agnostic: it builds a ChartSpec and hands it to
// whichever adapter the provider holds (svg when none is given).
export function ChartWidget({ widget, data, currency }: WidgetProps<"chart">) {
  const { charts, catalogue } = useBoard();
  if (!data) return <Empty>Loading…</Empty>;
  if (data.error) return <Empty>{data.error}{data.hint ? ` — did you mean “${data.hint}”?` : ""}</Empty>;
  const measureKey = widget.query.kind === "rows" ? undefined : widget.query.measure;
  const measureLabel = catalogue.measures.find((m) => m.key === measureKey)?.label;
  const spec = buildChartSpec(widget, data, { currency, measureLabel });
  if (!spec) return <Empty>Nothing to draw yet.</Empty>;
  const Chart = charts.Chart;
  return <Chart spec={spec} />;
}

export function KpiWidget({ widget, data, currency }: WidgetProps<"kpi">) {
  if (!data) return <Empty>Loading…</Empty>;
  if (data.error) return <Empty>{data.error}</Empty>;
  const values = data.rows.map((r) => r.value ?? 0);
  const value =
    values.length === 0
      ? null
      : widget.query.kind !== "series"
        ? (data.rows[0]?.value ?? null)
        : widget.aggregate === "sum"
          ? values.reduce((a, b) => a + b, 0)
          : widget.aggregate === "avg"
            ? values.reduce((a, b) => a + b, 0) / values.length
            : widget.aggregate === "max"
              ? Math.max(...values)
              : widget.aggregate === "min"
                ? Math.min(...values)
                : widget.aggregate === "count"
                  ? values.length
                  : values.at(-1)!;
  const delta = formatDelta(data.compare?.delta);
  return (
    <div className="lp-kpi">
      <div className="lp-kpi-value" data-testid="kpi-value">{formatValue(value, widget.format ?? data.format, { currency })}</div>
      <div className="lp-kpi-sub">
        {delta && <span className={`lp-delta ${(data.compare?.delta ?? 0) >= 0 ? "lp-up" : "lp-down"}`}>{delta} vs previous</span>}
        {!delta && data.total > 0 && <span>{data.total.toLocaleString()} rows</span>}
      </div>
    </div>
  );
}

export function TableWidget({ widget, data, currency }: WidgetProps<"table">) {
  if (!data) return <Empty>Loading…</Empty>;
  if (data.error) return <Empty>{data.error}</Empty>;
  if (data.records) {
    const columns = data.columns ?? Object.keys(data.records[0] ?? {});
    return (
      <div className="lp-table-wrap">
        <table className="lp-table">
          <thead>
            <tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr>
          </thead>
          <tbody>
            {data.records.slice(0, widget.pageSize).map((row, i) => (
              <tr key={i}>{columns.map((c) => <td key={c}>{String(row[c] ?? "")}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <div className="lp-table-wrap">
      <table className="lp-table">
        <tbody>
          {data.rows.slice(0, widget.pageSize).map((row) => (
            <tr key={`${row.group}|${row.series ?? ""}`}>
              <td>{row.series ? `${row.group} · ${row.series}` : row.group}</td>
              <td className="lp-num">{formatValue(row.value, data.format, { currency })}</td>
              <td className="lp-muted lp-num">n={row.count.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TextWidget({ widget }: WidgetProps<"text">) {
  // A text node, never markup.
  return <p className="lp-text">{widget.body}</p>;
}

export const defaultWidgets: Required<WidgetRegistry> = { chart: ChartWidget, kpi: KpiWidget, table: TableWidget, text: TextWidget };
