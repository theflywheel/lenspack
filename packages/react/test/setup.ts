import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(cleanup);

// recharts' ResponsiveContainer and react-grid-layout measure the DOM; jsdom
// has no layout, so give them a ResizeObserver that never fires.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= ResizeObserverStub;

// echarts measures text on a 2D context even with the SVG renderer; jsdom has
// no canvas, so hand it a context whose every method is a harmless no-op.
if (typeof HTMLCanvasElement !== "undefined") {
  HTMLCanvasElement.prototype.getContext = function () {
    return new Proxy({} as Record<string, unknown>, {
      get: (target, key) => (key === "measureText" ? () => ({ width: 10 }) : key in target ? target[key as string] : () => undefined),
      set: (target, key, value) => ((target[key as string] = value), true),
    }) as never;
  } as never;
}
