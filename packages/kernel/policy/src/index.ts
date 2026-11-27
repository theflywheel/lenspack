import { type Catalogue, type Ownership, type ScopeClause, filterClauseSchema, queryKeys } from "@lenspack/core";
import { type Pack, operands, parseExpr } from "@lenspack/pack";
import { z } from "zod";

import { API_KEY_PREFIX, API_KEY_ROLE, type AdminAccess, PASSWORD_PREFIX, PASSWORD_ROLE } from "./access";
import { inBoardScope } from "./board-scope";
import { type EditScopeFacts, inEditScope } from "./personal";

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
  /** The host's stable id for the user (Superset's user id), when it has one: rules may name it as "id:<n>". */
  userId?: string | number;
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
   * The only boards the deployment puts the assistant on, for this caller: its listed boards and the copies of them
   * people made (boardScope "listed", boardsInScope()). Any other board is neither listed nor opened, as if absent.
   * Absent: every board. Like hiddenBoards, it only narrows.
   */
  onlyBoards?: string[];
  /**
   * Entities the host lets this caller read on one board only, by board id, with the row scope on each (Superset's
   * dashboard roles: a dashboard opened through one reads its charts' datasets, there and nowhere else). They stay
   * among hiddenEntities everywhere else; decide() for that board, which the caller may open, reads them. See
   * boardGrant().
   */
  boardEntities?: Record<string, BoardEntities>;
  /**
   * The deployment keeps edits to the caller's own boards (Superset's editScope: own): `own` lists the boards that
   * are theirs, admins edit as before while `adminsExempt`, and `why` is the refusal anywhere else. It narrows
   * boardRights' edit, never widens it. See editScopeFacts().
   */
  editScope?: EditScopeFacts;
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
  /** May use the assistant at all (the deployment's users rule, settled by principalOf). Absent: yes. See mayUse(). */
  uses?: boolean;
  /**
   * Set when the caller may read a board and ask about it, but not change it: the chat still answers,
   * and every edit tool replies with this message (e.g. "you can view this dashboard but not edit it").
   * Absent, a caller without the edit right gets 403 from the chat.
   */
  readOnly?: string;
};

/** What a host lets a caller read on one board only: the entities, and the row scope on them (each clause names its entity). */
export type BoardEntities = { entities: string[]; scope?: ScopeClause[] };

/** An identity with its rights settled: maintain implies edit, usage follows maintain unless set. Absent maintain is no. */
export type Principal = Identity & { roles: string[]; edit: boolean; usage: boolean };

/**
 * Rights by user name, "role:<name>" for anyone with that role or group, or "*". `admins` says who holds Lenspack's
 * admin role (ADMIN_ROLE): absent, whoever the host already gave a role named "admin" (DEFAULT_ADMINS). `users` says
 * who may use the assistant at all: absent, everyone signed in; admins always may.
 */
export type Rights = { editors: string[]; maintainers: string[]; usage?: string[]; admins?: string[]; users?: string[] };
export const NO_RIGHTS: Rights = { editors: [], maintainers: [] };

/** Lenspack's admin role: what adminRights() reads. principalOf() alone gives it, by the deployment's admins rule. */
export const ADMIN_ROLE = "admin";
/** The admins rule when a deployment names none: a role named "admin", as every sign-in had before the rule existed. */
export const DEFAULT_ADMINS: readonly string[] = [`role:${ADMIN_ROLE}`];

/**
 * The principal an identity is under the deployment's rights by user and role. Rights only add, except Lenspack's
 * admin role: the admins rule alone decides it, so a host role that happens to be called "admin" counts only when
 * the rule names it (the default does). Applying it twice changes nothing.
 */
export function principalOf(id: Identity, rights: Rights = NO_RIGHTS): Principal {
  const given = id.roles ?? [];
  // A role: entry matches roles only, so a user named like one gets nothing from it.
  const among = (list: readonly string[]) => list.some((e) => e === "*" || matchesEntry(id, e, given));
  // The one place a host's roles become Lenspack's admin role.
  const admin = among(rights.admins ?? DEFAULT_ADMINS);
  // The admin sign-in's and the API keys' marks are never a host's to give (passwordAdmin() and apiKeyAdmin() add them after this).
  const own = given.filter((r) => r !== PASSWORD_ROLE && r !== API_KEY_ROLE);
  const roles = admin ? (own.includes(ADMIN_ROLE) ? own : [...own, ADMIN_ROLE]) : own.filter((r) => r !== ADMIN_ROLE);
  const maintain = !!id.maintain || among(rights.maintainers);
  const usage = id.usage ?? (rights.usage ? among(rights.usage) : maintain);
  // The users rule switches the assistant on per person; admins always pass. Once settled "no", it stays no.
  const uses = id.uses !== false && (admin || !rights.users || among(rights.users));
  const { user, userId, tenant, scope, hidden, hiddenEntities, hiddenBoards, onlyBoards, boardEntities, hiddenReason, packs, grants, readOnly, editScope } = id;
  // Only what is set, so a principal compares equal to the one it was built from.
  return {
    user,
    ...(userId !== undefined ? { userId } : {}),
    roles,
    edit: maintain || !!id.edit || among(rights.editors),
    maintain: maintain || undefined,
    usage,
    tenant: tenant || undefined,
    scope,
    hidden,
    hiddenEntities,
    ...(hiddenBoards ? { hiddenBoards } : {}),
    ...(onlyBoards ? { onlyBoards } : {}),
    ...(boardEntities ? { boardEntities } : {}),
    ...(hiddenReason ? { hiddenReason } : {}),
    ...(editScope ? { editScope } : {}),
    packs,
    grants,
    readOnly: readOnly || undefined,
    ...(uses ? {} : { uses: false }),
  };
}

/** The refusal for someone the users rule leaves out, from every route that answers with data or the chat. */
export const NOT_TURNED_ON_MESSAGE = "The assistant isn't turned on for your account. An admin can turn it on for you.";

/**
 * Whether a principal may use the assistant at all: the button, the chat, boards and data. The deployment's users
 * rule (principalOf) decides it; absent, everyone signed in may. Admins always may.
 */
export const mayUse = (who: Pick<Identity, "uses">) => who.uses !== false;

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
  /**
   * The entities this context reads only because it is on this board (boardGrant). Part of the access a saved answer
   * is kept under, so one made here never serves another board or a caller without the same grant.
   */
  onBoard?: { board: string; entities: readonly string[] };
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

/**
 * The viewer's dashboard selections (field → picked value) as a turn may carry them: only those on a dimension of the
 * pack this caller may use, or on the time range. Any other (a filter on a column the pack leaves out, such as one a
 * deployment excludes, or on a key kept from the caller) is dropped here, so its value never reaches the model, a saved
 * answer's key, telemetry or the answer card. `dropped` says how many were, so the card can say a filter on the
 * dashboard was not used.
 */
export function viewerSelections(selections: Record<string, string> | undefined, pack: Pick<Pack, "dimensions">, ctx: Pick<Scoped, "hidden">): { selections: Record<string, string>; dropped: number } {
  const keys = new Set(pack.dimensions.map((d) => d.key));
  const kept: Record<string, string> = {};
  let dropped = 0;
  for (const [field, value] of Object.entries(selections ?? {})) {
    if ((field === "time" || keys.has(field)) && !ctx.hidden?.has(field)) kept[field] = value;
    else dropped++;
  }
  return { selections: kept, dropped };
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

/**
 * What the host lets a caller read on one board beyond what they read everywhere: the entities kept from them in
 * general that the host opens on this board, and the row scope on those. Nothing when no board is named, when the
 * caller may not open the board (boardRights), or when the host grants nothing there. A grant can't open an entity
 * the host doesn't keep from the caller in the first place, and its scope only ever covers the entities it opens.
 */
export function boardGrant(who: Pick<Identity, "hiddenEntities" | "hiddenBoards" | "onlyBoards" | "boardEntities">, board?: string): { entities: string[]; scope: ScopeClause[] } | null {
  if (board === undefined || who.hiddenBoards?.includes(board) || !inBoardScope(who, board)) return null;
  const grant = Object.hasOwn(who.boardEntities ?? {}, board) ? who.boardEntities![board] : undefined;
  const kept = new Set(who.hiddenEntities ?? []);
  const entities = [...new Set(grant?.entities ?? [])].filter((e) => kept.has(e)).sort();
  if (!entities.length) return null;
  return { entities, scope: (grant!.scope ?? []).filter((c) => c.entity !== undefined && entities.includes(c.entity)) };
}

const ruleHidden = new WeakMap<PackRule, ReadonlySet<string>>();
const NONE: ReadonlySet<string> = new Set();

/**
 * What a caller may use of a pack, or null: they may not open it. That is a
 * pack their identity or the pack's rules keep from them, or one pinned to
 * another tenant (otherTenant). `rules` are the pack's access rules (absent:
 * open to everyone signed in); `host` is the pack's own context (a pinned
 * tenant, a scope every caller gets). `board`: the board the request is on; the entities the host lets the caller read
 * there only (boardGrant) are read on it, with their row scope, and nowhere else. The pack's rules narrow them as any.
 */
export function decide<C extends Scoped>(who: Principal, pack: Pack, o: { name?: string; rules?: PackRule[]; host?: C; board?: string } = {}): Decision<C> | null {
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
  const onBoard = boardGrant(who, o.board);
  const off = new Set((who.hiddenEntities ?? []).filter((e) => !onBoard?.entities.includes(e)));
  const fromHost = [...(who.hidden ?? []), ...pack.measures.filter((m) => off.has(m.entity)).map((m) => m.key), ...pack.dimensions.filter((d) => [d.entity, ...Object.keys(d.also ?? {})].every((e) => off.has(e))).map((d) => d.key)];
  const byHost = fromHost.length ? hiddenKeys(pack, { hide: fromHost }) : NONE;
  const hidden = byHost.size ? new Set([...byHost, ...(fromRule ?? [])]) : (fromRule ?? NONE);
  // What the host keeps, and its words for why: a refusal of one of these says it is the caller's access.
  const accessHidden = byHost.size || off.size ? { keys: new Set([...byHost, ...off]), reason: who.hiddenReason ?? DEFAULT_HIDDEN_REASON } : undefined;
  const host = o.host ?? ({} as C);
  const scope = [...(host.scope ?? []), ...(who.scope ?? []), ...(onBoard?.scope ?? []), ...(rule?.scope ?? [])];
  const granted = onBoard ? { onBoard: { board: o.board!, entities: onBoard.entities } } : {};
  const ctx = { ...host, ...(who.tenant ? { tenant: who.tenant } : {}), ...(scope.length ? { scope } : {}), ...(hidden.size ? { hidden } : {}), ...(off.size ? { hiddenEntities: off } : {}), ...(accessHidden ? { accessHidden } : {}), ...granted } as C;
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

/**
 * What a principal may do on a deployment's admin pages, decided here so every host and every page asks the same
 * question. administer: see and change the settings, the saved answers, the definitions, the open questions and the
 * daily review: Lenspack's admin role, which principalOf() gives by the deployment's admins rule (by default, a role
 * named "admin"; under Superset, the Superset roles its auth.admins names), never a dashboard's edit right. users:
 * also see who asked what (usernames on the usage board and in review reports), which needs the usage right as well.
 * Neither widens what anyone may read of the data.
 */
export type AdminRights = {
  administer: boolean;
  users: boolean;
  /** May grant admin (superset-users): an owner, a password admin (the way in when owners are locked out), or an admin API key. */
  owner: boolean;
  /** How they qualify, for the admins roster: a role (and which), an owner, a grant, a named password or an admin API key. */
  via?: "role" | "owner" | "grant" | "password" | "api-key";
  /** The role's name, the password's name, or the key's name. */
  detail?: string;
};
/**
 * With `access` (access.ts), the deployment's way of deciding admins is applied here too: under named users, only the
 * owners and the users they granted administer, and only owners (or a password admin) may grant; under the password,
 * only a password admin whose name is still on the list; under superset-role, the role. Modes combine: any one lets a
 * person in. An admin API key (apiKeyAdmin, access.ts) administers in every mode while its name is still set, and may
 * grant. A host user named like a password admin ("admin:…") or a key ("api:…") never administers. Without `access`, the admin role
 * principalOf() settled decides, as for every caller already settled under rightsUnder(access, …).
 */
export function adminRights(who: { user?: string; userId?: string | number | null; roles?: readonly string[]; usage?: boolean }, access?: AdminAccess): AdminRights {
  const role = !!who.roles?.includes(ADMIN_ROLE);
  const signedIn = !!who.user?.startsWith(PASSWORD_PREFIX) && !!who.roles?.includes(PASSWORD_ROLE);
  const keyed = !!who.user?.startsWith(API_KEY_PREFIX) && !!who.roles?.includes(API_KEY_ROLE);
  const out = (administer: boolean, owner: boolean, via?: AdminRights["via"], detail?: string): AdminRights => ({ administer, users: administer && !!who.usage, owner: administer && owner, ...(administer && via ? { via } : {}), ...(administer && detail ? { detail } : {}) });
  if (!access) return out(role, false, signedIn ? "password" : keyed ? "api-key" : role ? "role" : undefined);
  const has = (m: AdminAccess["modes"][number]) => access.modes.includes(m);
  // An admin API key: the master override, in every mode, while its name is still set; it may grant admins too.
  if (keyed) {
    const name = who.user!.slice(API_KEY_PREFIX.length);
    return out(role && !!access.apiKeys?.includes(name), true, "api-key", name);
  }
  if (signedIn) {
    const name = who.user!.slice(PASSWORD_PREFIX.length);
    return out(role && has("password") && access.passwords.includes(name), true, "password", name);
  }
  if (!who.user || who.user.startsWith(PASSWORD_PREFIX) || who.user.startsWith(API_KEY_PREFIX)) return out(false, false);
  const id = { user: who.user, userId: who.userId ?? undefined };
  if (has("superset-users")) {
    const named = (list: readonly string[]) => list.some((e) => matchesEntry(id, e));
    // No owners: nobody administers this way, whatever was granted before (fail closed).
    if (!access.owners.length) return out(false, false);
    if (named(access.owners)) return out(true, true, "owner");
    return out(named(access.granted), false, "grant");
  }
  if (has("superset-role")) {
    const matched = (access.roles ?? []).find((e) => matchesEntry(id, e, who.roles ?? []));
    return out(role, false, "role", matched ? matched.replace(/^role:/, "") : undefined);
  }
  return out(false, false);
}

/**
 * Whether one entry of a rule names this identity: "role:<name>" a role it holds, "id:<n>" its host id (userId), else
 * its user name exactly.
 */
export function matchesEntry(id: { user: string; userId?: string | number }, entry: string, roles: readonly string[] = []): boolean {
  if (entry.startsWith("role:")) return roles.includes(entry.slice(5));
  if (entry.startsWith("id:")) return id.userId !== undefined && id.userId !== null && String(id.userId) === entry.slice(3);
  return entry === id.user;
}

/** May use the admin pages at all (adminRights().administer). */
export const mayAdminister = (who: { roles?: readonly string[] }) => adminRights(who).administer;

// The pack's own boards (no owner) are everyone's to read and a maintainer's
// to change. A board someone made is theirs to change, and everyone's to read
// once they share it: everyone in their tenant, as one user name may sign in
// under two tenants. A board the host keeps from the caller (a dashboard they
// may not view in Superset), or one outside the deployment's board scope (onlyBoards), is neither read nor changed,
// whatever else holds. Where the deployment keeps edits to
// people's own boards (editScope), any other board is read-only to them, and `readOnly` says why.
export function boardRights(who: Principal, b: Ownership & { id?: string }): { view: boolean; edit: boolean; readOnly?: string } {
  if (b.id !== undefined && (who.hiddenBoards?.includes(b.id) || !inBoardScope(who, b.id))) return { view: false, edit: false };
  const sameTenant = (b.tenant ?? "") === (who.tenant ?? "");
  const edit = b.owner ? b.owner === who.user && sameTenant && who.edit : !!who.maintain;
  const outOfScope = edit && !inEditScope(who, b.id);
  return {
    view: !b.owner || (sameTenant && (!!b.shared || b.owner === who.user)),
    edit: edit && !outOfScope,
    ...(outOfScope ? { readOnly: who.editScope!.why } : {}),
  };
}

// --- the deployment's own records -------------------------------------------------
//
// What a caller may do with what the deployment keeps about its own use: the settings page, the usage telemetry log,
// kept recordings of spoken questions, and the user names in them. Today these follow Lenspack's admin role, as the
// settings page always has (adminRights); the coming policy document narrows them per role. Nothing here can widen them.

export type RecordRights = {
  /** The settings page and its changes. */
  settings: boolean;
  /** The usage telemetry log (docs/features/telemetry.md). */
  telemetry: boolean;
  /** User names in that log, as written; without this right a reader sees a stable stand-in for each name. */
  usernames: boolean;
  /** Kept recordings: list, play, delete, export. */
  audio: boolean;
};

/** What a caller may read of the deployment's records. User names need the usage right too, which already means "may see who used it". */
export function recordRights(who: Identity): RecordRights {
  const { administer, users } = adminRights(principalOf(who));
  return { settings: administer, telemetry: administer, usernames: users, audio: administer };
}

/** Whether a caller may report on a turn (feedback, a corrected transcript, a left answer): only their own, in their own tenant. */
export const reportsOn = (who: Pick<Identity, "user" | "tenant">, turn: { user: string; tenant?: string | null }) => turn.user === who.user && (turn.tenant ?? "") === (who.tenant ?? "");

// --- the deployment's context --------------------------------------------------------
//
// What a board, a dataset or a role belongs to in the deployment's own terms: a campaign, its type and a country.
// Lenspack does not model an organisation; the deployment says this once, here, and readers (usage telemetry first)
// take it from here. It is a section of the deployment's policy, ready for the coming policy document.

export const CONTEXT_FIELDS = ["campaign", "campaignType", "country"] as const;
export type ContextField = (typeof CONTEXT_FIELDS)[number];
const contextText = z.string().min(1).max(120);

/**
 * Keys: a board id ("superset-12"), a dataset name, "role:<name>" for a role or group, or "*" for everything else.
 * Values: any of campaign, campaignType and country, each a short text.
 */
export const deploymentContextSchema = z.record(z.string().min(1).max(200), z.object({ campaign: contextText.optional(), campaignType: contextText.optional(), country: contextText.optional() }).strict());
export type DeploymentContext = z.infer<typeof deploymentContextSchema>;

/**
 * The campaign, campaign type and country one moment of use counts for. Each field comes from the first key that
 * sets it, in this order: the board, each dataset (in the order used), each of the caller's roles ("role:<name>"),
 * then "*". Nothing matching leaves the field null.
 */
export function contextFor(map: DeploymentContext, at: { board?: string | null; datasets?: string[]; roles?: string[] }): Record<ContextField, string | null> {
  const keys = [...(at.board ? [at.board] : []), ...(at.datasets ?? []), ...(at.roles ?? []).map((r) => `role:${r}`), "*"];
  const out = { campaign: null, campaignType: null, country: null } as Record<ContextField, string | null>;
  for (const field of CONTEXT_FIELDS) out[field] = keys.map((k) => map[k]?.[field]).find((v): v is string => typeof v === "string") ?? null;
  return out;
}

export * from "./personal";
export * from "./access";
export * from "./surface";
export * from "./board-scope";
export * from "./tabs";
export * from "./pack-layer";
export * from "./query-safety";
export * from "./runtime-config";
export * from "./query-checks";
