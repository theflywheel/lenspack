// Exports and shares that happen in Superset itself (a chart downloaded as CSV or an image, a dashboard as PDF, a
// permalink copied, a share by email) never pass through Lenspack. Superset records them in its own action log
// (the logs table, read through /api/v1/log/), which an admin reads here for the dashboards Lenspack works on.
// Best effort: the log needs Superset's action logging on (the default) and Lenspack's account allowed to read it
// (it is an admin account); anything else answers available: false with the reason.

import { type SupersetClient, SupersetError, rison } from "./client";

export type SupersetAction = { at: string; user: string | null; dashboard: number; chart: number | null; action: string; event: string };

/** The names Superset's pages log for exporting, downloading and sharing. */
export const EXPORT_OR_SHARE = /export|download|permalink|share|copy_link|email/i;

type LogRow = { action?: string; dttm?: string; json?: string | null; dashboard_id?: number | null; slice_id?: number | null; user?: { username?: string } | null };

/**
 * Export and share actions on these dashboards between from and to, newest first, read a page of 100 at a time
 * (at most maxPages pages, so a busy log is cut short rather than read whole; truncated says so).
 */
export async function supersetActions(client: SupersetClient, q: { dashboards: number[]; from: Date; to: Date; maxPages?: number }): Promise<{ available: boolean; reason?: string; truncated?: boolean; actions: SupersetAction[] }> {
  const wanted = new Set(q.dashboards);
  const actions: SupersetAction[] = [];
  const day = (d: Date) => d.toISOString().slice(0, 19);
  const pages = q.maxPages ?? 10;
  for (let page = 0; page < pages; page++) {
    const query = rison({
      filters: [
        { col: "dttm", opr: "gt", value: day(q.from) },
        { col: "dttm", opr: "lt", value: day(q.to) },
      ],
      order_column: "dttm",
      order_direction: "desc",
      page,
      page_size: 100,
    });
    let rows: LogRow[];
    try {
      rows = (await client.get<{ result: LogRow[] }>(`/api/v1/log/?q=${encodeURIComponent(query)}`)).result ?? [];
    } catch (e) {
      if (page > 0) return { available: true, truncated: true, actions };
      const why = e instanceof SupersetError ? (e.status === 404 ? "this Superset has no action log API (SUPERSET_LOG_VIEW may be off)" : e.status === 403 || e.status === 401 ? "Lenspack's Superset account may not read the action log" : e.message) : String(e);
      return { available: false, reason: why, actions: [] };
    }
    for (const r of rows) {
      let extra: Record<string, unknown> = {};
      try {
        extra = r.json ? (JSON.parse(r.json) as Record<string, unknown>) : {};
      } catch {
        /* not JSON */
      }
      const event = typeof extra.event_name === "string" ? extra.event_name : (r.action ?? "");
      if (!EXPORT_OR_SHARE.test(event) && !EXPORT_OR_SHARE.test(r.action ?? "")) continue;
      const dash = Number(r.dashboard_id ?? extra.dashboard_id ?? extra.source_id);
      if (!wanted.has(dash)) continue;
      const chart = Number(r.slice_id ?? extra.slice_id);
      actions.push({ at: r.dttm ?? "", user: r.user?.username ?? null, dashboard: dash, chart: Number.isFinite(chart) && chart > 0 ? chart : null, action: r.action ?? "", event });
    }
    if (rows.length < 100) return { available: true, actions };
  }
  return { available: true, truncated: true, actions };
}
