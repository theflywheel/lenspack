// How the server that serves this page wants it shown (lenspack.yaml `ui:`),
// written into the page as window.__lenspackUi. Absent, as on a static host: defaults.
export type Page = { title?: string; home?: string; intro?: string };

export const page: Page = (window as unknown as { __lenspackUi?: Page }).__lenspackUi ?? {};
