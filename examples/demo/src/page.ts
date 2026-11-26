// How the server that serves this page wants it shown (lenspack.yaml `ui:`),
// written into the page as window.__lenspackUi. Absent, as on a static host: defaults.
// assistant is the assistant's name (brand.name), there only when the deployment renamed it.
export type Page = { title?: string; home?: string; intro?: string; assistant?: string };

/** What the page calls the assistant: the deployment's name for it, else lenspack. */
export const assistantName = () => page.assistant ?? "lenspack";

export const page: Page = (window as unknown as { __lenspackUi?: Page }).__lenspackUi ?? {};
