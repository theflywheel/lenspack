import type { GRAINS } from "@lenspack/core";

import type { WidgetData } from "./types";

export type Grain = (typeof GRAINS)[number];

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

/** A catalogue field's label by key (a measure's or a dimension's); undefined when it has none. */
export const labelOf = (fields: { key: string; label: string }[], key: string | undefined) => fields.find((f) => f.key === key)?.label;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A time bucket's UTC date parts; `whole` is its label, short or full alike, when the grain is a year or a quarter. */
function partsOf(ms: number, grain: Grain) {
  const d = new Date(ms);
  const day = d.getUTCDate(), mon = MONTHS[d.getUTCMonth()]!, yr = d.getUTCFullYear();
  const whole = grain === "year" ? String(yr) : grain === "quarter" ? `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${yr}` : null;
  return { day, mon, yr, weekday: DAYS[d.getUTCDay()], hour: `${String(d.getUTCHours()).padStart(2, "0")}:00`, whole };
}

/** A short tick label for a bucket; the year is shown only when the axis spans more than one. */
export function formatTick(ms: number, grain: Grain, multiYear: boolean): string {
  const { day, mon, yr, hour, whole } = partsOf(ms, grain);
  if (whole) return whole;
  if (grain === "month") return multiYear ? `${mon} ${yr}` : mon;
  const date = multiYear ? `${day} ${mon} ${String(yr).slice(2)}` : `${day} ${mon}`;
  return grain === "hour" ? `${date} ${hour}` : date;
}

/** The full label for one bucket, as a tooltip heading. */
export function formatBucket(ms: number, grain: Grain): string {
  const { day, mon, yr, weekday, hour, whole } = partsOf(ms, grain);
  if (whole) return whole;
  if (grain === "month") return `${mon} ${yr}`;
  if (grain === "week") return `Week of ${day} ${mon} ${yr}`;
  const date = `${weekday} ${day} ${mon} ${yr}`;
  return grain === "hour" ? `${date}, ${hour}` : date;
}
