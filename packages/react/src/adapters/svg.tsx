import * as React from "react";

import type { ChartAdapter, ChartSpec } from "../charts";

// The zero-dependency adapter: enough to render every chart kind readably,
// deterministic for tests, and the default when no library is supplied.

const W = 600;
const H = 300;
const PAD = { top: 12, right: 12, bottom: 28, left: 56 };

function scales(spec: ChartSpec) {
  const values = spec.rows.flatMap((r) => spec.keys.map((k) => (typeof r[k] === "number" ? (r[k] as number) : 0)));
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const y = (v: number) => PAD.top + innerH - ((v - min) / (max - min || 1)) * innerH;
  const x = (i: number) => PAD.left + ((i + 0.5) / spec.rows.length) * innerW;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => min + (max - min) * t);
  return { max, min, innerW, innerH, x, y, ticks };
}

function Axes({ spec, s }: { spec: ChartSpec; s: ReturnType<typeof scales> }) {
  const step = Math.max(1, Math.ceil(spec.rows.length / 8));
  return (
    <g className="lp-svg-axes" fontSize={11} fill="currentColor" opacity={0.7}>
      {s.ticks.map((t) => (
        <g key={t}>
          <line x1={PAD.left} x2={W - PAD.right} y1={s.y(t)} y2={s.y(t)} stroke="currentColor" strokeOpacity={0.12} />
          <text x={PAD.left - 6} y={s.y(t) + 4} textAnchor="end">{spec.format(t)}</text>
        </g>
      ))}
      {spec.rows.map((r, i) =>
        i % step === 0 ? (
          <text key={i} x={s.x(i)} y={H - 8} textAnchor="middle">{String(r[spec.groupKey])}</text>
        ) : null,
      )}
    </g>
  );
}

function Legend({ spec }: { spec: ChartSpec }) {
  if (!spec.legend || spec.keys.length < 2) return null;
  return (
    <div className="lp-svg-legend">
      {spec.keys.map((k, i) => (
        <span key={k}><i style={{ background: spec.palette[i % spec.palette.length] }} />{spec.label(k)}</span>
      ))}
    </div>
  );
}

function SvgChart({ spec }: { spec: ChartSpec }) {
  const s = scales(spec);
  const n = spec.rows.length;

  if (spec.chart === "pie") {
    const total = spec.rows.reduce((sum, r) => sum + (typeof r.value === "number" ? r.value : 0), 0) || 1;
    let angle = -Math.PI / 2;
    const cx = W / 2;
    const cy = H / 2;
    const R = Math.min(W, H) / 2 - 12;
    const r0 = R * 0.55;
    const arcs = spec.rows.map((r, i) => {
      const v = typeof r.value === "number" ? r.value : 0;
      const a0 = angle;
      const a1 = (angle += (v / total) * Math.PI * 2);
      const p = (a: number, rad: number) => `${cx + rad * Math.cos(a)},${cy + rad * Math.sin(a)}`;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const d = `M${p(a0, R)} A${R},${R} 0 ${large} 1 ${p(a1, R)} L${p(a1, r0)} A${r0},${r0} 0 ${large} 0 ${p(a0, r0)} Z`;
      return <path key={i} d={d} fill={spec.palette[i % spec.palette.length]}><title>{`${r.group}: ${spec.format(v)}`}</title></path>;
    });
    return (
      <div className="lp-svg-wrap">
        <svg viewBox={`0 0 ${W} ${H}`} className="lp-svg" role="img" aria-label={spec.title}>{arcs}</svg>
        <div className="lp-svg-legend">
          {spec.rows.map((r, i) => (
            <span key={i}><i style={{ background: spec.palette[i % spec.palette.length] }} />{String(r.group)}</span>
          ))}
        </div>
      </div>
    );
  }

  const seriesEls = spec.keys.map((k, si) => {
    const colour = spec.palette[si % spec.palette.length];
    const pts = spec.rows.map((r, i) => [s.x(i), s.y(typeof r[k] === "number" ? (r[k] as number) : 0)] as const);
    if (spec.chart === "bar") {
      const bw = (s.innerW / n) * 0.8 / spec.keys.length;
      return spec.rows.map((r, i) => {
        const v = typeof r[k] === "number" ? (r[k] as number) : 0;
        const x = s.x(i) - ((s.innerW / n) * 0.8) / 2 + bw * si;
        return <rect key={`${k}-${i}`} x={x} y={Math.min(s.y(v), s.y(0))} width={bw} height={Math.abs(s.y(0) - s.y(v))} fill={colour} rx={2}><title>{`${r.group} · ${spec.label(k)}: ${spec.format(v)}`}</title></rect>;
      });
    }
    const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x},${y}`).join(" ");
    const area = `${line} L${pts.at(-1)![0]},${s.y(0)} L${pts[0]![0]},${s.y(0)} Z`;
    return (
      <g key={k}>
        {spec.chart === "area" && <path d={area} fill={colour} fillOpacity={0.25} />}
        <path d={line} fill="none" stroke={colour} strokeWidth={2} />
      </g>
    );
  });

  return (
    <div className="lp-svg-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="lp-svg" role="img" aria-label={spec.title}>
        <Axes spec={spec} s={s} />
        {seriesEls}
      </svg>
      <Legend spec={spec} />
    </div>
  );
}

export const svgAdapter: ChartAdapter = { name: "svg", Chart: SvgChart };
export default svgAdapter;
