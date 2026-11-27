// What a running deployment's admins may change without a redeploy, and what only the deploy config sets. On a
// deployment where the deploy config sits in someone else's hands, the admin pages and the admin API key are the only
// levers: everything that is an option should be one of them. Three answers per key:
//
//   yes      any value, on the settings routes (PUT <prefix>/settings/<area>); the admin's value wins over the config
//            and the environment, null hands it back.
//   narrow   the deployment's data boundary: a change may only narrow it (fewer datasets, more scope clauses, fewer
//            dashboards, more exclusions, a stricter mode), never widen it past the deploy config.
//   no       set in the deploy config only: secrets and keys, how this server reaches Superset and signs in there, where
//            it keeps its state and listens, and the identifiers saved records are kept under.
//
// This file is the rule: the inventory every host renders, and the limits a change is checked against. Hosts keep the
// values and render them; they never decide these.

export type RuntimeAnswer = "yes" | "narrow" | "no";

/** One key of superset.yaml (or an environment variable with no key), and whether it changes while the server runs. */
export type RuntimeKey = {
  key: string;
  runtime: RuntimeAnswer;
  /** The settings route that changes it: PUT <prefix>/settings/<area>. */
  area?: string;
  /** For an admin: what a change may do, or why it stays in the deploy config. */
  note?: string;
};

/** Every option of a Superset deployment, in the order the docs list them. */
export const RUNTIME_CONFIG: readonly RuntimeKey[] = [
  { key: "datasets", runtime: "no", note: "which Superset datasets the assistant may read: the deployment's data boundary" },
  { key: "scope", runtime: "no", note: "the filters every answer carries: the deployment's data boundary" },
  { key: "dashboards, dashboardScope", runtime: "no", note: "which dashboards the assistant is on: the deployment's data boundary" },
  { key: "hostPolicy, accessFallback", runtime: "no", note: "whose Superset access narrows what each person sees: the deployment's data boundary" },
  { key: "editPolicy", runtime: "no", note: "who may change dashboards through the chat: the deployment's boundary" },
  { key: "auth (admins, usage, users, adminAccess, adminUsers, userAccess, seedUsers)", runtime: "no", note: "who is an admin and who may use the assistant: the deployment's boundary. People are let in and admins granted on the Access page" },
  { key: "overlay.exclude", runtime: "narrow", area: "pack", note: "more exclusions on the Pack tab, never fewer than the deploy config's" },
  { key: "overlay (description, instructions, labels, hints, measures, examples, notDimensions, hierarchies)", runtime: "yes", area: "pack" },
  { key: "overlay.panel", runtime: "yes", area: "panel" },
  { key: "overlay.pack, overlay.entities", runtime: "no", note: "the names saved definitions, saved answers and addresses are kept under" },
  { key: "overlay.timeZone", runtime: "no", note: "what today and last month mean for every saved answer and definition; the daily schedules are set from it at start" },
  { key: "overlay.geo", runtime: "no", note: "which columns are people's locations; the maps switch turns maps off while the server runs" },
  { key: "overlay.mapStyle", runtime: "no", note: "the map tile server browsers fetch from, outside the deployment" },
  { key: "admin.surface", runtime: "yes", area: "admin-surface" },
  { key: "editScope", runtime: "yes", area: "edit-scope" },
  { key: "personal", runtime: "yes", area: "personal" },
  { key: "querySafety", runtime: "yes", area: "query-safety", note: "tighter at once; looser only with confirm" },
  { key: "budget (usdPerDay, usdPerUserPerDay)", runtime: "yes", area: "budget" },
  { key: "the models offered and the role each plays (LENSPACK_LLM_ROLES)", runtime: "yes", area: "models", note: "chosen from the models the deployment has keys for" },
  { key: "the default chat model and its effort", runtime: "yes", area: "chat" },
  { key: "historyTurns", runtime: "yes", area: "history" },
  { key: "audit.retentionDays", runtime: "yes", area: "audit", note: "from 30 days (or the deploy config's own, when shorter) to 3650" },
  { key: "audit: false", runtime: "no", note: "switching the audit log off would hide what an admin, or an admin API key, does" },
  { key: "speech (model, holdMs, maxSeconds, recordings)", runtime: "yes", area: "speech" },
  { key: "speech.baseUrl", runtime: "no", note: "where spoken questions are sent, which goes with the speech key" },
  { key: "language", runtime: "yes", area: "language" },
  { key: "features", runtime: "yes", area: "features" },
  { key: "cache", runtime: "yes", area: "cache" },
  { key: "queue", runtime: "yes", area: "queue" },
  { key: "explain", runtime: "yes", area: "explain", note: "the explain switch is on the switches; whether the SQL shows is here" },
  { key: "brand", runtime: "yes", area: "brand" },
  { key: "telemetry", runtime: "yes", area: "telemetry" },
  { key: "context", runtime: "yes", area: "context" },
  { key: "superset (url, publicUrl, publicPort, username, password)", runtime: "no", note: "how this server reaches Superset and signs in there: a wrong value cuts the assistant off, and only the deployment can put it right" },
  { key: "host, port, publicPath, state", runtime: "no", note: "where the server listens, the path the proxy forwards, and where it keeps its state" },
  { key: "model and speech keys (LENSPACK_LLM_*, ANTHROPIC_API_KEY, LENSPACK_STT_API_KEY)", runtime: "no", note: "secrets" },
  { key: "admin passwords and admin API keys (LENSPACK_ADMIN_PASSWORD*, LENSPACK_ADMIN_SESSION_*, LENSPACK_ADMIN_API_KEYS*)", runtime: "no", note: "secrets, and the keys that open these settings" },
];

/** How long the audit log is kept, in days, when an admin changes it while the server runs. */
export const AUDIT_RETENTION_DAYS = { min: 30, max: 3650 } as const;

/**
 * Why an admin's audit retention can't be used, or null. Any whole number of days up to the maximum, and down to 30, or
 * to the deploy config's own when that is shorter: a leaked admin key can't make the log forget what it did last month.
 */
export function auditRetentionRefusal(days: unknown, deployDays: number): string | null {
  const min = Math.min(AUDIT_RETENTION_DAYS.min, deployDays);
  if (typeof days !== "number" || !Number.isInteger(days) || days < min || days > AUDIT_RETENTION_DAYS.max)
    return `retentionDays is a whole number of days from ${min} to ${AUDIT_RETENTION_DAYS.max}: the audit log keeps at least ${min} days, so what any admin did stays on record`;
  return null;
}

/** The model roles a deployment names (LENSPACK_LLM_ROLES), which an admin may change. */
export const MODEL_ROLES = ["reviewer", "escalate", "router"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

/**
 * Why a list of offered models can't be used, or null: one or more of the models the deployment has keys for, by name.
 * The deployment's keys decide what exists; admins choose among them.
 */
export function offeredModelsRefusal(offered: unknown, configured: readonly string[]): string | null {
  if (!Array.isArray(offered) || !offered.length || offered.some((m) => typeof m !== "string")) return `offered is a list of one or more of the deployment's models: ${configured.join(", ") || "(none configured)"}`;
  const unknown = offered.filter((m) => !configured.includes(m as string));
  if (unknown.length) return `${unknown.map((m) => `"${m}"`).join(", ")} ${unknown.length === 1 ? "is not a model" : "are not models"} this deployment has a key for (${configured.join(", ") || "none"})`;
  return null;
}

/** The models in use under an admin's choice: the configured ones it offers, in the deployment's order; all of them without a choice. */
export function offeredModels<P extends { name: string }>(configured: readonly P[], offered: readonly string[] | null | undefined): P[] {
  if (!offered?.length) return [...configured];
  const kept = configured.filter((p) => offered.includes(p.name));
  return kept.length ? kept : [...configured];
}
