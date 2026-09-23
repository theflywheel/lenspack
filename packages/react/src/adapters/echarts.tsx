import * as React from "react";
import * as echarts from "echarts/core";
import { BarChart, LineChart, PieChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer, SVGRenderer } from "echarts/renderers";

import { type ChartAdapter, type ChartSpec, resolveCssVar } from "../charts";

// An imperative, canvas-first library behind the same seam. The palette
// arrives as CSS variables and is resolved against the mounted element, so
// the styling still lives in CSS.

echarts.use([BarChart, LineChart, PieChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer, SVGRenderer]);

export type EchartsOptions = { renderer?: "canvas" | "svg" };

function toOption(spec: ChartSpec, el: HTMLElement): echarts.EChartsCoreOption {
  const colours = spec.palette.map((p) => resolveCssVar(p, el));
  const fg = getComputedStyle(el).color || "#333";
  const groups = spec.rows.map((r) => String(r[spec.groupKey]));
  if (spec.chart === "pie") {
    return {
      color: colours,
      tooltip: { trigger: "item", valueFormatter: (v: number) => spec.format(v) },
      legend: spec.legend ? { bottom: 0, textStyle: { color: fg } } : undefined,
      series: [{ type: "pie", radius: ["45%", "80%"], data: spec.rows.map((r) => ({ name: String(r.group), value: r.value })), label: { show: false } }],
    };
  }
  const series = spec.keys.map((k) => ({
    name: spec.label(k),
    type: spec.chart === "bar" ? "bar" : "line",
    smooth: spec.chart !== "bar",
    showSymbol: false,
    areaStyle: spec.chart === "area" ? { opacity: 0.25 } : undefined,
    data: spec.rows.map((r) => (typeof r[k] === "number" ? r[k] : null)),
    itemStyle: spec.chart === "bar" ? { borderRadius: [3, 3, 0, 0] } : undefined,
  }));
  return {
    color: colours,
    grid: { left: 56, right: 12, top: 12, bottom: spec.legend && spec.keys.length > 1 ? 40 : 28 },
    tooltip: { trigger: "axis", valueFormatter: (v: number) => spec.format(v) },
    legend: spec.legend && spec.keys.length > 1 ? { bottom: 0, textStyle: { color: fg } } : undefined,
    xAxis: { type: "category", data: groups, axisTick: { show: false }, axisLine: { show: false }, axisLabel: { color: fg, fontSize: 11 } },
    yAxis: { type: "value", axisLabel: { color: fg, fontSize: 11, formatter: (v: number) => spec.format(v) }, splitLine: { lineStyle: { opacity: 0.2 } } },
    series,
  };
}

export function createEchartsAdapter(opts: EchartsOptions = {}): ChartAdapter {
  function EchartsChart({ spec }: { spec: ChartSpec }) {
    const ref = React.useRef<HTMLDivElement>(null);
    const chart = React.useRef<echarts.ECharts | null>(null);
    React.useEffect(() => {
      const el = ref.current;
      if (!el) return;
      chart.current = echarts.init(el, undefined, { renderer: opts.renderer ?? "canvas" });
      const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => chart.current?.resize()) : null;
      ro?.observe(el);
      return () => {
        ro?.disconnect();
        chart.current?.dispose();
        chart.current = null;
      };
    }, []);
    React.useEffect(() => {
      if (ref.current && chart.current) chart.current.setOption(toOption(spec, ref.current), true);
    }, [spec]);
    return <div ref={ref} className="lp-echarts" style={{ width: "100%", height: "100%" }} role="img" aria-label={spec.title} />;
  }
  return { name: "echarts", Chart: EchartsChart };
}

export const echartsAdapter = createEchartsAdapter();
export default echartsAdapter;
