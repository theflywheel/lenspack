import * as React from "react";
import { Area, AreaChart, Bar, BarChart, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import type { Widget } from "@lenspack/core";

import { formatDelta, formatValue } from "./format";
import type { WidgetData } from "./types";

// Every option is mapped explicitly rather than spread from the config, which
// is what makes the schema closed in practice and not just on paper. Colours
// are CSS variables: a config names a scheme, never a colour.

const SERIES = Array.from({ length: 8 }, (_, i) => `var(--lp-series-${i + 1})`);
const SEQUENTIAL = Array.from({ length: 8 }, (_, i) => `var(--lp-sequential-${i + 1})`);

export type WidgetProps<K extends Widget["kind"]> = { widget: Extract<Widget, { kind: K }>; data?: WidgetData; currency?: string };
export type WidgetRegistry = { [K in Widget["kind"]]?: React.ComponentType<WidgetProps<K>> };

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="lp-empty">{children}</div>;
}

// A series split by a dimension arrives as long rows; recharts wants one row
// per bucket with a column per series.
function pivot(rows: WidgetData["rows"]) {
  const series = [...new Set(rows.map((r) => r.series).filter((s): s is string => s !== undefined))];
  if (series.length === 0) return { rows: rows.map((r) => ({ group: r.group, value: r.value })), keys: ["value"] };
  const byGroup = new Map<string, Record<string, number | string | null>>();
  for (const r of rows) {
    const row = byGroup.get(r.group) ?? { group: r.group };
    row[r.series!] = r.value;
    byGroup.set(r.group, row);
  }
  return { rows: [...byGroup.values()], keys: series };
}

export function ChartWidget({ widget, data, currency }: WidgetProps<"chart">) {
  if (!data) return <Empty>Loading…</Empty>;
  if (data.error) return <Empty>{data.error}{data.hint ? ` — did you mean “${data.hint}”?` : ""}</Empty>;
  const rows = data.rows.filter((r) => r.value !== null);
  if (rows.length === 0) return <Empty>Nothing to draw yet.</Empty>;
  const palette = widget.options.colorScheme === "sequential" ? SEQUENTIAL : SERIES;
  const fmt = (v: number) => formatValue(v, data.format, { currency });
  const axis = { tick: { fontSize: 11 }, tickLine: false, axisLine: false } as const;

  if (widget.chart === "pie") {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={rows} dataKey="value" nameKey="group" innerRadius="45%" outerRadius="80%" paddingAngle={1} stroke="none">
            {rows.map((row, i) => (
              <Cell key={row.group} fill={palette[i % palette.length]} />
            ))}
          </Pie>
          <Tooltip formatter={(value: number, name: string) => [fmt(value), name]} />
          {widget.options.legend && <Legend />}
        </PieChart>
      </ResponsiveContainer>
    );
  }

  const { rows: wide, keys } = pivot(rows);
  const common = { data: wide, margin: { top: 6, right: 10, bottom: 0, left: 0 } };
  // An array, not a fragment: recharts finds axes and tooltips by walking its
  // direct children, and React.Children flattens arrays but not fragments.
  const axes = [
    <XAxis key="x" dataKey="group" {...axis} />,
    <YAxis key="y" {...axis} width={48} tickFormatter={(v: number) => fmt(v)} />,
    <Tooltip key="t" formatter={(value: number) => fmt(value)} />,
    ...(widget.options.legend && keys.length > 1 ? [<Legend key="l" />] : []),
  ];

  if (widget.chart === "line")
    return (
      <ResponsiveContainer width="100%" height="100%">
        <LineChart {...common}>
          {axes}
          {keys.map((k, i) => (
            <Line key={k} type="monotone" dataKey={k} stroke={palette[i % palette.length]} strokeWidth={2} dot={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    );
  if (widget.chart === "area")
    return (
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart {...common}>
          {axes}
          {keys.map((k, i) => (
            <Area key={k} type="monotone" dataKey={k} stroke={palette[i % palette.length]} fill={palette[i % palette.length]} fillOpacity={0.25} strokeWidth={2} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    );
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart {...common}>
        {axes}
        {keys.map((k, i) => (
          <Bar key={k} dataKey={k} fill={palette[i % palette.length]} radius={[3, 3, 0, 0]} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
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
