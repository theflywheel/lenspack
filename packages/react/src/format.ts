import type { WidgetData } from "./types";

export function formatValue(value: number | null | undefined, format: WidgetData["format"], opts: { currency?: string; locale?: string } = {}) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const locale = opts.locale;
  switch (format) {
    case "percent":
      return `${(value * 100).toLocaleString(locale, { maximumFractionDigits: Math.abs(value) < 0.01 ? 2 : 1 })}%`;
    case "currency":
      return value.toLocaleString(locale, { style: "currency", currency: opts.currency ?? "USD", maximumFractionDigits: 0 });
    case "compact":
      return value.toLocaleString(locale, { notation: "compact", maximumFractionDigits: 1 });
    case "duration":
      return value >= 100 ? value.toLocaleString(locale, { maximumFractionDigits: 0 }) : value.toLocaleString(locale, { maximumFractionDigits: 1 });
    default:
      return Number.isInteger(value) ? value.toLocaleString(locale) : value.toLocaleString(locale, { maximumFractionDigits: 2 });
  }
}

export function formatDelta(delta: number | null | undefined) {
  if (delta === null || delta === undefined || !Number.isFinite(delta)) return null;
  const pct = Math.round(delta * 1000) / 10;
  return `${pct > 0 ? "+" : ""}${pct}%`;
}
