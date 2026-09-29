import * as React from "react";

import type { ChartAdapter } from "@lenspack/react";
import { svgAdapter } from "@lenspack/react/adapters/svg";

// Four charting libraries behind one seam, each loaded the first time it is
// chosen. The board config never changes; only the adapter handed to the
// provider does, and it can change live. The zero-dependency SVG adapter is
// always present, so nothing waits on a library to draw a first frame.

export const ADAPTER_NAMES = ["recharts", "echarts", "shadcn", "svg"] as const;
export type AdapterName = (typeof ADAPTER_NAMES)[number];

const loaders: Record<AdapterName, () => Promise<ChartAdapter>> = {
  recharts: () => import("@lenspack/react/adapters/recharts").then((m) => m.rechartsAdapter),
  echarts: () => import("@lenspack/react/adapters/echarts").then((m) => m.createEchartsAdapter()),
  shadcn: () => Promise.all([import("@lenspack/react/adapters/shadcn"), import("./components/ui/chart")]).then(([m, ui]) => m.createShadcnAdapter(ui)),
  svg: () => Promise.resolve(svgAdapter),
};

const loaded = new Map<string, ChartAdapter>([["svg", svgAdapter]]);
const pending = new Map<string, Promise<ChartAdapter>>();

export const isAdapter = (name: string | null | undefined): name is AdapterName => !!name && (ADAPTER_NAMES as readonly string[]).includes(name);

export function loadAdapter(name: AdapterName): Promise<ChartAdapter> {
  const hit = loaded.get(name);
  if (hit) return Promise.resolve(hit);
  let p = pending.get(name);
  if (!p) {
    p = loaders[name]().then((a) => (loaded.set(name, a), a));
    pending.set(name, p);
  }
  return p;
}

/** The chosen adapter once loaded; until then, the one already on screen (or null on first load). */
export function useChartAdapter(name: AdapterName): ChartAdapter | null {
  const [adapter, setAdapter] = React.useState<ChartAdapter | null>(() => loaded.get(name) ?? null);
  React.useEffect(() => {
    let live = true;
    void loadAdapter(name).then((a) => live && setAdapter(a));
    return () => {
      live = false;
    };
  }, [name]);
  return adapter;
}
