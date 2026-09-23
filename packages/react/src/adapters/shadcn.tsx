import * as React from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, Pie, PieChart, XAxis, YAxis } from "recharts";

import type { ChartAdapter, ChartSpec } from "../charts";

// shadcn's chart primitives are copy-paste code that lives in the host app —
// "the components are yours" — so this adapter takes them as arguments rather
// than bundling a copy. Colours come from the pack's scheme by default; pass
// `palette` to use shadcn's own --chart-n tokens instead.

type AnyComponent = React.ComponentType<any>;

export type ShadcnChartComponents = {
  ChartContainer: AnyComponent;
  ChartTooltip: AnyComponent;
  ChartTooltipContent: AnyComponent;
  ChartLegend: AnyComponent;
  ChartLegendContent: AnyComponent;
};

export type ShadcnOptions = {
  /** e.g. ["var(--chart-1)", …] to colour with shadcn's tokens. */
  palette?: string[];
  /** Extra className for ChartContainer (it must have a height). */
  className?: string;
};

// shadcn writes `--color-<key>` CSS variables from the config, so keys must be
// CSS-safe: series and slices are renamed s0…sN and labelled via the config.
function safeKeys(spec: ChartSpec, palette: string[]) {
  const map = spec.keys.map((k, i) => ({ from: k, to: `s${i}`, label: spec.label(k), color: palette[i % palette.length]! }));
  const rows = spec.rows.map((r) => {
    const out: Record<string, unknown> = { [spec.groupKey]: r[spec.groupKey] };
    for (const m of map) out[m.to] = r[m.from];
    return out;
  });
  const config = Object.fromEntries(map.map((m) => [m.to, { label: m.label, color: m.color }]));
  return { rows, map, config };
}

export function createShadcnAdapter(c: ShadcnChartComponents, opts: ShadcnOptions = {}): ChartAdapter {
  const { ChartContainer, ChartTooltip, ChartTooltipContent, ChartLegend, ChartLegendContent } = c;

  function ShadcnChart({ spec }: { spec: ChartSpec }) {
    const palette = opts.palette ?? spec.palette;
    const style = { height: "100%", width: "100%", aspectRatio: "auto" } as const;
    const tooltipFormatter = (value: unknown, name: unknown) => (
      <span style={{ display: "flex", gap: 8, justifyContent: "space-between", width: "100%" }}>
        <span>{String(name)}</span>
        <b style={{ fontVariantNumeric: "tabular-nums" }}>{spec.format(Number(value))}</b>
      </span>
    );

    if (spec.chart === "pie") {
      const slices = spec.rows.map((r, i) => ({ slice: `k${i}`, value: r.value, fill: `var(--color-k${i})` }));
      const config = Object.fromEntries(spec.rows.map((r, i) => [`k${i}`, { label: String(r[spec.groupKey]), color: palette[i % palette.length] }]));
      return (
        <ChartContainer config={config} className={opts.className} style={style}>
          <PieChart>
            <ChartTooltip content={<ChartTooltipContent nameKey="slice" formatter={tooltipFormatter} hideLabel />} />
            <Pie data={slices} dataKey="value" nameKey="slice" innerRadius="45%" outerRadius="80%" paddingAngle={1} stroke="none" />
            {spec.legend && <ChartLegend content={<ChartLegendContent nameKey="slice" />} />}
          </PieChart>
        </ChartContainer>
      );
    }

    const { rows, map, config } = safeKeys(spec, palette);
    const axes = [
      <CartesianGrid key="g" vertical={false} />,
      <XAxis key="x" dataKey={spec.groupKey} tickLine={false} axisLine={false} tickMargin={8} fontSize={11} />,
      <YAxis key="y" tickLine={false} axisLine={false} width={48} fontSize={11} tickFormatter={(v: number) => spec.format(v)} />,
      <ChartTooltip key="t" content={<ChartTooltipContent formatter={tooltipFormatter} />} />,
      ...(spec.legend && map.length > 1 ? [<ChartLegend key="l" content={<ChartLegendContent />} />] : []),
    ];
    const body =
      spec.chart === "bar" ? (
        <BarChart accessibilityLayer data={rows}>
          {axes}
          {map.map((m) => (
            <Bar key={m.to} dataKey={m.to} fill={`var(--color-${m.to})`} radius={4} />
          ))}
        </BarChart>
      ) : spec.chart === "line" ? (
        <LineChart accessibilityLayer data={rows}>
          {axes}
          {map.map((m) => (
            <Line key={m.to} dataKey={m.to} type="monotone" stroke={`var(--color-${m.to})`} strokeWidth={2} dot={false} />
          ))}
        </LineChart>
      ) : (
        <AreaChart accessibilityLayer data={rows}>
          {axes}
          {map.map((m) => (
            <Area key={m.to} dataKey={m.to} type="monotone" stroke={`var(--color-${m.to})`} fill={`var(--color-${m.to})`} fillOpacity={0.25} strokeWidth={2} />
          ))}
        </AreaChart>
      );
    return (
      <ChartContainer config={config} className={opts.className} style={style}>
        {body}
      </ChartContainer>
    );
  }

  return { name: "shadcn", Chart: ShadcnChart };
}

export default createShadcnAdapter;
