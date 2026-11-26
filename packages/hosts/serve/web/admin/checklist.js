// The Telemetry tab's text: the marks, the summary lines and the Markdown copy (what's recorded, each switch as it
// stands, and what it tells you, each metric with its value). Plain functions with no page access, so the panel draws
// them and the tests check them on the same data.
(function (root) {
  "use strict";

  const ORDER = ["recording", "enabled-no-data", "needs-config", "off"];
  const MARKS = { recording: "✓", "enabled-no-data": "◐", off: "○", "needs-config": "⚠" };

  const rows = (data) => ((data && data.categories) || []).flatMap((c) => c.rows || []);
  const metricRows = (data) => ((data && data.metrics) || []).flatMap((g) => g.metrics || []);

  /** How many fields have each status, and the total. */
  function counts(data) {
    const c = { total: 0 };
    for (const s of ORDER) c[s] = 0;
    for (const r of rows(data)) {
      c.total += 1;
      if (c[r.status] !== undefined) c[r.status] += 1;
    }
    return c;
  }

  /** "24 of 34 fields recording · 3 on, nothing yet · 2 need configuration · 5 off"; t gives the words. */
  function summary(data, t) {
    const c = counts(data);
    const parts = [t("tlSumRecording", c.recording, c.total)];
    if (c["enabled-no-data"]) parts.push(t("tlSumNoData", c["enabled-no-data"]));
    if (c["needs-config"]) parts.push(t("tlSumConfig", c["needs-config"]));
    if (c.off) parts.push(t("tlSumOff", c.off));
    return parts.join(" · ");
  }

  /** "31 of 38 metrics available · 2 with no records yet · 5 unavailable". */
  function metricSummary(data, t) {
    const ms = metricRows(data);
    const n = (s) => ms.filter((m) => m.status === s).length;
    const parts = [t("tlSumReady", n("ready") + n("no-data"), ms.length)];
    if (n("no-data")) parts.push(t("tlSumMetNoData", n("no-data")));
    if (n("unavailable")) parts.push(t("tlSumUnavailable", n("unavailable")));
    return parts.join(" · ");
  }

  const cell = (v) => String(v === null || v === undefined || v === "" ? "—" : v).replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

  /** A switch's state in words: on, off, or no switch. */
  const state = (sw, t) => (!sw ? "—" : sw.key || sw.lock ? (sw.on ? t("tlOn") : t("tlOff")) : t("tlNoSwitch"));

  /**
   * The tab as Markdown, for a pilot report: what's recorded (telemetry's own switch, then one table per category with
   * each switch as it stands) and what it tells you (one table per group, each metric with its value or why not).
   * o.figure formats a metric's number, o.unavailable says why one is unavailable, o.name puts in the assistant's name.
   */
  function markdown(data, t, o) {
    o = o || {};
    const fmtDate = o.date || ((iso) => (iso ? String(iso).slice(0, 16).replace("T", " ") : "—"));
    const fmtNum = o.num || ((n) => (n === null || n === undefined ? "—" : String(n)));
    const fig = o.figure || ((f) => (!f || f.value === null || f.value === undefined ? "—" : String(f.value)));
    const why = o.unavailable || ((u) => (u ? u.text : ""));
    const nm = o.name || ((s) => String(s === null || s === undefined ? "" : s));
    const out = [`# ${t("tlTitle")}`, "", `${t("tlGenerated", fmtDate(data.generatedAt))}`, ""];
    const master = data.telemetry ? data.telemetry.on : data.switches && data.switches.telemetry;
    const days = (data.settings && data.settings.retentionDays) || (data.switches && data.switches.retentionDays);
    out.push(`## ${t("tlViewRecorded")}`, "", `**${summary(data, t)}**`, "");
    out.push(`- ${t("tlMaster")}: ${master ? t("tlOn") : t("tlOff")}`);
    if (days) out.push(`- ${t("tlRetention")}: ${days}`);
    if (data.note) out.push("", `_${data.note}_`);
    out.push("");
    for (const c of data.categories || []) {
      const st = c.state === "mixed" ? t("tlMixed") : c.state === "on" ? t("tlOn") : t("tlOff");
      out.push(`### ${c.title} (${st})`, "", `| ${t("tlColOn")} | ${t("tlField")} | ${t("tlStatus")} | ${t("tl7d")} | ${t("tlUsedBy")} | ${t("tlNotes")} |`, "|---|---|---|---|---|---|");
      for (const r of c.rows || []) {
        const sw = r.switch;
        const off = r.status === "off" && r.offSince ? t("tlOffSince", fmtDate(r.offSince), r.offBy) : "";
        const lock = sw && !sw.editable ? r.reasonText || nm(sw.reason) : "";
        const notes = [off, lock, (r.privacy || []).join("; "), r.status !== "recording" && r.howToEnable && !lock ? `${t("tlHow")}: ${nm(r.howToEnable)}` : ""].filter(Boolean).join(" ");
        const used = (r.usedBy || []).map((m) => m.label).join(", ");
        out.push(`| ${state(sw, t)} | ${cell(r.label)} | ${MARKS[r.status] || "?"} ${cell(t(`st_${r.status}`))} | ${cell(fmtNum(r.count7d))} | ${cell(used)} | ${cell(notes)} |`);
      }
      out.push("");
    }
    out.push(`${t("tlLegend")}`, "");
    out.push(`## ${t("tlViewMetrics")}`, "", `**${metricSummary(data, t)}**`, "");
    for (const g of data.metrics || []) {
      out.push(`### ${g.title}`, "", `| ${t("tlViewMetrics")} | ${t("value")} | ${t("tmUses")} |`, "|---|---|---|");
      for (const m of g.metrics || []) {
        const value = m.status === "unavailable" ? why(m.unavailable, m.id) : m.status === "no-data" ? t("tmNoData") : fig(m.reading && m.reading.value);
        out.push(`| ${cell(m.label)} | ${cell(value)} | ${cell((m.needs || []).map((n) => n.label).join(", "))} |`);
      }
      out.push("");
    }
    return out.join("\n").trimEnd();
  }

  root.LenspackChecklist = { ORDER, MARKS, counts, summary, metricSummary, markdown, state };
})(typeof window !== "undefined" ? window : globalThis);
