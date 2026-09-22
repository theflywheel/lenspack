import type { Writer } from "@lenspack/sql";

import { type Dialect, daysAgo, execAll, insertRows, json, rng, ts } from "../_shared/seed-util";

// Synthetic responses in three languages. Nothing here is real consultation
// data; the sentences are templates with the district and theme filled in.
const TEXT: Record<string, string[]> = {
  en: [
    "The exam centre in {district} is too far; we travel four hours each way.",
    "Results took months to arrive and nobody answered the helpline.",
    "Please allow the test in our own language, not only in English and Hindi.",
    "The application portal kept crashing on the last day. My name is {name} and my phone is 98{n}.",
    "Fees are unaffordable for families like ours in {district}.",
  ],
  hi: [
    "{district} में परीक्षा केंद्र बहुत दूर है; हमें आने-जाने में चार घंटे लगते हैं।",
    "परिणाम आने में महीनों लगे और हेल्पलाइन पर किसी ने जवाब नहीं दिया।",
    "कृपया परीक्षा हमारी अपनी भाषा में भी होने दें।",
    "आवेदन पोर्टल आखिरी दिन बार-बार बंद हो रहा था। मेरा नाम {name} है और फ़ोन 98{n} है।",
  ],
  mr: [
    "{district} मधील परीक्षा केंद्र खूप दूर आहे; प्रवासाला चार तास लागतात.",
    "निकाल यायला महिने लागले आणि हेल्पलाइनवर कोणी उत्तर दिले नाही.",
    "कृपया परीक्षा आमच्या भाषेतही घ्या.",
  ],
};
const THEMES = [
  ["Distance to exam centres", 4, 3],
  ["Delayed results", 3, 4],
  ["Language of the test", 3, 5],
  ["Portal outages", 2, 5],
  ["Fees and affordability", 4, 2],
  ["Helpline unresponsive", 2, 4],
] as const;
const DISTRICTS = ["Pune", "Nagpur", "Nashik", "Lucknow", "Kanpur", "Patna", "Ranchi", "Bhopal"];

export async function seed(writer: Writer, dialect: Dialect, opts: { submissions?: number; now?: Date } = {}) {
  const r = rng(23);
  const now = opts.now ?? new Date("2026-09-01T00:00:00Z");
  const n = opts.submissions ?? 3000;

  await execAll(writer, [
    "DROP VIEW IF EXISTS v_signal_wait",
    "DROP VIEW IF EXISTS v_submission_theme",
    "DROP TABLE IF EXISTS extractions",
    "DROP TABLE IF EXISTS theme_assignments",
    "DROP TABLE IF EXISTS themes",
    "DROP TABLE IF EXISTS analysis_runs",
    "DROP TABLE IF EXISTS submissions",
    `CREATE TABLE submissions (id INTEGER PRIMARY KEY, tenant_id VARCHAR, submitted_at TIMESTAMP, channel VARCHAR, language VARCHAR, metadata ${json(dialect)}, text VARCHAR, moderation_status VARCHAR, redacted BOOLEAN)`,
    "CREATE TABLE analysis_runs (id INTEGER PRIMARY KEY, tenant_id VARCHAR, status VARCHAR, completed_at TIMESTAMP)",
    "CREATE TABLE themes (id INTEGER PRIMARY KEY, run_id INTEGER, name VARCHAR, severity INTEGER, actionability INTEGER)",
    "CREATE TABLE theme_assignments (submission_id INTEGER, theme_id INTEGER, run_id INTEGER)",
    "CREATE TABLE extractions (id INTEGER PRIMARY KEY, tenant_id VARCHAR, submission_id INTEGER, run_id INTEGER, signal_key VARCHAR, value_num DOUBLE PRECISION, value_bool BOOLEAN)",
  ]);

  const submissions: unknown[][] = [];
  const assignments: unknown[][] = [];
  const extractions: unknown[][] = [];
  let extractionId = 1;
  for (let i = 1; i <= n; i++) {
    const tenant = r.chance(0.9) ? "dopt" : "other";
    const language = r.weighted([["en", 5], ["hi", 4], ["mr", 2]]);
    const district = r.pick(DISTRICTS);
    const template = r.pick(TEXT[language]!);
    const hasPii = template.includes("{name}");
    const text = template.replace("{district}", district).replace("{name}", "[REDACTED]").replace("{n}", "[REDACTED]");
    const themeIndex = r.int(0, THEMES.length - 1);
    submissions.push([
      i,
      tenant,
      ts(daysAgo(now, r.int(0, 60))),
      r.weighted([["web", 5], ["whatsapp", 3], ["telegram", 1], ["ivr", 1]]),
      language,
      JSON.stringify({ district, respondent: { age_band: r.weighted([["18-24", 4], ["25-34", 4], ["35-44", 2], ["45+", 1]]), occupation: r.pick(["student", "teacher", "farmer", "clerk", "other"]) } }),
      text,
      r.weighted([["approved", 88], ["flagged", 9], ["rejected", 3]]),
      hasPii,
    ]);
    // Two runs: run 1 is stale, run 2 is the latest completed; the view only
    // reads run 2, which is how "latest run" stops being a special case.
    assignments.push([i, 100 + themeIndex, 1], [i, 200 + themeIndex, 2]);
    if (r.chance(0.7)) {
      extractions.push([extractionId++, tenant, i, 2, "wait", r.int(0, 18), r.chance(0.35)]);
    }
  }
  await insertRows(writer, "submissions", ["id", "tenant_id", "submitted_at", "channel", "language", "metadata", "text", "moderation_status", "redacted"], submissions);
  await insertRows(writer, "analysis_runs", ["id", "tenant_id", "status", "completed_at"], [
    [1, "dopt", "completed", ts(daysAgo(now, 20))],
    [2, "dopt", "completed", ts(daysAgo(now, 1))],
    [3, "dopt", "running", null],
  ]);
  await insertRows(writer, "themes", ["id", "run_id", "name", "severity", "actionability"], [
    ...THEMES.map((t, i) => [100 + i, 1, t[0], t[1], t[2]]),
    ...THEMES.map((t, i) => [200 + i, 2, t[0], t[1], t[2]]),
  ]);
  await insertRows(writer, "theme_assignments", ["submission_id", "theme_id", "run_id"], assignments);
  await insertRows(writer, "extractions", ["id", "tenant_id", "submission_id", "run_id", "signal_key", "value_num", "value_bool"], extractions);

  await execAll(writer, [
    `CREATE VIEW v_submission_theme AS
       SELECT ta.submission_id, t.name AS theme, t.severity, t.actionability
       FROM theme_assignments ta
       JOIN themes t ON t.id = ta.theme_id
       WHERE ta.run_id = (SELECT MAX(id) FROM analysis_runs WHERE status = 'completed')`,
    `CREATE VIEW v_signal_wait AS
       SELECT e.tenant_id, e.submission_id, e.value_num AS months_waiting, e.value_bool AS wants_human
       FROM extractions e
       WHERE e.signal_key = 'wait' AND e.run_id = (SELECT MAX(id) FROM analysis_runs WHERE status = 'completed')`,
  ]);
}
