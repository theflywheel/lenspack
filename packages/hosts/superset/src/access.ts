// What each Superset user may see, as Superset decides it: the datasets their roles may read, and the
// row-level security filters on each. Lenspack reads Superset through one service account (an Admin),
// so without this every user would see what that account sees. With `hostPolicy: superset`, each
// user's Superset access becomes their policy identity: a dataset they may not read is kept from them
// (its keys hidden, any query on it refused), and its RLS filters narrow every query that reads it.
//
// Superset's answer comes from lenspack_superset.py's /api/v1/lenspack/access, which asks Superset's
// own security manager as that user (Jinja in a clause rendered). Without the plugin's endpoint, the
// stock REST API's RLS rules are read and matched to the user's roles; dataset permissions are not
// readable there, and a templated clause cannot be rendered, so such a clause keeps its dataset from
// the user. Only simple clauses translate (col = v, col IN (...), AND, and OR over one column);
// anything else fails closed: the dataset is kept from the user, and the log says why.
//
// The same answer says which bound dashboards the user may open (Superset's dashboard access check, dashboard
// roles included): the others are kept from them, so their titles are not listed to them either.

import type { ScopeClause } from "@lenspack/core";
import type { Identity } from "@lenspack/policy";

import type { Binding } from "./catalogue";
import { type SupersetClient, SupersetError, rison } from "./client";

/** One dataset as Superset decides it for one user: may they read it, and the RLS clauses on it (each group already ORed). */
export type DatasetAccess = { access: boolean; rls: string[] };

type Lit = string | number;
type Clause = { column: string; values: Lit[] };

/** A clause's filters (column = value, column IN values), or why it cannot be read as such. */
export function parseClause(sql: string): Clause[] | { reason: string } {
  const tokens: string[] = [];
  const re = /\s*(?:('(?:[^']|'')*')|("(?:[^"]|"")+"|`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)|(-?\d+(?:\.\d+)?)|(<>|!=|<=|>=|[=(),<>])|(\S))/y;
  for (let m: RegExpExecArray | null; re.lastIndex < sql.length && (m = re.exec(sql)); ) {
    if (m[5]) return { reason: `"${m[5]}" is not understood` };
    tokens.push(m[1] ?? m[2] ?? m[3] ?? m[4] ?? "");
    if (!sql.slice(re.lastIndex).trim()) break;
  }
  let at = 0;
  const peek = () => tokens[at];
  const word = (w: string) => peek()?.toUpperCase() === w && (at++, true);
  const fail = (why: string): never => {
    throw new Error(why);
  };
  const literal = (): Lit => {
    const t = tokens[at++] ?? fail("a value is missing");
    if (t.startsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
    if (/^-?\d/.test(t)) return Number(t);
    return fail(`"${t}" is not a plain value`);
  };
  const column = (): string => {
    const t = tokens[at++] ?? fail("a column is missing");
    if (/^["`]/.test(t)) return t.slice(1, -1).replace(/""/g, '"');
    if (/^[A-Za-z_]/.test(t) && !["AND", "OR", "NOT", "IN", "NULL", "IS", "LIKE", "SELECT"].includes(t.toUpperCase())) return t;
    return fail(`"${t}" is not a column`);
  };
  // expr := conj (OR conj)* ; conj := atom (AND atom)* ; atom := (expr) | col = lit | col IN (lit, ...)
  const atom = (): Clause[] => {
    if (peek() === "(") {
      at++;
      const inner = expr();
      if (tokens[at++] !== ")") fail("a bracket is not closed");
      return inner;
    }
    const col = column();
    if (peek() === "=") {
      at++;
      return [{ column: col, values: [literal()] }];
    }
    if (word("IN")) {
      if (tokens[at++] !== "(") fail("IN needs a list");
      const values = [literal()];
      while (peek() === ",") at++, values.push(literal());
      if (tokens[at++] !== ")") fail("an IN list is not closed");
      return [{ column: col, values }];
    }
    return fail(`"${col} ${peek() ?? ""}" is not = or IN`);
  };
  const conj = (): Clause[] => {
    const all = atom();
    while (word("AND")) all.push(...atom());
    return all;
  };
  const expr = (): Clause[] => {
    const first = conj();
    if (peek()?.toUpperCase() !== "OR") return first;
    // An OR is read only as one column's values: (a = 1 OR a = 2) is a IN (1, 2).
    const values = [...(first.length === 1 ? first[0]!.values : fail("an OR across several filters"))];
    while (word("OR")) {
      const next = conj();
      if (next.length !== 1 || next[0]!.column !== first[0]!.column) fail("an OR across columns");
      values.push(...next[0]!.values);
    }
    return [{ column: first[0]!.column, values: [...new Set(values)] }];
  };
  try {
    if (!tokens.length) return { reason: "an empty clause" };
    const out = expr();
    if (at < tokens.length) fail(`"${tokens[at]}" is not understood`);
    return out;
  } catch (e) {
    return { reason: (e as Error).message };
  }
}

/** One dataset's RLS clauses as scope on its entity, through the binding's column → dimension map; or why they cannot be. */
export function rlsScope(clauses: string[], entity: string, binding: Binding): ScopeClause[] | { reason: string } {
  const out: ScopeClause[] = [];
  for (const sql of clauses) {
    if (/\{[{%#]/.test(sql)) return { reason: `the clause "${sql}" is a template` };
    const parsed = parseClause(sql);
    if ("reason" in parsed) return { reason: `the clause "${sql}": ${parsed.reason}` };
    for (const c of parsed) {
      const dimension = binding.dimensionOf.get(entity)?.get(c.column);
      if (!dimension) return { reason: `the clause "${sql}" filters on "${c.column}", which is not a dimension of the pack` };
      out.push(c.values.length === 1 ? { entity, dimension, op: "eq", value: c.values[0]! } : { entity, dimension, op: "in", value: c.values });
    }
  }
  return out;
}

/** The policy identity one user's Superset access comes to: the entities kept from them, and the scope on the rest. */
export function identityFrom(answer: Record<string, DatasetAccess | undefined>, binding: Binding, log: (s: string) => void, user: string): Pick<Identity, "scope" | "hiddenEntities"> {
  const hiddenEntities: string[] = [];
  const scope: ScopeClause[] = [];
  for (const [id, entity] of binding.entityOf) {
    const ds = answer[String(id)];
    if (!ds?.access) {
      hiddenEntities.push(entity);
      continue;
    }
    const s = rlsScope(ds.rls, entity, binding);
    if ("reason" in s) {
      log(`access: ${entity} is kept from ${user}: ${s.reason}`);
      hiddenEntities.push(entity);
    } else scope.push(...s);
  }
  return { ...(hiddenEntities.length ? { hiddenEntities } : {}), ...(scope.length ? { scope } : {}) };
}

type RlsRule = { filter_type: string; tables: { id: number }[]; roles: { name: string }[]; group_key?: string | null; clause: string };

/** Without the plugin's endpoint: the RLS rules from Superset's REST API that apply to these roles, ORed by group key as Superset does. */
export async function stockAccess(client: SupersetClient, datasets: number[], roles: string[]): Promise<Record<string, DatasetAccess>> {
  const rules: RlsRule[] = [];
  for (let page = 0; ; page++) {
    const r = await client.get<{ result: RlsRule[]; count: number }>(`/api/v1/rowlevelsecurity/?q=${rison({ page, page_size: 100 })}`);
    rules.push(...r.result);
    if (!r.result.length || rules.length >= r.count) break;
  }
  const has = (rule: RlsRule) => rule.roles.some((x) => roles.includes(x.name));
  return Object.fromEntries(
    datasets.map((id) => {
      // A regular rule is for its roles; a base rule is for everyone but its roles.
      const applying = rules.filter((r) => r.tables.some((t) => t.id === id) && (r.filter_type === "Base" ? !has(r) : has(r)));
      const groups = new Map<string, string[]>();
      const rls: string[] = [];
      for (const r of applying) r.group_key ? groups.set(r.group_key, [...(groups.get(r.group_key) ?? []), r.clause]) : rls.push(r.clause);
      for (const g of groups.values()) rls.push(g.length === 1 ? g[0]! : g.map((c) => `(${c})`).join(" OR "));
      return [String(id), { access: true, rls }];
    }),
  );
}

/** What a refusal tells a user about data or a dashboard their Superset access keeps from them. */
export const SUPERSET_HIDDEN_REASON = "your Superset access doesn't include it. A Superset admin can give you access.";
/** What it tells them while Superset can't be asked: nothing is shown until it can. */
export const SUPERSET_UNREACHABLE_REASON = "Lenspack could not check your Superset access just now, so nothing is shown. Try again in a minute.";

/** The dashboards one user may open, of these ids, as Superset decides (the plugin's endpoint); none when it can't be asked. */
export async function viewableDashboards(client: SupersetClient, user: string, ids: number[]): Promise<Set<number>> {
  if (!ids.length) return new Set();
  try {
    const r = await client.get<{ result: { dashboards?: Record<string, boolean> } }>(`/api/v1/lenspack/access?user=${encodeURIComponent(user)}&datasets=&dashboards=${ids.join(",")}`);
    return new Set(ids.filter((id) => r.result.dashboards?.[String(id)] === true));
  } catch {
    return new Set();
  }
}

type HostAnswer = Pick<Identity, "scope" | "hiddenEntities" | "hiddenBoards" | "hiddenReason">;

/**
 * Each user's Superset access as policy, kept for ttlMs (60 s) per user: the datasets and bound dashboards kept from
 * them, and RLS as scope. A failure to ask Superset keeps every dataset and dashboard from that user until the next
 * try, rather than showing them the service account's. A dashboard bound after the answer was read counts as kept
 * until the next one (the request Superset signs for it still opens it).
 */
export type HostPolicy = (user: string, roles: string[] | undefined) => Promise<HostAnswer>;

export function supersetPolicy(o: { client: SupersetClient; binding: Binding; log: (s: string) => void; dashboards?: () => number[]; ttlMs?: number; now?: () => number }): HostPolicy {
  const ttl = o.ttlMs ?? 60_000;
  const now = o.now ?? Date.now;
  const datasets = [...o.binding.entityOf.keys()];
  const cache = new Map<string, { at: number; value: Promise<HostAnswer> }>();
  let plugin = true;
  const boardsOf = (ids: number[], open: (id: number) => boolean) => {
    const hiddenBoards = ids.filter((id) => !open(id)).map((id) => `superset-${id}`);
    return hiddenBoards.length ? { hiddenBoards } : {};
  };
  const ask = async (user: string, roles: string[] | undefined): Promise<HostAnswer> => {
    const dashboards = o.dashboards?.() ?? [];
    try {
      if (plugin) {
        try {
          const r = await o.client.get<{ result: { datasets: Record<string, DatasetAccess>; dashboards?: Record<string, boolean> } }>(
            `/api/v1/lenspack/access?user=${encodeURIComponent(user)}&datasets=${datasets.join(",")}${dashboards.length ? `&dashboards=${dashboards.join(",")}` : ""}`,
          );
          // A plugin from before dashboards were asked about answers none: each counts as kept.
          return { ...identityFrom(r.result.datasets, o.binding, o.log, user), ...boardsOf(dashboards, (id) => r.result.dashboards?.[String(id)] === true), hiddenReason: SUPERSET_HIDDEN_REASON };
        } catch (e) {
          // Superset's own 404 (no such route), not the endpoint's (no such user).
          if (!(e instanceof SupersetError && e.status === 404 && (e.body as { message?: string } | undefined)?.message !== "no such user")) throw e;
          plugin = false;
          o.log("access: lenspack_superset.py has no /api/v1/lenspack/access; reading RLS rules from Superset's REST API (dataset permissions need the plugin)");
        }
      }
      // A regular rule is matched by role: without the signed roles (an older plugin), it cannot be.
      if (!roles) throw new Error("the identity carries no Superset roles; update lenspack_superset.py");
      // Superset's REST API can't say who may open a dashboard: each counts as kept, but for the one a request is signed for.
      return { ...identityFrom(await stockAccess(o.client, datasets, roles), o.binding, o.log, user), ...boardsOf(dashboards, () => false), hiddenReason: SUPERSET_HIDDEN_REASON };
    } catch (e) {
      o.log(`access: could not ask Superset about ${user} (${e instanceof Error ? e.message : String(e)}); every dataset and dashboard is kept from them for now`);
      cache.delete(user);
      return { hiddenEntities: [...o.binding.entityOf.values()], ...boardsOf(dashboards, () => false), hiddenReason: SUPERSET_UNREACHABLE_REASON };
    }
  };
  return (user, roles) => {
    const hit = cache.get(user);
    if (hit && now() - hit.at < ttl) return hit.value;
    const value = ask(user, roles);
    cache.set(user, { at: now(), value });
    return value;
  };
}
