import * as React from "react";
import { Area, AreaChart, Bar, BarChart, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import type { ChartAdapter, ChartSpec } from "../charts";

// Every option is mapped explicitly rather than spread from the spec, which is
// what keeps the schema closed in practice and not just on paper.

function RechartsChart({ spec }: { spec: ChartSpec }) {
  const { rows, keys, palette, format } = spec;
  const axis = { tick: { fontSize: 11 }, tickLine: false, axisLine: false } as const;

  if (spec.chart === "pie") {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={rows} dataKey="value" nameKey={spec.groupKey} innerRadius="45%" outerRadius="80%" paddingAngle={1} stroke="none">
            {rows.map((row, i) => (
              <Cell key={String(row.group)} fill={palette[i % palette.length]} />
            ))}
          </Pie>
          <Tooltip formatter={(value, name) => [format(Number(value ?? 0)), String(name)]} />
          {spec.legend && <Legend />}
        </PieChart>
      </ResponsiveContainer>
    );
  }

  const common = { data: rows, margin: { top: 6, right: 10, bottom: 0, left: 0 } };
  // An array, not a fragment: recharts finds axes and tooltips by walking its
  // direct children, and React.Children flattens arrays but not fragments.
  const axes = [
    <XAxis key="x" dataKey={spec.groupKey} {...axis} />,
    <YAxis key="y" {...axis} width={48} tickFormatter={(v: number) => format(v)} />,
    <Tooltip key="t" formatter={(value, name) => [format(Number(value ?? 0)), spec.label(String(name))]} />,
    ...(spec.legend && keys.length > 1 ? [<Legend key="l" />] : []),
  ];

  if (spec.chart === "line")
    return (
      <ResponsiveContainer width="100%" height="100%">
        <LineChart {...common}>
          {axes}
          {keys.map((k, i) => (
            <Line key={k} type="monotone" dataKey={k} name={spec.label(k)} stroke={palette[i % palette.length]} strokeWidth={2} dot={false} />
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
            <Area key={k} type="monotone" dataKey={k} name={spec.label(k)} stroke={palette[i % palette.length]} fill={palette[i % palette.length]} fillOpacity={0.25} strokeWidth={2} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    );
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart {...common}>
        {axes}
        {keys.map((k, i) => (
          <Bar key={k} dataKey={k} name={spec.label(k)} fill={palette[i % palette.length]} radius={[3, 3, 0, 0]} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

export const rechartsAdapter: ChartAdapter = { name: "recharts", Chart: RechartsChart };
export default rechartsAdapter;
