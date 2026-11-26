// The telemetry checklist's text: the marks, the summary line and the Markdown copy. Plain functions with
// no page access, so the panel draws them and the tests check them on the same data.
(function (root) {
  "use strict";

  const ORDER = ["recording", "enabled-no-data", "needs-config", "off", "not-telemetry"];
  const MARKS = { recording: "✓", "enabled-no-data": "◐", off: "○", "needs-config": "⚠", "not-telemetry": "—" };

  const items = (data) => ((data && data.groups) || []).flatMap((g) => g.items || []);

  /** How many items have each status, and the total. */
  function counts(data) {
    const c = { total: 0 };
    for (const s of ORDER) c[s] = 0;
    for (const it of items(data)) {
      c.total += 1;
      if (c[it.status] !== undefined) c[it.status] += 1;
    }
    return c;
  }

  /** "23 of 31 recording · 4 need configuration · 2 off · 2 not telemetry"; t gives the words. */
  function summary(data, t) {
    const c = counts(data);
    const parts = [t("tlSumRecording", c.recording, c.total)];
    if (c["enabled-no-data"]) parts.push(t("tlSumNoData", c["enabled-no-data"]));
    if (c["needs-config"]) parts.push(t("tlSumConfig", c["needs-config"]));
    if (c.off) parts.push(t("tlSumOff", c.off));
    if (c["not-telemetry"]) parts.push(t("tlSumNot", c["not-telemetry"]));
    return parts.join(" · ");
  }

  const cell = (v) => String(v === null || v === undefined || v === "" ? "—" : v).replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

  /** The checklist as Markdown, for a pilot report: the summary, the switches, then one table per section. */
  function markdown(data, t, o) {
    const fmtDate = (o && o.date) || ((iso) => (iso ? String(iso).slice(0, 16).replace("T", " ") : "—"));
    const fmtNum = (o && o.num) || ((n) => (n === null || n === undefined ? "—" : String(n)));
    const out = [`# ${t("tlTitle")}`, "", `${t("tlGenerated", fmtDate(data.generatedAt))}`, "", `**${summary(data, t)}**`, ""];
    const sw = Object.entries(data.switches || {});
    if (sw.length) {
      out.push(`## ${t("tlSwitches")}`, "");
      for (const [k, v] of sw) out.push(`- ${t(`tlSw_${k}`) === `tlSw_${k}` ? k : t(`tlSw_${k}`)}: ${typeof v === "boolean" ? (v ? t("tlOn") : t("tlOff")) : v}`);
      out.push("");
    }
    for (const g of data.groups || []) {
      out.push(`## ${g.title}`, "", `| | ${t("tlItem")} | ${t("tlDecision")} | ${t("tl7d")} | ${t("tlLastSeen")} | ${t("tlNotes")} |`, "|---|---|---|---|---|---|");
      for (const it of g.items || []) {
        const notes = [it.privacy, it.status !== "recording" && it.status !== "not-telemetry" && it.howToEnable ? `${t("tlHow")}: ${it.howToEnable}` : ""].filter(Boolean).join(" ");
        out.push(`| ${MARKS[it.status] || "?"} | ${cell(it.label)} | ${cell(it.decision)} | ${cell(fmtNum(it.count7d))} | ${cell(it.lastSeen ? fmtDate(it.lastSeen) : "")} | ${cell(notes)} |`);
      }
      out.push("");
    }
    out.push(`${t("tlLegend")}`);
    return out.join("\n");
  }

  root.LenspackChecklist = { ORDER, MARKS, counts, summary, markdown };
})(typeof window !== "undefined" ? window : globalThis);
