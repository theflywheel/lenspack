// How the server that serves this page wants it shown (lenspack.yaml `ui:`),
// written into the page as window.__lenspackUi. Absent, as on a static host:
// the demo.
export type Page = { mode: "demo" | "app"; title?: string; home?: string };

export const page: Page = (window as unknown as { __lenspackUi?: Page }).__lenspackUi ?? { mode: "demo" };
/** The boards at "/", without the demo's landing page, chart switch, ops box and query captions. */
export const appMode = page.mode === "app";
