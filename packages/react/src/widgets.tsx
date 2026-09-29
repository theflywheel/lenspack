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

/**
 * A widget the compiler would not build. It gets the same treatment as a
 * refusal anywhere else — the reason in full, and the nearest key that does
 * exist — rather than an apology in grey.
 */
function Problem({ message, hint }: { message: string; hint?: string }) {
  return (
    <div className="lp-problem">
      <p className="lp-problem-reason">{message}</p>
      {hint && (
        <p className="lp-problem-hint">
          nearest key that exists: <code>{hint}</code>
        </p>
      )}
    </div>
  );
}

// The chart widget is library-agnostic: it builds a ChartSpec and hands it to
// whichever adapter the provider holds (svg when none is given).
export function ChartWidget({ widget, data, currency }: WidgetProps<"chart">) {
  const { charts, catalogue } = useBoard();
  if (!data) return <Empty>Loading…</Empty>;
  if (data.error) return <Empty>{data.error}{data.hint ? ` — did you mean “${data.hint}”?` : ""}</Empty>;
  const measureKey = widget.query.kind === "rows" ? undefined : widget.query.measure;
  const measureLabel = catalogue.measures.find((m) => m.key === measureKey)?.label;
  const labelOf = (key: string) => catalogue.measures.find((m) => m.key === key)?.label;
  const spec = buildChartSpec(widget, data, { currency, measureLabel, labelOf });
  if (!spec) return <Empty>Nothing to draw yet.</Empty>;
  const Chart = charts.Chart;
  return <Chart spec={spec} />;
}

export function KpiWidget({ widget, data, currency }: WidgetProps<"kpi">) {
  const { catalogue } = useBoard();
  const labelOf = (key: string) => catalogue.measures.find((m) => m.key === key)?.label ?? key;
  if (!data) return <Empty>Loading…</Empty>;
  if (data.error) return <Problem message={data.error} hint={data.hint} />;
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
  const more = widget.query.kind === "value" ? (data.measures ?? []).slice(1) : [];
  return (
    <div className="lp-kpi">
      <div className="lp-kpi-value" data-testid="kpi-value">{formatValue(value, widget.format ?? data.format, { currency })}</div>
      <div className="lp-kpi-sub">
        {delta && <span className={`lp-delta ${(data.compare?.delta ?? 0) >= 0 ? "lp-up" : "lp-down"}`}>{delta} vs previous</span>}
        {!delta && !more.length && data.total > 0 && <span>{data.total.toLocaleString()} rows</span>}
      </div>
      {more.length > 0 && (
        <dl className="lp-kpi-more">
          {more.map((m) => (
            <div key={m.key}>
              <dt>{labelOf(m.key)}</dt>
              <dd className="lp-num">{formatValue(data.rows[0]?.values?.[m.key] ?? null, m.format, { currency })}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

export function TableWidget({ widget, data, currency }: WidgetProps<"table">) {
  const { catalogue } = useBoard();
  if (!data) return <Empty>Loading…</Empty>;
  if (data.error) return <Problem message={data.error} hint={data.hint} />;
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
  if (data.measures?.length) {
    // One column per measure, labelled from the catalogue, each in its own format.
    const dim = widget.query.kind === "breakdown" ? widget.query.dimension : widget.query.kind === "series" ? widget.query.grain : "";
    const label = (key: string) => catalogue.measures.find((m) => m.key === key)?.label ?? key;
    return (
      <div className="lp-table-wrap">
        <table className="lp-table">
          <thead>
            <tr>
              <th>{catalogue.dimensions.find((d) => d.key === dim)?.label ?? dim}</th>
              {data.measures.map((m) => <th key={m.key} className="lp-num">{label(m.key)}</th>)}
            </tr>
          </thead>
          <tbody>
            {data.rows.slice(0, widget.pageSize).map((row) => (
              <tr key={`${row.group}|${row.series ?? ""}`}>
                <td>{row.group}</td>
                {data.measures!.map((m, i) => (
                  <td key={m.key} className="lp-num">{formatValue(i === 0 ? row.value : (row.values?.[m.key] ?? null), m.format, { currency })}</td>
                ))}
              </tr>
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
