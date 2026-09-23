import * as React from "react";
import { createRoot } from "react-dom/client";

import type { ChartAdapter } from "@lenspack/react";
import { createEchartsAdapter } from "@lenspack/react/adapters/echarts";
import { rechartsAdapter } from "@lenspack/react/adapters/recharts";
import { createShadcnAdapter } from "@lenspack/react/adapters/shadcn";
import { svgAdapter } from "@lenspack/react/adapters/svg";
import "@lenspack/react/styles.css";
import "./tailwind.css";

import { App } from "./app";
import * as shadcn from "./components/ui/chart";
import { Landing } from "./landing";

// Four charting libraries behind one seam. The board config never changes;
// only the adapter handed to the provider does, and it can change live.
const ADAPTERS: Record<string, ChartAdapter> = {
  recharts: rechartsAdapter,
  echarts: createEchartsAdapter(),
  shadcn: createShadcnAdapter(shadcn, { palette: ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"] }),
  svg: svgAdapter,
};

const Root = () => (location.pathname.startsWith("/app") ? <App adapters={ADAPTERS} /> : <Landing adapters={ADAPTERS} />);
createRoot(document.getElementById("root")!).render(<Root />);
