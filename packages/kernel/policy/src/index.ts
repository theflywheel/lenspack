import { type Catalogue, type Ownership, type ScopeClause, filterClauseSchema, queryKeys } from "@lenspack/core";
import { type Pack, operands, parseExpr } from "@lenspack/pack";
import { z } from "zod";

// Who may see and change what, as one pure function of the caller, the pack
// and the deployment's rules. The host that knows the user (a sign-in, a
// login proxy, Superset, CCRS) says who they are and what it already allows:
// that is the Identity. Lenspack's own rules (rights by role, a pack's access
// rules) can only narrow it: their scope is added to the host's, their hidden
// keys to the host's. The engine enforces the result (ctx.scope, ctx.hidden)
// without knowing where it came from.

/** Who a caller is, as a host or sign-in says: a user, their roles, and what the host itself grants or limits. */
export type Identity = {
  user: string;
  /** Roles and groups from the identity provider: what rights by role and a pack's access rules match. */
  roles?: string[];
  /** Narrows every query to this tenant. Must agree with a tenant the pack is pinned to. */
  tenant?: string;
  /** Row scope: filters every query carries, whatever the board asks; one with an entity, every query reading it. */
  scope?: ScopeClause[];
  /** Keys the host already keeps from this caller; a pack's rules add to them. */
  hidden?: string[];
  /** Entities (tables, datasets) the host does not let this caller read: their keys are hidden and a query reading one is refused. */
  hiddenEntities?: string[];
  /** Boards the host does not let this caller open (a host dashboard they may not view): not listed, and opened as if absent. */
  hiddenBoards?: string[];
  /**
   * Why the host keeps keys, entities or boards from this caller, in words for them ("your Superset access doesn't
   * include it. A Superset admin can give you access."). A refusal of something the host keeps says it
   * (ACCESS_HIDDEN), so the caller learns it is their access, not that the data does not exist.
   */
  hiddenReason?: string;
  /** The packs this caller may open; absent means all. */
  packs?: string[];
  /** Capabilities the host grants (CCRS action URLs); absent: a trusted caller, who holds every one. */
  grants?: string[];
  /** May make boards of their own, and change (ops, layout, revert, chat), share and delete them. */
  edit?: boolean;
  /** May also change the pack's own boards, for everyone. Implies edit. */
  maintain?: boolean;
  /** May read the AI usage page, which names every user. Absent: as maintain. */
  usage?: boolean;
  /**
   * Set when the caller may read a board and ask about it, but not change it: the chat still answers,
   * and every edit tool replies with this message (e.g. "you can view this dashboard but not edit it").
   * Absent, a caller without the edit right gets 403 from the chat.
   */
  readOnly?: string;
};

/** An identity with its rights settled: maintain implies edit, usage follows maintain unless set. Absent maintain is no. */
export type Principal = Identity & { roles: string[]; edit: boolean; usage: boolean };

/** Rights by user name, "role:<name>" for anyone with that role or group, or "*". */
export type Rights = { editors: string[]; maintainers: string[]; usage?: string[] };
export const NO_RIGHTS: Rights = { editors: [], maintainers: [] };

/** The principal an identity is under the deployment's rights by user and role. Rights only add; applying it twice changes nothing. */
export function principalOf(id: Identity, rights: Rights = NO_RIGHTS): Principal {
  const roles = id.roles ?? [];
  // A role: entry matches roles only, so a user named like one gets nothing from it.
  const among = (list: string[]) => list.some((e) => e === "*" || (e.startsWith("role:") ? roles.includes(e.slice(5)) : e === id.user));
  const maintain = !!id.maintain || among(rights.maintainers);
  // Open question, not applied: the usage page for admins only would be `const usage = roles.includes("admin");`
  const usage = id.usage ?? (rights.usage ? among(rights.usage) : maintain);
  const { user, tenant, scope, hidden, hiddenEntities, hiddenBoards, hiddenReason, packs, grants, readOnly } = id;
  // Only what is set, so a principal compares equal to the one it was built from.
  return {
    user,
    roles,
    edit: maintain || !!id.edit || among(rights.editors),
    maintain: maintain || undefined,
    usage,
    tenant: tenant || undefined,
    scope,
    hidden,
    hiddenEntities,
    ...(hiddenBoards ? { hiddenBoards } : {}),
    ...(hiddenReason ? { hiddenReason } : {}),
    packs,
    grants,
    readOnly: readOnly || undefined,
  };
}

/** Whether a caller holds a host grant; with none named, whether they are trusted with every one. */
export const holds = (who: Pick<Identity, "grants">, grant?: string) => !who.grants || (grant !== undefined && who.grants.includes(grant));

/**
 * Who may open a pack, and what of it they see. Rules are tried in order and
 * the first whose roles the caller has decides: hide (or only) names the
 * dimensions and measures they may not (or only may) use, and scope adds row
 * filters to every query they run. A caller no rule matches does not see the
 * pack. A pack with no rules is open to everyone signed in.
 */
export const packRuleSchema = z
  .object({
    /** Roles or groups this rule is for; "*" for everyone signed in. */
    roles: z.array(z.string().min(1)).min(1),
    hide: z.array(z.string().min(1)).optional(),
    only: z.array(z.string().min(1)).optional(),
    scope: z.array(filterClauseSchema).optional(),
  })
  .strict()
  .refine((r) => !(r.hide && r.only), { message: "a rule has hide or only, not both" });
export type PackRule = z.infer<typeof packRuleSchema>;

/**
 * The keys a rule (or a host's hidden list) keeps from its callers. A measure
 * computed from a hidden one is hidden with it: a ratio or a per-level target
 * says what its parts are. An unknown key is an error, so a typo cannot leave
 * a key showing.
 */
export function hiddenKeys(pack: Pack, rule: Partial<PackRule>): ReadonlySet<string> {
  const keys = [...pack.dimensions.map((d) => d.key), ...pack.measures.map((m) => m.key)];
  for (const k of [...(rule.hide ?? []), ...(rule.only ?? [])]) if (!keys.includes(k)) throw new Error(`an access rule of pack "${pack.pack}" names "${k}", which is not one of its dimensions or measures`);
  const hidden = new Set(rule.only ? keys.filter((k) => !rule.only!.includes(k)) : (rule.hide ?? []));
  const parts = (m: Pack["measures"][number]) => [...(m.derived ? operands(parseExpr(m.derived)) : []), ...Object.values(m.levels ?? {})];
  for (let grew = true; grew; ) {
    grew = false;
    for (const m of pack.measures)
      if (!hidden.has(m.key) && parts(m).some((k) => hidden.has(k))) {
        hidden.add(m.key);
        grew = true;
      }
  }
  return hidden;
}

/**
 * The catalogue as one caller may see it: without the keys they may not use.
 * A hierarchy stops above its first hidden level, so a drill never steps
 * into one.
 */
export function withoutKeys(catalogue: Catalogue, hidden?: ReadonlySet<string>): Catalogue {
  if (!hidden?.size) return catalogue;
  const { hierarchies, ...rest } = catalogue;
  const cut = Object.entries(hierarchies ?? {})
    .map(([name, levels]) => {
      const first = levels.findIndex((l) => hidden.has(l));
      return [name, first < 0 ? levels : levels.slice(0, first)] as const;
    })
    .filter(([, levels]) => levels.length > 1);
  return {
    ...rest,
    ...(cut.length ? { hierarchies: Object.fromEntries(cut) } : {}),
    dimensions: catalogue.dimensions.filter((d) => !hidden.has(d.key)),
    measures: catalogue.measures.filter((m) => !hidden.has(m.key)),
  };
}

/**
 * A board as one caller may be shown it: a widget's filter on a key they may
 * not use keeps its key but not its value, which is that key's data. The
 * widget itself is refused when drawn; this keeps the value out of the config.
 * A board filter's default values on such a key are hidden the same way.
 */
export function withoutHiddenValues<C extends { widgets: Record<string, unknown> }>(config: C, hidden?: ReadonlySet<string>): C {
  if (!hidden?.size) return config;
  type BoardFilter = { field: string; default?: { values?: string[] } };
  const boardFilters = (config as { filters?: BoardFilter[] }).filters;
  const filters = boardFilters?.map((f) => (f.default?.values && hidden.has(f.field) ? { ...f, default: { ...f.default, values: ["(hidden)"] } } : f));
  const widgets = Object.fromEntries(
    Object.entries(config.widgets).map(([id, w]) => {
      const q = (w as { query?: { filters?: { dimension: string; value: unknown }[] } }).query;
      if (!q?.filters?.some((f) => hidden.has(f.dimension))) return [id, w];
      const filters = q.filters.map((f) => (hidden.has(f.dimension) ? { ...f, value: Array.isArray(f.value) ? ["(hidden)"] : "(hidden)" } : f));
      return [id, { ...(w as object), query: { ...q, filters } }];
    }),
  );
  return { ...config, widgets, ...(filters ? { filters } : {}) };
}

/**
 * The engine's view of a caller: what every query they run is narrowed by. Read by shape; the engine never imports this package.
 * accessHidden: the keys and entities the host (not the pack's rules) keeps from them, and why, in words for them.
 */
export type Scoped = {
  tenant?: string;
  scope?: ScopeClause[];
  hidden?: ReadonlySet<string>;
  hiddenEntities?: ReadonlySet<string>;
  accessHidden?: { keys: ReadonlySet<string>; reason: string };
};

/** What a refusal says when the host keeps something from a caller and does not say why. */
export const DEFAULT_HIDDEN_REASON = "your access doesn't include it.";

/**
 * What the chat model is told when the host keeps some of the pack from this caller: that it is their access, so a
 * question about data it cannot see is not answered with "the pack doesn't have it" (or a guess at what is hidden).
 * Null when the host keeps nothing.
 */
export function accessNote(ctx: Pick<Scoped, "accessHidden">): string | null {
  if (!ctx.accessHidden?.keys.size) return null;
  return [
    "Some of this pack's data is kept from this user by their access. It is left out of the catalogue above, and a query on it is refused.",
    "When a question needs data that is not in the catalogue, do not say the pack lacks it or could be set up to have it, and do not guess what the hidden data is or name anything that is not listed above.",
    `Say it may not be available to them: ${ctx.accessHidden.reason}`,
  ].join(" ");
}

/**
 * A board config as the caller whose engine context this is may be shown it.
 * It is the one view of a board a caller gets, whoever reads it for them: the
 * board API, a copy they make, the chat model's prompt and tools, and the
 * reviewer. Every one of them goes through here, so they cannot differ.
 */
export const shownConfig = <C extends { widgets: Record<string, unknown> }>(config: C, ctx: Pick<Scoped, "hidden">): C => withoutHiddenValues(config, ctx.hidden);

/** The catalogue as the caller whose engine context this is may see it: no hidden key, and no entity kept from them, by name. */
export function visibleCatalogue(catalogue: Catalogue, ctx: Pick<Scoped, "hidden" | "hiddenEntities">): Catalogue {
  const shown = withoutKeys(catalogue, ctx.hidden);
  const off = ctx.hiddenEntities;
  return off?.size ? { ...shown, entities: shown.entities.filter((e) => !off.has(e.key)) } : shown;
}

/** The caller's tenant is not the one the pack is pinned to. A tenant may narrow an unpinned pack, never open another tenant's. */
export const otherTenant = (who: Pick<Identity, "tenant">, host?: Pick<Scoped, "tenant">) => !!(who.tenant && host?.tenant && who.tenant !== host.tenant);

/**
 * Whether a caller is shown the compiled statement of a query (its SQL or
 * search request). The statement reads like the pack file, and a search
 * request writes the row scope's values into it, so a caller with hidden keys
 * is not shown it: not by the API, not by the chat's tools.
 */
export const showsStatement = (ctx: Pick<Scoped, "hidden">) => !ctx.hidden?.size;

/** What a caller is shown of how an answer was worked out: the answer card under a chat reply. */
export type AnswerView = {
  /** The statement each data call ran (its SQL or search request). */
  sql: boolean;
  /** Each measure's definition, in the words: it reads like the pack file. */
  definitions: boolean;
};

/**
 * Whether a caller gets an answer card, and what is on it, or null: none. The
 * deployment's choice (`allows`: the `explain` switch and `explain.sql`) and
 * the caller's own view (showsStatement) can each only take things away: a
 * caller not shown compiled statements gets no SQL and no definitions, even
 * where the deployment shows them. Per-role grants narrow through here too.
 */
export function answerView(ctx: Pick<Scoped, "hidden">, allows: { on?: boolean; sql?: boolean } = {}): AnswerView | null {
  if (allows.on === false) return null;
  const statements = showsStatement(ctx);
  return { sql: statements && allows.sql !== false, definitions: statements };
}

/** What one caller may use of one pack. */
export type Decision<C extends Scoped = Scoped> = {
  /** Every row filter: the pack's own, the caller's, then their rule's. */
  scope: ScopeClause[];
  hidden: ReadonlySet<string>;
  /** The engine context to run with: the pack's, with the caller's tenant, scope and hidden keys. */
  ctx: C;
  catalogue(c: Catalogue): Catalogue;
  /** A board or version as the caller is sent it: its config through shownConfig. */
  board<B extends { config: { widgets: Record<string, unknown> } } | null>(b: B): B;
  /** The pack as the chat model is shown it: no example that uses a hidden key. */
  pack(): Pack;
  /**
   * When the host keeps every measure of the pack from this caller: what to tell them up front, before anything
   * asks a model ("None of this assistant's data is available to you: …"). Null when they may use some.
   */
  notice: string | null;
};

const ruleHidden = new WeakMap<PackRule, ReadonlySet<string>>();
const NONE: ReadonlySet<string> = new Set();

/**
 * What a caller may use of a pack, or null: they may not open it. That is a
 * pack their identity or the pack's rules keep from them, or one pinned to
 * another tenant (otherTenant). `rules` are the pack's access rules (absent:
 * open to everyone signed in); `host` is the pack's own context (a pinned
 * tenant, a scope every caller gets).
 */
export function decide<C extends Scoped>(who: Principal, pack: Pack, o: { name?: string; rules?: PackRule[]; host?: C } = {}): Decision<C> | null {
  if (who.packs && !who.packs.includes(o.name ?? pack.pack)) return null;
  if (otherTenant(who, o.host)) return null;
  let rule: PackRule | undefined;
  if (o.rules) {
    rule = o.rules.find((r) => r.roles.some((role) => role === "*" || who.roles.includes(role)));
    if (!rule) return null;
  }
  let fromRule = rule && ruleHidden.get(rule);
  if (rule && !fromRule) ruleHidden.set(rule, (fromRule = hiddenKeys(pack, rule)));
  // The host's hidden keys and the rule's together: either may only add. An entity kept from the
  // caller takes its measures along, and the dimensions it alone has.
  const off = new Set(who.hiddenEntities ?? []);
  const fromHost = [...(who.hidden ?? []), ...pack.measures.filter((m) => off.has(m.entity)).map((m) => m.key), ...pack.dimensions.filter((d) => [d.entity, ...Object.keys(d.also ?? {})].every((e) => off.has(e))).map((d) => d.key)];
  const byHost = fromHost.length ? hiddenKeys(pack, { hide: fromHost }) : NONE;
  const hidden = byHost.size ? new Set([...byHost, ...(fromRule ?? [])]) : (fromRule ?? NONE);
  // What the host keeps, and its words for why: a refusal of one of these says it is the caller's access.
  const accessHidden = byHost.size || off.size ? { keys: new Set([...byHost, ...off]), reason: who.hiddenReason ?? DEFAULT_HIDDEN_REASON } : undefined;
  const host = o.host ?? ({} as C);
  const scope = [...(host.scope ?? []), ...(who.scope ?? []), ...(rule?.scope ?? [])];
  const ctx = { ...host, ...(who.tenant ? { tenant: who.tenant } : {}), ...(scope.length ? { scope } : {}), ...(hidden.size ? { hidden } : {}), ...(off.size ? { hiddenEntities: off } : {}), ...(accessHidden ? { accessHidden } : {}) } as C;
  const uses = (q: Pack["examples"][number]["query"]) => {
    const k = queryKeys(q);
    return [...k.dimensions, ...k.measures].some((x) => hidden.has(x));
  };
  return {
    scope,
    hidden,
    ctx,
    // An entity the host keeps from the caller is left out by name too.
    catalogue: (c) => visibleCatalogue(c, ctx),
    board: (b) => (b && hidden.size ? { ...b, config: shownConfig(b.config, ctx) } : b),
    pack: () => (hidden.size ? { ...pack, examples: pack.examples.filter((e) => !uses(e.query)) } : pack),
    notice: accessHidden && pack.measures.length && pack.measures.every((m) => byHost.has(m.key)) ? `None of this assistant's data is available to you: ${accessHidden.reason}` : null,
  };
}

// The pack's own boards (no owner) are everyone's to read and a maintainer's
// to change. A board someone made is theirs to change, and everyone's to read
// once they share it: everyone in their tenant, as one user name may sign in
// under two tenants. A board the host keeps from the caller (a dashboard they
// may not view in Superset) is neither read nor changed, whatever else holds.
export function boardRights(who: Principal, b: Ownership & { id?: string }): { view: boolean; edit: boolean } {
  if (b.id !== undefined && who.hiddenBoards?.includes(b.id)) return { view: false, edit: false };
  const sameTenant = (b.tenant ?? "") === (who.tenant ?? "");
  return {
    view: !b.owner || (sameTenant && (!!b.shared || b.owner === who.user)),
    edit: b.owner ? b.owner === who.user && sameTenant && who.edit : !!who.maintain,
  };
}
