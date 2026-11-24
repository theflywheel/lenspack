import { createRoot } from "react-dom/client";

import "@lenspack/react/styles.css";
import "./fonts.css";
import "./tokens.css";

import { App } from "./app";

createRoot(document.getElementById("root")!).render(<App />);
