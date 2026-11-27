import { AUDIT_RETENTION_DAYS, MODEL_ROLES, type ModelRole, auditRetentionRefusal, offeredModels, offeredModelsRefusal } from "@lenspack/policy";

import type { ExplainConfig } from "./config";
import { explainFrom } from "./config";
import type { Budget } from "./metering";
import type { SettingsStore } from "./settings";

// The deploy config's options that an admin also changes on a running server (docs/hosts/superset/runtime.md): the
// budget caps, which models are offered and the role each plays, how long the audit log is kept, how many turns the
// chat sends, and whether "How this was worked out" shows the SQL. Each is a section of settings.json, written whole;
// the admin's value wins over the config and the environment, and null hands it back. What a change may be (the audit
// log's floor, models among those with keys) is policy's (@lenspack/policy runtime-config.ts); this file keeps the
// values, says where each comes from, and answers the routes' bodies.

/** The deployment's own values, before any admin's. */
export type RuntimeDefaults = {
  /** The config's budget, else LENSPACK_BUDGET_* (budgetFromEnv); `from` says which. */
  budget?: Budget;
  budgetFrom?: "config" | "env";
  /** Days the audit log keeps (the config's, LENSPACK_AUDIT_RETENTION_DAYS, else 90). */
  auditRetentionDays?: number;
  /** How many recent turns the chat sends (8). */
  historyTurns?: number;
  explain?: ExplainConfig;
  /** The deployment's model roles (LENSPACK_LLM_ROLES). */
  roles?: Partial<Record<ModelRole, string>>;
};

export type Change = { ok: true; detail: string } | { ok: false; error: string };
type Body = Record<string, unknown>;

const BUDGET_KEYS = ["usdPerDay", "usdPerUserPerDay"] as const;
const BUDGET_MAX = 100_000;
const HISTORY = { min: 1, max: 50 };

const unknownKeys = (b: Body, known: readonly string[]) => Object.keys(b).filter((k) => !known.includes(k));
const refuseUnknown = (b: Body, known: readonly string[]): Change | null => {
  const u = unknownKeys(b, known);
  return u.length ? { ok: false, error: `unknown setting${u.length === 1 ? "" : "s"} ${u.map((k) => `"${k}"`).join(", ")} (${known.join(", ")})` } : null;
};

export function runtimeConfig(settings: SettingsStore, d: RuntimeDefaults = {}) {
  const section = <T extends object>(name: string) => ({
    get: () => settings.get<T>(name) ?? ({} as T),
    put: (v: T) => settings.set(name, Object.keys(v).length ? v : undefined),
  });

  // ---- the budget: 0 means no cap, over the config's; null hands a cap back ----
  type BudgetSection = Partial<Record<(typeof BUDGET_KEYS)[number], number>>;
  const budgetS = section<BudgetSection>("budget");
  const budget = {
    get(): Budget | undefined {
      const saved = budgetS.get();
      const out: Budget = {};
      for (const k of BUDGET_KEYS) {
        const v = k in saved ? saved[k] : d.budget?.[k];
        if (typeof v === "number" && v > 0) out[k] = v;
      }
      return Object.keys(out).length ? out : undefined;
    },
    view(writable: boolean) {
      const saved = budgetS.get();
      const now = budget.get() ?? {};
      return {
        usdPerDay: now.usdPerDay ?? null,
        usdPerUserPerDay: now.usdPerUserPerDay ?? null,
        defaults: { usdPerDay: d.budget?.usdPerDay ?? null, usdPerUserPerDay: d.budget?.usdPerUserPerDay ?? null },
        source: Object.fromEntries(BUDGET_KEYS.map((k) => [k, k in saved ? "settings" : d.budget?.[k] !== undefined ? (d.budgetFrom ?? "config") : "none"])),
        max: BUDGET_MAX,
        writable,
      };
    },
    update(b: Body): Change {
      const bad = refuseUnknown(b, BUDGET_KEYS);
      if (bad) return bad;
      const next = { ...budgetS.get() };
      for (const k of BUDGET_KEYS) {
        if (!(k in b)) continue;
        const v = b[k];
        if (v === null) delete next[k];
        else if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= BUDGET_MAX) next[k] = Math.round(v * 100) / 100;
        else return { ok: false, error: `${k} is US dollars from 0 (no cap) to ${BUDGET_MAX}, or null for the deployment's value` };
      }
      budgetS.put(next);
      return { ok: true, detail: JSON.stringify(b) };
    },
  };

  // ---- the models offered, and the model each role uses ----
  type ModelsSection = { offered?: string[]; roles?: Partial<Record<ModelRole, string>> };
  const modelsS = section<ModelsSection>("models");
  const models = {
    /** The names offered, or null for every model the deployment configures. */
    offered: (): string[] | null => modelsS.get().offered ?? null,
    /** The roles in force: the deployment's, with an admin's over them. */
    roles: (): Partial<Record<ModelRole, string>> => ({ ...d.roles, ...modelsS.get().roles }),
    view<P extends { name: string }>(providers: readonly P[], writable: boolean) {
      const saved = modelsS.get();
      const offered = offeredModels(providers, saved.offered).map((p) => p.name);
      return {
        offered,
        all: providers.map((p) => p.name),
        source: saved.offered ? "settings" : "default",
        roles: Object.fromEntries(MODEL_ROLES.map((r) => [r, models.roles()[r] ?? null])),
        defaultRoles: Object.fromEntries(MODEL_ROLES.map((r) => [r, d.roles?.[r] ?? null])),
        rolesSource: Object.fromEntries(MODEL_ROLES.map((r) => [r, saved.roles?.[r] !== undefined ? "settings" : d.roles?.[r] !== undefined ? "env" : "none"])),
        writable,
      };
    },
    update(b: Body, configured: readonly string[], chatDefault?: string): Change {
      const bad = refuseUnknown(b, ["offered", "roles"]);
      if (bad) return bad;
      const next: ModelsSection = { ...modelsS.get() };
      if ("offered" in b) {
        if (b.offered === null) delete next.offered;
        else {
          const why = offeredModelsRefusal(b.offered, configured);
          if (why) return { ok: false, error: why };
          next.offered = configured.filter((m) => (b.offered as string[]).includes(m));
          // Every model offered: the same as no choice.
          if (next.offered.length === configured.length) delete next.offered;
        }
      }
      if ("roles" in b) {
        if (b.roles === null) delete next.roles;
        else if (!b.roles || typeof b.roles !== "object" || Array.isArray(b.roles)) return { ok: false, error: `roles is { ${MODEL_ROLES.join(", ")} }, each a model name or null` };
        else {
          const roles = { ...next.roles };
          for (const [r, v] of Object.entries(b.roles as Body)) {
            if (!(MODEL_ROLES as readonly string[]).includes(r)) return { ok: false, error: `unknown role "${r}" (${MODEL_ROLES.join(", ")})` };
            if (v === null) delete roles[r as ModelRole];
            else if (typeof v === "string" && configured.includes(v)) roles[r as ModelRole] = v;
            else return { ok: false, error: `roles.${r} is one of the deployment's models (${configured.join(", ")}), or null` };
          }
          if (Object.keys(roles).length) next.roles = roles;
          else delete next.roles;
        }
      }
      const offered = next.offered ?? configured;
      for (const [r, v] of Object.entries(next.roles ?? {})) if (!offered.includes(v)) return { ok: false, error: `roles.${r} is ${v}, which is not offered: offer it, or pick another` };
      modelsS.put(next);
      return { ok: true, detail: JSON.stringify(b) + (chatDefault && !offered.includes(chatDefault) ? ` (the default chat model ${chatDefault} is no longer offered: the first offered model answers instead)` : "") };
    },
  };

  // ---- how long the audit log is kept ----
  const auditS = section<{ retentionDays?: number }>("audit");
  const deployAuditDays = d.auditRetentionDays ?? 90;
  const audit = {
    retentionDays: () => auditS.get().retentionDays ?? deployAuditDays,
    view: (writable: boolean) => ({ retentionDays: audit.retentionDays(), defaultDays: deployAuditDays, min: Math.min(AUDIT_RETENTION_DAYS.min, deployAuditDays), max: AUDIT_RETENTION_DAYS.max, source: auditS.get().retentionDays !== undefined ? "settings" : "default", writable }),
    update(b: Body): Change {
      const bad = refuseUnknown(b, ["retentionDays"]);
      if (bad) return bad;
      if (!("retentionDays" in b)) return { ok: false, error: 'send { "retentionDays": <days> }, or null for the deployment\'s value' };
      if (b.retentionDays === null) auditS.put({});
      else {
        const why = auditRetentionRefusal(b.retentionDays, deployAuditDays);
        if (why) return { ok: false, error: why };
        auditS.put({ retentionDays: b.retentionDays as number });
      }
      return { ok: true, detail: `retentionDays ${audit.retentionDays()}${b.retentionDays === null ? " (the deployment's)" : ""}` };
    },
  };

  // ---- how many recent turns the chat model is sent ----
  const historyS = section<{ historyTurns?: number }>("history");
  const deployHistory = d.historyTurns ?? 8;
  const history = {
    turns: () => historyS.get().historyTurns ?? deployHistory,
    view: (writable: boolean) => ({ historyTurns: history.turns(), defaultTurns: deployHistory, range: HISTORY, source: historyS.get().historyTurns !== undefined ? "settings" : "default", writable }),
    update(b: Body): Change {
      const bad = refuseUnknown(b, ["historyTurns"]);
      if (bad) return bad;
      const v = b.historyTurns;
      if (v === null) historyS.put({});
      else if (typeof v === "number" && Number.isInteger(v) && v >= HISTORY.min && v <= HISTORY.max) historyS.put({ historyTurns: v });
      else return { ok: false, error: `historyTurns is a whole number from ${HISTORY.min} to ${HISTORY.max}, or null for the deployment's value` };
      return { ok: true, detail: `historyTurns ${history.turns()}` };
    },
  };

  // ---- whether "How this was worked out" shows the SQL (the explain switch itself is a feature switch) ----
  const explainS = section<{ sql?: boolean }>("explain");
  const deployExplain = explainFrom(d.explain);
  const explain = {
    /** The config's explain, with the admin's sql over it. */
    get: () => ({ ...deployExplain, ...(explainS.get().sql !== undefined ? { sql: explainS.get().sql! } : {}) }),
    view: (writable: boolean) => ({ sql: explain.get().sql, defaultSql: deployExplain.sql, source: explainS.get().sql !== undefined ? "settings" : "default", writable }),
    update(b: Body): Change {
      const bad = refuseUnknown(b, ["sql"]);
      if (bad) return bad;
      if (b.sql === null) explainS.put({});
      else if (typeof b.sql === "boolean") explainS.put({ sql: b.sql });
      else return { ok: false, error: "sql is true or false, or null for the deployment's value" };
      return { ok: true, detail: `sql ${explain.get().sql}` };
    },
  };

  return { budget, models, audit, history, explain };
}

export type RuntimeConfig = ReturnType<typeof runtimeConfig>;
