import * as React from "react";
import { createRoot } from "react-dom/client";

import "@lenspack/react/styles.css";
import "./fonts.css";
import "./tokens.css";

import { isAdapter, loadAdapter } from "./adapters";

// The landing page and the app are separate chunks, and so is every charting
// library: a visitor downloads what the page in front of them draws.
const App = React.lazy(() => import("./app").then((m) => ({ default: m.App })));
const Landing = React.lazy(() => import("./landing").then((m) => ({ default: m.Landing })));

// Start fetching the chart library the URL asks for alongside the page chunk.
const wanted = new URLSearchParams(location.search).get("charts");
void loadAdapter(isAdapter(wanted) ? wanted : "recharts");

const Root = () => (
  <React.Suspense fallback={null}>{location.pathname.startsWith("/app") ? <App /> : <Landing />}</React.Suspense>
);
createRoot(document.getElementById("root")!).render(<Root />);
