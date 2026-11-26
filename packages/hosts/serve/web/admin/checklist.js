// The telemetry checklist's text: the marks, the summary line and the Markdown copy (with each switch's state). Plain functions with
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

  /** A switch's state in words: on, off, or no switch (an item that cannot be switched). */
  const state = (sw, t) => (!sw ? "—" : sw.key || sw.feature ? (sw.on ? t("tlOn") : t("tlOff")) : t("tlNoSwitch"));

  /** The checklist as Markdown, for a pilot report: the summary, telemetry's own switch, then one table per section with each switch as it stands. */
  function markdown(data, t, o) {
    const fmtDate = (o && o.date) || ((iso) => (iso ? String(iso).slice(0, 16).replace("T", " ") : "—"));
    const fmtNum = (o && o.num) || ((n) => (n === null || n === undefined ? "—" : String(n)));
    const out = [`# ${t("tlTitle")}`, "", `${t("tlGenerated", fmtDate(data.generatedAt))}`, "", `**${summary(data, t)}**`, ""];
    const master = data.telemetry ? data.telemetry.on : data.switches && data.switches.telemetry;
    const days = (data.settings && data.settings.retentionDays) || (data.switches && data.switches.retentionDays);
    out.push(`- ${t("tlMaster")}: ${master ? t("tlOn") : t("tlOff")}`);
    if (days) out.push(`- ${t("tlRetention")}: ${days}`);
    if (data.note) out.push("", `_${data.note}_`);
    out.push("");
    for (const g of data.groups || []) {
      out.push(`## ${g.title} (${g.on === false ? t("tlOff") : t("tlOn")})`, "", `| ${t("tlColOn")} | ${t("tlItem")} | ${t("tlStatus")} | ${t("tl7d")} | ${t("tlLastSeen")} | ${t("tlDecision")} | ${t("tlNotes")} |`, "|---|---|---|---|---|---|---|");
      for (const it of g.items || []) {
        const sw = it.switch;
        const off = it.status === "off" && it.offSince ? t("tlOffSince", fmtDate(it.offSince), it.offBy) : "";
        const why = sw && !sw.editable && sw.reason ? sw.reason : "";
        const notes = [off, why, (it.privacy || []).join("; "), it.status !== "recording" && it.status !== "not-telemetry" && it.howToEnable && it.howToEnable !== why ? `${t("tlHow")}: ${it.howToEnable}` : ""].filter(Boolean).join(" ");
        out.push(`| ${state(sw, t)} | ${cell(it.label)} | ${MARKS[it.status] || "?"} ${cell(t(`st_${it.status}`))} | ${cell(it.status === "not-telemetry" ? null : fmtNum(it.count7d))} | ${cell(it.lastSeen ? fmtDate(it.lastSeen) : "")} | ${cell(it.decision)} | ${cell(notes)} |`);
      }
      out.push("");
    }
    out.push(`${t("tlLegend")}`);
    return out.join("\n");
  }

  root.LenspackChecklist = { ORDER, MARKS, counts, summary, markdown, state };
})(typeof window !== "undefined" ? window : globalThis);
