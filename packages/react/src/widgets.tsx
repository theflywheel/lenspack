import * as React from "react";

import type { Widget } from "@lenspack/core";

import { buildChartSpec } from "./charts";
import { formatDelta, formatValue } from "./format";
import { Markdown, type MarkdownClasses } from "./markdown";
import { useBoard } from "./provider";
import type { DataRow, WidgetData, WidgetPage } from "./types";

// Every option is mapped explicitly rather than spread from the config, which
// is what makes the schema closed in practice and not just on paper. Colours
// are CSS variables: a config names a scheme, never a colour.

export type WidgetProps<K extends Widget["kind"]> = { id?: string; widget: Extract<Widget, { kind: K }>; data?: WidgetData; currency?: string };
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
  const { charts, catalogue, drill, drillTarget } = useBoard();
  if (!data) return <Empty>Loading…</Empty>;
  if (data.error) return <Empty>{data.error}{data.hint ? ` — did you mean “${data.hint}”?` : ""}</Empty>;
  const measureKey = widget.query.kind === "rows" ? undefined : widget.query.measure;
  const measureLabel = catalogue.measures.find((m) => m.key === measureKey)?.label;
  const labelOf = (key: string) => catalogue.measures.find((m) => m.key === key)?.label;
  const target = widget.query.kind === "breakdown" ? drillTarget(widget.query.dimension) : null;
  const other = data.rows.find((r) => r.other)?.group;
  const onSelect = target?.selects ? (group: string) => group !== "(none)" && group !== other && drill(target.selects!, group) : undefined;
  const spec = buildChartSpec(widget, data, { currency, measureLabel, labelOf, onSelect });
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

// A cell of a table of rows: numbers in the locale's grouping, the rest as text.
const cellText = (v: unknown) => (typeof v === "number" ? formatValue(v, "number") : v === null || v === undefined ? "" : String(v));

/**
 * A table of rows that pages through its source. Page 0 is what the board
 * loaded; Prev/Next ask the host for one page, never the whole board again.
 */
function RowsTable({ id, widget, data }: { id?: string; widget: Extract<Widget, { kind: "table" }>; data: WidgetData }) {
  const { catalogue, host, selections } = useBoard();
  const query = widget.query.kind === "rows" ? widget.query : null;
  const pageSize = Math.min(widget.pageSize, query?.limit ?? widget.pageSize);
  const first = data.records ?? [];
  const [shown, setShown] = React.useState<{ page: number; records: Record<string, unknown>[]; hasNext: boolean } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  // A reload of the board (a filter, an edit) starts again at page 0.
  React.useEffect(() => {
    setShown(null);
    setProblem(null);
  }, [data]);
  const page = shown?.page ?? 0;
  const records = shown?.records ?? first.slice(0, pageSize);
  // Page 0 may have more after it when the board read more than a page, or exactly its limit.
  const hasNext = shown ? shown.hasNext : first.length > pageSize || (!!query && first.length >= query.limit);
  const pageable = !!id && !!query && !!host.loadWidgetPage;
  const go = async (to: number) => {
    if (!pageable || to < 0) return;
    // Page 0 of an ordered table is the board's own; without an order it is read again so pages line up.
    if (to === 0 && query!.orderBy) return setShown(null);
    setBusy(true);
    setProblem(null);
    try {
      const p: WidgetPage = await host.loadWidgetPage!(id!, to, selections);
      if (p.error) setProblem(p.error);
      else setShown({ page: p.page, records: p.records ?? [], hasNext: p.hasNext });
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const columns = data.columns ?? Object.keys(first[0] ?? {});
  const label = (key: string) => catalogue.dimensions.find((d) => d.key === key)?.label ?? key;
  const from = page * pageSize + 1;
  return (
    <div className="lp-table-paged">
      <div className="lp-table-wrap">
        <table className="lp-table">
          <thead>
            <tr>{columns.map((c) => <th key={c} title={c}>{label(c)}</th>)}</tr>
          </thead>
          <tbody>
            {records.map((row, i) => (
              <tr key={i}>{columns.map((c) => <td key={c} className={typeof row[c] === "number" ? "lp-num" : undefined}>{cellText(row[c])}</td>)}</tr>
            ))}
          </tbody>
        </table>
        {records.length === 0 && <Empty>{page > 0 ? "No more rows." : "No rows."}</Empty>}
      </div>
      {pageable && (page > 0 || hasNext) && (
        <div className="lp-pager" data-testid="pager">
          <button type="button" disabled={busy || page === 0} onClick={() => void go(page - 1)} aria-label="Previous page">Prev</button>
          <span className="lp-pager-range">{records.length ? `rows ${from.toLocaleString()}-${(from + records.length - 1).toLocaleString()}` : `page ${page + 1}`}</span>
          <button type="button" disabled={busy || !hasNext} onClick={() => void go(page + 1)} aria-label="Next page">Next</button>
          {problem && <span className="lp-pager-problem">{problem}</span>}
        </div>
      )}
    </div>
  );
}

export function TableWidget({ id, widget, data, currency }: WidgetProps<"table">) {
  const { catalogue, drill, drillTarget } = useBoard();
  // Click a header to sort the fetched groups by it; again to flip.
  const [sortOn, setSortOn] = React.useState<{ key: string; dir: "asc" | "desc" } | null>(null);
  const target = widget.query.kind === "breakdown" ? drillTarget(widget.query.dimension) : null;
  const rowProps = ({ group, other }: DataRow) =>
    target?.selects && group !== "(none)" && !other
      ? { className: "lp-drillable", onClick: () => drill(target.selects!, group), title: `Drill into ${group}` }
      : {};
  if (!data) return <Empty>Loading…</Empty>;
  if (data.error) return <Problem message={data.error} hint={data.hint} />;
  if (data.records) return <RowsTable id={id} widget={widget} data={data} />;
  const label = (key: string) => catalogue.measures.find((m) => m.key === key)?.label ?? key;
  const valueOf = (row: DataRow, key: string) => (key === "\u0000group" ? row.group : data.measures && key !== data.measures[0]?.key ? (row.values?.[key] ?? null) : row.value);
  const sorted = sortOn
    ? [...data.rows].sort((a, b) => {
        // The Other row stays last whatever the sort.
        if (a.other || b.other) return a.other ? 1 : -1;
        const x = valueOf(a, sortOn.key), y = valueOf(b, sortOn.key);
        const c = x === null ? 1 : y === null ? -1 : typeof x === "string" || typeof y === "string" ? String(x).localeCompare(String(y), undefined, { numeric: true }) : x - y;
        return x === null || y === null ? c : sortOn.dir === "asc" ? c : -c;
      })
    : data.rows;
  const sortHead = (key: string, text: React.ReactNode, className?: string) => (
    <th
      className={`${className ?? ""} lp-sortable`.trim()}
      aria-sort={sortOn?.key === key ? (sortOn.dir === "asc" ? "ascending" : "descending") : undefined}
      onClick={() => setSortOn((s) => (s?.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "\u0000group" ? "asc" : "desc" }))}
    >
      {text}
      {sortOn?.key === key ? (sortOn.dir === "asc" ? " ▲" : " ▼") : ""}
    </th>
  );
  // An Other row is the rest after every group, so no group is paged away from it.
  const page = data.rows.some((r) => r.other) ? sorted : sorted.slice(0, widget.pageSize);
  // A breakdown's comparison and share follow its measure's own column.
  const compared = data.rows.some((r) => r.compare);
  const shared = data.rows.some((r) => r.share !== undefined);
  const moreHeads = (
    <>
      {compared && <th className="lp-num">Previous</th>}
      {compared && <th className="lp-num">Change</th>}
      {shared && <th className="lp-num">Share</th>}
    </>
  );
  const more = (row: DataRow) => (
    <>
      {compared && <td className="lp-num lp-muted">{formatValue(row.compare?.previous ?? null, data.format, { currency })}</td>}
      {compared && <td className={`lp-num lp-delta ${(row.compare?.delta ?? 0) >= 0 ? "lp-up" : "lp-down"}`}>{formatDelta(row.compare?.delta) ?? "—"}</td>}
      {shared && <td className="lp-num">{formatValue(row.share ?? null, "percent")}</td>}
    </>
  );
  if (data.measures?.length) {
    // One column per measure, labelled from the catalogue, each in its own format.
    const dim = widget.query.kind === "breakdown" ? (target?.at ?? widget.query.dimension) : widget.query.kind === "series" ? widget.query.grain : "";
    const dimLabel = (key: string) => catalogue.dimensions.find((d) => d.key === key)?.label ?? key;
    // A table split by a second dimension shows it as its own column.
    const by = widget.query.kind === "breakdown" ? widget.query.by : undefined;
    return (
      <div className="lp-table-wrap">
        <table className="lp-table">
          <thead>
            <tr>
              {sortHead("\u0000group", dimLabel(dim))}
              {by && <th>{dimLabel(by)}</th>}
              {data.measures.map((m, i) => (
                <React.Fragment key={m.key}>
                  {sortHead(m.key, label(m.key), "lp-num")}
                  {i === 0 && moreHeads}
                </React.Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {page.map((row) => (
              <tr key={`${row.group}|${row.series ?? ""}`} {...rowProps(row)}>
                <td>{row.group}</td>
                {by && <td>{row.series ?? ""}</td>}
                {data.measures!.map((m, i) => (
                  <React.Fragment key={m.key}>
                    <td className="lp-num">{formatValue(i === 0 ? row.value : (row.values?.[m.key] ?? null), m.format, { currency })}</td>
                    {i === 0 && more(row)}
                  </React.Fragment>
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
        {(compared || shared) && (
          <thead>
            <tr>
              <th />
              <th className="lp-num">{widget.query.kind === "rows" ? "" : label(widget.query.measure)}</th>
              {moreHeads}
              <th />
            </tr>
          </thead>
        )}
        <tbody>
          {page.map((row) => (
            <tr key={`${row.group}|${row.series ?? ""}`} {...rowProps(row)}>
              <td>{row.series ? `${row.group} · ${row.series}` : row.group}</td>
              <td className="lp-num">{formatValue(row.value, data.format, { currency })}</td>
              {more(row)}
              <td className="lp-muted lp-num">n={row.count.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// A note's markdown: built as React elements, never HTML from the text.
const NOTE: MarkdownClasses = { root: "lp-text lp-md", code: "lp-md-code", heading: "lp-md-h", pre: "lp-md-pre", quote: "lp-md-quote" };

export function TextWidget({ widget }: WidgetProps<"text">) {
  return <Markdown text={widget.body} classes={NOTE} />;
}

export const defaultWidgets: Required<WidgetRegistry> = { chart: ChartWidget, kpi: KpiWidget, table: TableWidget, text: TextWidget };
