import * as React from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { type ChartAdapter, type ChartSpec, axisWidth, formatBucket, formatTick, timeOf, timeTicks } from "../charts";

type TipItem = { name?: unknown; value?: unknown; color?: string; payload?: { fill?: string } };

// recharts' default tooltip is a white box whose text takes the series colour
// (light lines are unreadable on it) and whose heading takes the page's ink
// (white on white in dark mode). This one uses the board's own surface and
// ink, and keeps the series colour to a swatch.
function Tip({ active, payload, label, heading, format, name }: {
  active?: boolean;
  payload?: readonly TipItem[];
  label?: unknown;
  heading: (label: unknown) => string;
  format: (v: number) => string;
  name: (n: unknown) => string;
}) {
  const items = (payload ?? []).filter((p) => typeof p.value === "number");
  if (!active || items.length === 0) return null;
  const sorted = items.length > 1 ? [...items].sort((a, b) => Number(b.value) - Number(a.value)) : items;
  return (
    <div className="lp-chart-tip" style={{ background: "var(--lp-bg)", color: "var(--lp-fg)", border: "1px solid var(--lp-border)", borderRadius: "var(--lp-radius, 4px)", boxShadow: "0 4px 14px rgb(0 0 0 / 0.18)", padding: "8px 10px", fontSize: 12, lineHeight: "18px", minWidth: 120 }}>
      {label !== undefined && label !== "" && <div style={{ fontWeight: 600, marginBottom: 4 }}>{heading(label)}</div>}
      {sorted.map((p, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span aria-hidden style={{ width: 8, height: 8, borderRadius: 2, flex: "none", background: p.color ?? p.payload?.fill ?? "var(--lp-muted)" }} />
          <span style={{ color: "var(--lp-muted)" }}>{name(p.name)}</span>
          <span style={{ marginLeft: "auto", paddingLeft: 12, fontVariantNumeric: "tabular-nums", fontWeight: 500 }}>{format(Number(p.value))}</span>
        </div>
      ))}
    </div>
  );
}

// Every option is mapped explicitly rather than spread from the spec, which is
// what keeps the schema closed in practice and not just on paper.

function RechartsChart({ spec }: { spec: ChartSpec }) {
  const { rows, keys, palette, format } = spec;
  const axis = { tick: { fontSize: 11, fill: "var(--lp-muted)" }, tickLine: false, axisLine: false } as const;
  // The swatch carries the series; its name stays in the card's ink, at the axis's size.
  const legend = { iconSize: 8, wrapperStyle: { fontSize: 11, lineHeight: "16px" }, formatter: (name: unknown) => <span style={{ color: "var(--lp-fg)" }}>{String(name)}</span> } as const;

  if (spec.chart === "pie") {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={rows} dataKey="value" nameKey={spec.groupKey} innerRadius="52%" outerRadius="72%" paddingAngle={1} stroke="none" isAnimationActive={false} label={({ value }) => format(Number(value ?? 0))} labelLine fontSize={11}>
            {rows.map((row, i) => (
              <Cell
                key={String(row.group)}
                fill={palette[i % palette.length]}
                {...(spec.onSelect ? { onClick: () => spec.onSelect!(String(row.group)), style: { cursor: "pointer" } } : {})}
              />
            ))}
          </Pie>
          <Tooltip content={(p) => <Tip {...(p as object)} label={undefined} heading={String} format={format} name={String} />} />
          {spec.legend && <Legend {...legend} />}
        </PieChart>
      </ResponsiveContainer>
    );
  }

  // A series is drawn on a time axis, so a gap in the dates is a gap on the
  // axis (not one even step per bucket) and every tick has a mark. Bars keep
  // a category axis, one band per bucket, with the same date labels.
  const time = spec.time;
  const stamps = time ? rows.map((r) => timeOf(String(r[spec.groupKey]))) : [];
  const onTimeAxis = !!time && spec.chart !== "bar" && stamps.every(Number.isFinite);
  const multiYear = stamps.length > 0 && new Date(Math.min(...stamps)).getUTCFullYear() !== new Date(Math.max(...stamps)).getUTCFullYear();
  const data: typeof rows = onTimeAxis ? rows.map((r, i) => ({ ...r, __t: stamps[i]! })) : rows;
  const ticks = onTimeAxis ? timeTicks(Math.min(...stamps), Math.max(...stamps), time!.grain) : [];
  // Month starts read as "Jun"; a day label is wanted only when ticks fall within months.
  const monthly = ticks.length > 1 && ticks.every((t) => new Date(t).getUTCDate() === 1 && new Date(t).getUTCHours() === 0) && ticks[1]! - ticks[0]! > 20 * 86_400_000;
  const tick = (v: unknown) =>
    monthly && typeof v === "number" ? formatTick(v, "month", multiYear) : (time ? formatTick(typeof v === "number" ? v : timeOf(String(v)), time.grain, multiYear) : String(v));
  const heading = (v: unknown) => (time ? formatBucket(typeof v === "number" ? v : timeOf(String(v)), time.grain) : String(v));
  const xAxis = onTimeAxis ? (
    <XAxis key="x" dataKey="__t" type="number" scale="time" domain={["dataMin", "dataMax"]} ticks={ticks} interval={0} tickFormatter={tick} {...axis} tickLine={{ stroke: "var(--lp-border)" }} axisLine={{ stroke: "var(--lp-border)" }} minTickGap={24} />
  ) : (
    <XAxis key="x" dataKey={spec.groupKey} {...axis} {...(time ? { tickFormatter: tick, tickLine: { stroke: "var(--lp-border)" }, axisLine: { stroke: "var(--lp-border)" }, minTickGap: 16 } : {})} />
  );
  const common = { data, margin: { top: 6, right: 16, bottom: 0, left: 0 } };
  // An array, not a fragment: recharts finds axes and tooltips by walking its
  // direct children, and React.Children flattens arrays but not fragments.
  const axes = [
    ...(time ? [<CartesianGrid key="g" vertical horizontal={false} stroke="var(--lp-border)" strokeDasharray="2 3" />] : []),
    xAxis,
    <YAxis key="y" {...axis} width={axisWidth(spec)} tickFormatter={(v: number) => format(v)} />,
    <Tooltip key="t" cursor={{ stroke: "var(--lp-muted)", strokeDasharray: "3 3" }} content={(p) => <Tip {...(p as object)} heading={heading} format={format} name={(n) => String(n)} />} />,
    ...(spec.legend && keys.length > 1 ? [<Legend key="l" {...legend} />] : []),
  ];

  if (spec.chart === "line")
    return (
      <ResponsiveContainer width="100%" height="100%">
        <LineChart {...common}>
          {axes}
          {keys.map((k, i) => (
            <Line key={k} type="monotone" dataKey={k} name={spec.label(k)} stroke={palette[i % palette.length]} strokeWidth={2} dot={false} isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    );
  if (spec.chart === "area")
    return (
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart {...common}>
          {axes}
          {keys.map((k, i) => (
            <Area key={k} type="monotone" dataKey={k} name={spec.label(k)} stroke={palette[i % palette.length]} fill={palette[i % palette.length]} fillOpacity={0.22} strokeWidth={2} isAnimationActive={false} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    );
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart {...common}>
        {axes}
        {keys.map((k, i) => (
          <Bar
            key={k}
            dataKey={k}
            name={spec.label(k)}
            fill={palette[i % palette.length]}
            radius={[2, 2, 0, 0]}
            isAnimationActive={false}
            {...(spec.onSelect ? { onClick: (d: { payload?: { group?: unknown } }) => spec.onSelect!(String(d.payload?.group)), style: { cursor: "pointer" } } : {})}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

export const rechartsAdapter: ChartAdapter = { name: "recharts", Chart: RechartsChart };
export default rechartsAdapter;
