import type { BoardConfig } from "@lenspack/core";

// Renders a board config the way the demo does and returns a PNG. The demo
// server exposes a preview route that takes the config from a temporary
// board, so the screenshot is of the real renderer, real data, real charts.

export type ScreenshotOptions = { baseUrl: string; example: string; charts?: string; width?: number; height?: number; timeoutMs?: number };

export async function screenshotBoard(config: BoardConfig, opts: ScreenshotOptions): Promise<Uint8Array> {
  const { chromium } = await import("playwright");
  const res = await fetch(`${opts.baseUrl}/api/${opts.example}/boards`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ config, temporary: true }) });
  const { id } = (await res.json()) as { id: string };
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: opts.width ?? 1280, height: opts.height ?? 900 }, colorScheme: "light" });
    await page.goto(`${opts.baseUrl}/app?example=${opts.example}&board=${id}&charts=${opts.charts ?? "recharts"}&chrome=0`, { waitUntil: "networkidle", timeout: opts.timeoutMs ?? 30_000 });
    await page.waitForSelector('[data-testid="lp-board"]', { timeout: 15_000 });
    // Data loads per widget; wait until nothing says Loading and charts have drawn.
    await page.waitForFunction(() => !document.body.innerText.includes("Loading…"), null, { timeout: 15_000 }).catch(() => undefined);
    await page.waitForTimeout(1200);
    return await page.screenshot({ fullPage: true, type: "png" });
  } finally {
    await browser.close();
    await fetch(`${opts.baseUrl}/api/${opts.example}/${id}`, { method: "DELETE" }).catch(() => undefined);
  }
}
