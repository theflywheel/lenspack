// People's own dashboards and saved layouts, kept in Superset and in Lenspack's state directory.
//
// A person may make a dashboard of their own, blank or as a copy of one they can view, and delete the ones
// they own. A copy is a real Superset dashboard with copies of the original's charts (Superset's own copy
// API), owned by that person in Superset, so they can share or delete it there too, and editing it never
// touches the original's charts. Lenspack does this through its own account (an Admin), so it sets the
// person as owner itself, and every allow or deny comes from @lenspack/policy, never from that account's
// rights. A person may also save a dashboard's layout under a name and apply it later, as one undoable
// change, to any dashboard they may edit. Both lists live behind RecordStore (a file today).

import { type BoardConfig, type PersonalDashboard, type PersonalDashboardRef, type PersonalPort, type PersonalResult, type RecordStore, type SavedLayout } from "@lenspack/core";
import { type Capabilities, type Ctx, type FittedLayout, fitSavedLayout } from "@lenspack/engine";
import type { Pack } from "@lenspack/pack";
import {
  type BoardScope,
  type PersonalActor,
  type PersonalLimits,
  type Verdict,
  layoutsShownTo,
  mayApplyLayout,
  mayCopyDashboard,
  mayCreateDashboard,
  mayDeleteDashboard,
  mayManageLayout,
  maySaveLayout,
  mayViewAllPersonal,
  boardsInScope,
} from "@lenspack/policy";

import type { SupersetClient } from "./client";
import { madeBoards } from "./dashboard-scope";
import { type Position as LayoutPosition, layoutProblems, placeCharts, withRoot } from "./layout";
import type { SupersetBoards } from "./store";

/** A layout as read from Superset's position_json, loosely typed (layout.ts has the strict shape). */
type Position = Record<string, any>;

/** What the audit log is told: one line per create, copy, delete, save, apply and rename. */
export type PersonalAuditEvent = { at: string; user: string; pack?: string; board?: string; action: string; outcome: "ok" | "refused" | "denied"; detail?: string };

/**
 * One action, as usage telemetry records it (docs/features/telemetry.md, item personal-dashboards): event
 * "personal-dashboard" (how: create, copy, delete) or "saved-layout" (how: save, apply, rename, delete), with ids
 * and counts only, never titles or names. The audit log has every one either way.
 */
export type PersonalEvent = {
  event: "personal-dashboard" | "saved-layout";
  how: "create" | "copy" | "delete" | "save" | "apply" | "rename";
  user: string;
  roles: string[];
  board: string | null;
  data: Record<string, string | number>;
  at: string;
};

export type PersonalOptions = {
  client: SupersetClient;
  store: SupersetBoards;
  /** The pack, or how to read the one in force (an admin can change it while the server runs). */
  pack: Pack | (() => Pack);
  /** Binds a dashboard to a board (reading it from Superset) and returns the board's id. */
  bindBoard: (dashboard: number) => Promise<string>;
  links: RecordStore<PersonalDashboard>;
  layouts: RecordStore<SavedLayout>;
  /** Read on every request, so an admin's change applies at once. */
  limits: () => PersonalLimits;
  /** The deployment's dashboard scope: the person's own dashboards are listed to them only when in it. Absent: any. */
  boardScope?: () => BoardScope;
  audit?: (e: PersonalAuditEvent) => void;
  telemetry?: (e: PersonalEvent) => void;
  log?: (line: string) => void;
  now?: () => Date;
  /** For tests: a layout id. */
  newId?: () => string;
};

type Dash = { id: number; dashboard_title: string; position_json: string | null; json_metadata: string | null; css?: string | null; owners?: { id: number }[] };

const refusal = (v: Verdict & { ok: false }) => ({ ok: false as const, error: v.why, code: v.code });
const urlOf = (base: string, id: number) => `${base}/superset/dashboard/${id}/`;

/** The rights Superset signed for one dashboard, read by the host from its identity header. */
export type SignedRights = { dashboard: number | null; view: boolean; edit: boolean; /** Superset would allow the edit; the edit scope doesn't. */ byScope?: boolean };

export function personalDashboards(o: PersonalOptions) {
  const { client, store } = o;
  const packNow = () => (typeof o.pack === "function" ? o.pack() : o.pack);
  const log = o.log ?? (() => {});
  const now = () => (o.now ?? (() => new Date()))().toISOString();
  const newId = o.newId ?? (() => `l_${Math.random().toString(36).slice(2, 10)}`);
  const audit = (who: PersonalActor, action: string, outcome: PersonalAuditEvent["outcome"], board?: string, detail?: string) => {
    try {
      o.audit?.({ at: now(), user: who.user, pack: packNow().pack, ...(board ? { board } : {}), action, outcome, ...(detail ? { detail: detail.slice(0, 300) } : {}) });
    } catch (e) {
      log(`audit failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const emit = (who: PersonalActor, event: PersonalEvent["event"], how: PersonalEvent["how"], board: string | null, data: PersonalEvent["data"] = {}) => {
    try {
      o.telemetry?.({ event, how, user: who.user, roles: [...(who.hostRoles ?? [])], board, data, at: now() });
    } catch {
      /* a sink must never fail a request */
    }
  };
  const denied = (who: PersonalActor, action: string, v: Verdict & { ok: false }, board?: string) => {
    audit(who, action, v.code === "limit" || v.code === "off" ? "refused" : "denied", board, v.why);
    return refusal(v);
  };

  /** The person's own dashboards, less any deleted in Superset meanwhile (their links are dropped). */
  async function mineOf(who: PersonalActor): Promise<PersonalDashboard[]> {
    const all = (await o.links.list()).filter((l) => l.owner === who.user);
    const live: PersonalDashboard[] = [];
    for (const l of all) {
      try {
        const d = await client.get<{ result: { dashboard_title: string } }>(`/api/v1/dashboard/${l.dashboard}`);
        live.push({ ...l, title: d.result.dashboard_title });
      } catch (e) {
        if ((e as { status?: number }).status === 404) {
          await o.links.delete(String(l.dashboard));
          await store.forget(l.board).catch(() => {});
          log(`dashboard ${l.dashboard} (${l.owner}'s) is gone from Superset; dropped`);
        } else live.push(l);
      }
    }
    return live.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** The person's own dashboards as listed to them: those the deployment's dashboard scope covers (boardsInScope). */
  async function shownOf(mine: PersonalDashboard[]): Promise<PersonalDashboard[]> {
    const scope = o.boardScope?.();
    if (!scope || scope.scope === "any") return mine;
    const ok = new Set(boardsInScope(scope, madeBoards(await o.links.list()), { personalOn: true }));
    return mine.filter((d) => ok.has(d.board));
  }

  async function record(who: PersonalActor, dashboard: number, title: string, from: number | null, charts: number[]) {
    const board = await o.bindBoard(dashboard);
    const link: PersonalDashboard = { dashboard, board, owner: who.user, ownerId: who.userId!, title, from, createdAt: now(), charts };
    await o.links.put(String(dashboard), link);
    return link;
  }

  /**
   * A dashboard of someone's own starts as a draft with no dashboard roles: a copy of B carries none of the roles
   * that open B (Superset's DASHBOARD_RBAC), so only its owner (and admins) open it until they share it in Superset.
   */
  const PRIVATE_DRAFT = { published: false, roles: [] as number[] };

  /** A new, empty dashboard of the person's own. */
  async function create(who: PersonalActor, title: string, base = ""): Promise<PersonalResult<PersonalDashboardRef>> {
    const v = mayCreateDashboard(who, o.limits(), (await mineOf(who)).length);
    if (!v.ok) return denied(who, "dashboard-create", v);
    const name = title.trim().slice(0, 160) || "My dashboard";
    // A layout Superset can draw from the start (ROOT → GRID), so the first change to it has nothing to repair.
    const made = await client.post<{ id: number }>("/api/v1/dashboard/", { dashboard_title: name, owners: [who.userId], position_json: JSON.stringify(withRoot({})), ...PRIVATE_DRAFT });
    const link = await record(who, made.id, name, null, []);
    audit(who, "dashboard-create", "ok", link.board, `dashboard ${made.id} “${name}”`);
    emit(who, "personal-dashboard", "create", `superset-${made.id}`, { dashboard: made.id });
    return { ok: true, dashboard: made.id, board: link.board, title: name, url: urlOf(base, made.id) };
  }

  /** A copy of a dashboard the person may view, with copies of its charts, theirs in Superset. */
  async function copy(who: PersonalActor, source: SignedRights & { dashboard: number }, title?: string, base = ""): Promise<PersonalResult<PersonalDashboardRef & { from: number }>> {
    const v = mayCopyDashboard(who, o.limits(), (await mineOf(who)).length, source);
    if (!v.ok) return denied(who, "dashboard-copy", v, `superset-${source.dashboard}`);
    const [{ result: dash }, { result: charts }] = await Promise.all([
      client.get<{ result: Dash }>(`/api/v1/dashboard/${source.dashboard}`),
      client.get<{ result: { id: number }[] }>(`/api/v1/dashboard/${source.dashboard}/charts`),
    ]);
    const name = (title?.trim() || `${dash.dashboard_title.slice(0, 140)} (my copy)`).slice(0, 160);
    const original: Position = dash.position_json ? JSON.parse(dash.position_json) : {};
    const positions = completePositions(original, charts.map((c) => c.id));
    // Never a layout Superset can't draw (layoutProblems, layout.ts); problems the original already had are left as they were.
    const had = new Set(layoutProblems(withRoot(structuredClone(original) as LayoutPosition)));
    const wrong = layoutProblems(positions as LayoutPosition).filter((p) => !had.has(p));
    if (wrong.length) {
      log(`copy of dashboard ${source.dashboard} refused: ${wrong.join("; ")}`);
      audit(who, "dashboard-copy", "refused", `superset-${source.dashboard}`, `layout not valid: ${wrong.slice(0, 3).join("; ").slice(0, 200)}`);
      return { ok: false, error: "This dashboard's layout could not be copied as it is. Ask a Superset admin to open and save it in Superset, then try again.", code: "invalid" };
    }
    const meta = parseMeta(dash.json_metadata);
    // Superset copies the charts and renames the layout's chart ids; it reads them from `positions`.
    const made = await client.post<{ result: { id: number } }>(`/api/v1/dashboard/${source.dashboard}/copy/`, {
      dashboard_title: name,
      duplicate_slices: true,
      json_metadata: JSON.stringify({ ...meta, positions }),
      ...(dash.css ? { css: dash.css } : {}),
    });
    const id = made.result.id;
    let map = new Map<number, number>();
    try {
      const { result: copied } = await client.get<{ result: Dash }>(`/api/v1/dashboard/${id}`);
      map = chartIdMap(positions, copied.position_json ? JSON.parse(copied.position_json) : {});
      // The copy's filter bar still names the original's charts: point it at the copies.
      const copiedMeta = remapChartIds(parseMeta(copied.json_metadata), map);
      await client.put(`/api/v1/dashboard/${id}`, { owners: [who.userId], json_metadata: JSON.stringify(copiedMeta), ...PRIVATE_DRAFT });
    } catch (e) {
      // Superset made the copy as Lenspack's account: never leave it there, unowned by the person and unlisted.
      await client.delete(`/api/v1/dashboard/${id}`).catch(() => {});
      for (const c of map.values()) await client.delete(`/api/v1/chart/${c}`).catch(() => {});
      audit(who, "dashboard-copy", "refused", `superset-${source.dashboard}`, `copy ${id} removed: ${(e as Error).message.slice(0, 200)}`);
      throw e;
    }
    const newCharts = [...map.values()];
    for (const c of newCharts) await client.put(`/api/v1/chart/${c}`, { owners: [who.userId] }).catch((e) => log(`chart ${c}: could not make it ${who.user}'s: ${e.message}`));
    const link = await record(who, id, name, source.dashboard, newCharts);
    audit(who, "dashboard-copy", "ok", link.board, `dashboard ${id} “${name}” from ${source.dashboard} (${newCharts.length} charts copied)`);
    emit(who, "personal-dashboard", "copy", `superset-${id}`, { dashboard: id, from: source.dashboard, charts: newCharts.length });
    return { ok: true, dashboard: id, board: link.board, title: name, url: urlOf(base, id), from: source.dashboard };
  }

  /** Deletes a dashboard its owner (or an admin) names, with the charts made for it that nothing else uses. */
  async function remove(who: PersonalActor, dashboard: number): Promise<PersonalResult<{ dashboard: number; title: string }>> {
    const board = `superset-${dashboard}`;
    let dash: Dash;
    try {
      dash = (await client.get<{ result: Dash }>(`/api/v1/dashboard/${dashboard}`)).result;
    } catch (e) {
      if ((e as { status?: number }).status === 404) return { ok: false, error: `There is no dashboard ${dashboard}.`, code: "missing" };
      throw e;
    }
    const link = await o.links.get(String(dashboard));
    // An admin may delete a personal dashboard (one Lenspack made); any other is its owners' alone.
    const v = mayDeleteDashboard(who, o.limits(), { owners: (dash.owners ?? []).map((x) => x.id), personal: !!link });
    if (!v.ok) return denied(who, "dashboard-delete", v, board);
    const candidates = [...new Set([...(link?.charts ?? []), ...store.createdOf(board)])];
    await client.delete(`/api/v1/dashboard/${dashboard}`);
    let removed = 0;
    for (const c of candidates) {
      try {
        const chart = await client.get<{ result: { dashboards?: { id: number }[] } }>(`/api/v1/chart/${c}`);
        if ((chart.result.dashboards ?? []).some((d) => d.id !== dashboard)) continue;
        await client.delete(`/api/v1/chart/${c}`);
        removed++;
      } catch {
        /* gone already, or kept: never fails the delete */
      }
    }
    await o.links.delete(String(dashboard));
    await store.forget(board).catch(() => {});
    audit(who, "dashboard-delete", "ok", board, `dashboard ${dashboard} “${dash.dashboard_title}”${removed ? ` and ${removed} of its charts` : ""}${link ? "" : " (not made through the assistant)"}`);
    emit(who, "personal-dashboard", "delete", `superset-${dashboard}`, { dashboard });
    return { ok: true, dashboard, title: dash.dashboard_title };
  }

  /** One of the person's own dashboards by id or title. */
  async function findMine(who: PersonalActor, which: string): Promise<PersonalDashboard | string> {
    const mine = await mineOf(who);
    const w = which.trim().toLowerCase().replace(/^#/, "");
    const hit = pick(mine, w, (d) => [String(d.dashboard), d.board, d.title.toLowerCase()]);
    if (typeof hit !== "string") return hit;
    return hit === "none" ? `You have no dashboard of your own called “${which}”.${mine.length ? ` Yours: ${mine.map((d) => `“${d.title}” (${d.dashboard})`).join(", ")}.` : " You have none yet."}` : `Several of your dashboards match “${which}”: ${mine.filter((d) => d.title.toLowerCase().includes(w)).map((d) => `“${d.title}” (${d.dashboard})`).join(", ")}. Say which by its id.`;
  }

  /** A saved layout the person may manage, by id or name. */
  async function findLayout(who: PersonalActor, which: string): Promise<SavedLayout | string> {
    const shown = layoutsShownTo(who, await o.layouts.list());
    const own = shown.filter((l) => l.owner === who.user);
    const w = which.trim().toLowerCase();
    // Their own first, so an admin's "morning layout" is theirs, not someone else's of that name.
    for (const list of [own, shown]) {
      const hit = pick(list, w, (l) => [l.id.toLowerCase(), l.name.toLowerCase()]);
      if (typeof hit !== "string") return hit;
      if (hit === "many") return `Several saved layouts match “${which}”: ${list.filter((l) => l.name.toLowerCase().includes(w)).map((l) => `“${l.name}”`).join(", ")}. Say which.`;
    }
    return `You have no saved layout called “${which}”.${own.length ? ` Yours: ${own.map((l) => `“${l.name}”`).join(", ")}.` : " You have none yet."}`;
  }

  async function saveLayout(who: PersonalActor, source: SignedRights & { board: string }, name: string, config: BoardConfig, title?: string): Promise<PersonalResult<{ id: string; name: string; replaced: boolean; charts: number; superset: number }>> {
    const clean = name.trim().replace(/\s+/g, " ").slice(0, 80);
    if (!clean) return { ok: false, error: "Give the layout a name.", code: "invalid" };
    const own = (await o.layouts.list()).filter((l) => l.owner === who.user);
    const same = own.find((l) => l.name.toLowerCase() === clean.toLowerCase());
    const v = maySaveLayout(who, o.limits(), own.length, source, !!same);
    if (!v.ok) return denied(who, "layout-save", v, source.board);
    const layout: SavedLayout = {
      id: same?.id ?? newId(),
      owner: who.user,
      name: clean,
      source: { board: source.board, dashboard: source.dashboard, title: title ?? config.title },
      savedAt: now(),
      pack: config.pack,
      packVersion: config.packVersion,
      config,
      locked: store.lockedOf(source.board).filter((w) => config.widgets[w]),
    };
    await o.layouts.put(layout.id, layout);
    audit(who, "layout-save", "ok", source.board, `“${clean}”${same ? " (replaced)" : ""}, ${Object.keys(config.widgets).length} widgets`);
    emit(who, "saved-layout", "save", source.dashboard ? `superset-${source.dashboard}` : null, { layout: layout.id });
    // charts, and how many of them were made in Superset: those stay with this dashboard (the panel says so).
    return { ok: true, id: layout.id, name: clean, replaced: !!same, charts: Object.keys(config.widgets).length, superset: layout.locked.length };
  }

  async function layoutToApply(who: PersonalActor, which: string, target: { board: string; edit: boolean }): Promise<PersonalResult<{ layout: SavedLayout; targetLocked: string[] }>> {
    const found = await findLayout(who, which);
    if (typeof found === "string") return { ok: false, error: found, code: "missing" };
    const v = mayApplyLayout(who, o.limits(), found, target);
    if (!v.ok) return denied(who, "layout-apply", v, target.board);
    // Superset's latest first (a chart removed there since the last read), so the chat fits the layout to the board as it is.
    await store.pull(target.board).catch((e: Error) => log(`${target.board}: could not read Superset: ${e.message}`));
    return { ok: true, layout: found, targetLocked: store.lockedOf(target.board) };
  }

  /** Applies a saved layout to a board as one change (the panel's menu; the chat goes through its own store). */
  async function applyLayout(who: PersonalActor, which: string, target: { board: string; edit: boolean; ctx: Ctx; capabilities?: Capabilities }, base = ""): Promise<PersonalResult<{ version: number; previous: number; name: string; from: { dashboard: number | null; title: string; url: string | null } } & Pick<FittedLayout, "skipped" | "skippedFilters" | "packChanged" | "carried">>> {
    const got = await layoutToApply(who, which, target);
    if (!got.ok) return got;
    if (!(await store.get(target.board))) return { ok: false, error: "The assistant has not opened this dashboard yet.", code: "missing" };
    // Fitted to the board as it is when written (Superset's latest read first), never to an earlier read: a chart
    // removed in Superset in between is left out, not brought back.
    let previous = 0;
    const { board: saved, made: fit } = await store.replaceFrom(
      target.board,
      (board, locked) => ((previous = board.version), fitSavedLayout(got.layout.config, board.config, packNow(), { ctx: target.ctx, capabilities: target.capabilities, savedLocked: got.layout.locked, targetLocked: locked })),
      { source: "layout", summary: `applied saved layout “${got.layout.name}”` },
    );
    applied(who, got.layout, target.board, { version: saved.version, skipped: fit.skipped.length });
    const src = got.layout.source;
    return { ok: true, version: saved.version, previous, name: got.layout.name, skipped: fit.skipped, skippedFilters: fit.skippedFilters, packChanged: fit.packChanged, carried: fit.carried, from: { dashboard: src.dashboard ?? null, title: src.title, url: src.dashboard ? urlOf(base, src.dashboard) : null } };
  }

  function applied(who: PersonalActor, layout: SavedLayout, board: string, r: { version?: number; skipped: number; held?: boolean }) {
    audit(who, "layout-apply", "ok", board, `“${layout.name}”${layout.owner !== who.user ? ` (${layout.owner}'s)` : ""}${r.version !== undefined ? ` → ${r.held ? "draft " : ""}v${r.version}` : ""}${r.skipped ? `, ${r.skipped} widget(s) left out` : ""}`);
    emit(who, "saved-layout", "apply", board, { layout: layout.id, skipped: r.skipped });
  }

  async function renameLayout(who: PersonalActor, which: string, name: string): Promise<PersonalResult<{ id: string; name: string }>> {
    const found = await findLayout(who, which);
    if (typeof found === "string") return { ok: false, error: found, code: "missing" };
    const v = mayManageLayout(who, o.limits(), found);
    if (!v.ok) return denied(who, "layout-rename", v);
    const clean = name.trim().replace(/\s+/g, " ").slice(0, 80);
    if (!clean) return { ok: false, error: "Give the layout a name.", code: "invalid" };
    const clash = (await o.layouts.list()).find((l) => l.owner === found.owner && l.id !== found.id && l.name.toLowerCase() === clean.toLowerCase());
    if (clash) return { ok: false, error: `There is already a saved layout called “${clash.name}”.`, code: "invalid" };
    await o.layouts.put(found.id, { ...found, name: clean, renamedAt: now() });
    audit(who, "layout-rename", "ok", undefined, `“${found.name}” → “${clean}”${found.owner !== who.user ? ` (${found.owner}'s)` : ""}`);
    emit(who, "saved-layout", "rename", null, { layout: found.id });
    return { ok: true, id: found.id, name: clean };
  }

  async function deleteLayout(who: PersonalActor, which: string): Promise<PersonalResult<{ id: string; name: string }>> {
    const found = await findLayout(who, which);
    if (typeof found === "string") return { ok: false, error: found, code: "missing" };
    const v = mayManageLayout(who, o.limits(), found);
    if (!v.ok) return denied(who, "layout-delete", v);
    await o.layouts.delete(found.id);
    audit(who, "layout-delete", "ok", undefined, `“${found.name}”${found.owner !== who.user ? ` (${found.owner}'s)` : ""}`);
    emit(who, "saved-layout", "delete", null, { layout: found.id });
    return { ok: true, id: found.id, name: found.name };
  }

  // superset: how many of its charts were made in Superset (they stay with the dashboard the layout came from).
  const layoutView = (l: SavedLayout) => ({ id: l.id, name: l.name, owner: l.owner, from: l.source.title, fromDashboard: l.source.dashboard, savedAt: l.savedAt, widgets: Object.keys(l.config.widgets).length, superset: (l.locked ?? []).filter((w) => l.config.widgets[w]).length });
  const dashboardView = (d: PersonalDashboard, base = "") => ({ dashboard: d.dashboard, board: d.board, title: d.title, from: d.from, createdAt: d.createdAt, url: urlOf(base, d.dashboard) });

  /** What the panel's menus show: the person's own dashboards and layouts, and what they may do here. */
  async function overview(who: PersonalActor, here: SignedRights | null, base = "") {
    const limits = o.limits();
    const [mine, layouts] = await Promise.all([limits.on ? mineOf(who) : Promise.resolve([]), limits.on ? o.layouts.list() : Promise.resolve([])]);
    const own = layouts.filter((l) => l.owner === who.user);
    const onHere = here?.dashboard ? mine.find((d) => d.dashboard === here.dashboard) : undefined;
    return {
      on: limits.on,
      limits: { maxDashboardsPerUser: limits.maxDashboardsPerUser, maxSavedLayoutsPerUser: limits.maxSavedLayoutsPerUser },
      canCreate: mayCreateDashboard(who, limits, mine.length).ok,
      // Superset lets them write dashboards at all: without it the panel offers no create, copy or apply.
      canWrite: !!who.writes,
      dashboards: (await shownOf(mine)).map((d) => dashboardView(d, base)),
      layouts: layoutsShownTo(who, layouts).map(layoutView),
      ownLayouts: own.length,
      here: here?.dashboard
        ? {
            dashboard: here.dashboard,
            view: here.view,
            edit: here.edit && !!who.writes,
            mine: !!onHere,
            canCopy: mayCopyDashboard(who, limits, mine.length, here).ok,
            canSave: maySaveLayout(who, limits, own.length, here).ok || own.length >= limits.maxSavedLayoutsPerUser,
            // Charts on this dashboard made in Superset: a layout saved here carries them to no other dashboard.
            superset: store.lockedOf(`superset-${here.dashboard}`).length,
          }
        : null,
    };
  }

  /** The admin view: everyone's personal dashboards and saved layouts, by person. */
  async function everyone(who: PersonalActor, base = "") {
    const v = mayViewAllPersonal(who);
    if (!v.ok) return refusal(v);
    const [links, layouts] = await Promise.all([o.links.list(), o.layouts.list()]);
    const users = [...new Set([...links.map((l) => l.owner), ...layouts.map((l) => l.owner)])].sort();
    return {
      ok: true as const,
      limits: o.limits(),
      users: users.map((u) => ({
        user: u,
        dashboards: links.filter((l) => l.owner === u).map((d) => dashboardView(d, base)),
        layouts: layouts.filter((l) => l.owner === u).map(layoutView),
      })),
    };
  }

  /** The chat's view of all this for one person on one dashboard. */
  function port(who: PersonalActor, here: SignedRights & { dashboard: number; board: string }, base = ""): PersonalPort {
    return {
      offersCopy: mayCopyDashboard(who, o.limits(), 0, here).ok,
      ownOnly: !!here.byScope,
      async mine() {
        const [d, l] = await Promise.all([mineOf(who).then(shownOf), o.layouts.list()]);
        return { dashboards: d.map((x) => ({ dashboard: x.dashboard, board: x.board, title: x.title, url: urlOf(base, x.dashboard) })), layouts: layoutsShownTo(who, l).map((x) => ({ id: x.id, name: x.name, from: x.source.title, savedAt: x.savedAt })) };
      },
      createDashboard: (title) => create(who, title, base),
      copyDashboard: (title) => copy(who, here, title, base),
      async deleteDashboard(which) {
        const d = await findMine(who, which);
        if (typeof d === "string") return { ok: false, error: d, code: "missing" };
        return remove(who, d.dashboard);
      },
      saveLayout: (name, config) => saveLayout(who, here, name, config),
      layoutToApply: (which, canEdit) => layoutToApply(who, which, { board: here.board, edit: canEdit && here.edit }),
      renameLayout: (which, name) => renameLayout(who, which, name),
      deleteLayout: (which) => deleteLayout(who, which),
      applied: (layout, r) => applied(who, layout, here.board, r),
    };
  }

  return { create, copy, remove, saveLayout, applyLayout, layoutToApply, renameLayout, deleteLayout, overview, everyone, port, mineOf, findLayout };
}

export type PersonalDashboards = ReturnType<typeof personalDashboards>;

/** Exactly one match by an exact key, else by a unique part of the name: the item, "none" or "many". */
function pick<T>(items: T[], w: string, keys: (t: T) => string[]): T | "none" | "many" {
  if (!w) return "none";
  const exact = items.filter((t) => keys(t).includes(w));
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) return "many";
  const part = items.filter((t) => keys(t).some((k) => k.includes(w)));
  return part.length === 1 ? part[0]! : part.length ? "many" : "none";
}

function parseMeta(json: string | null | undefined): Record<string, any> {
  try {
    const v = json ? JSON.parse(json) : {};
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/**
 * A dashboard's layout with every one of its charts drawn, for Superset's copy. The copy keeps only the charts its
 * layout places (a chart on the dashboard but not in the layout would be copied and then left on no dashboard), so
 * the ones it lacks are placed where Superset draws such charts: the first top-level tab, else the grid
 * (placeCharts, layout.ts).
 */
export function completePositions(given: Position | null | undefined, chartIds: number[]): Position {
  const pos: Position = placeCharts(structuredClone(given ?? {}) as LayoutPosition, chartIds, { prefix: "copy" });
  pos.DASHBOARD_VERSION_KEY ??= "v2";
  return pos;
}

/** The original chart id → its copy's, read from the two layouts (Superset keeps each component's id when it copies). */
export function chartIdMap(before: Position, after: Position): Map<number, number> {
  const map = new Map<number, number>();
  for (const [k, c] of Object.entries(before)) {
    const a = after[k];
    if (c && typeof c === "object" && c.type === "CHART" && a && typeof a === "object" && a.type === "CHART" && typeof c.meta?.chartId === "number" && typeof a.meta?.chartId === "number") map.set(c.meta.chartId, a.meta.chartId);
  }
  return map;
}

/** json_metadata with the original's chart ids replaced by the copies' where Superset leaves them: the filter bar's scopes and cross-filter settings. */
export function remapChartIds(meta: Record<string, any>, map: Map<number, number>): Record<string, any> {
  if (!map.size) return meta;
  const ids = (list: unknown) => (Array.isArray(list) ? list.map((x) => (typeof x === "number" && map.has(x) ? map.get(x) : x)) : list);
  const out = structuredClone(meta);
  for (const f of Array.isArray(out.native_filter_configuration) ? out.native_filter_configuration : []) {
    if (!f || typeof f !== "object") continue;
    if (f.chartsInScope) f.chartsInScope = ids(f.chartsInScope);
    if (f.scope?.excluded) f.scope.excluded = ids(f.scope.excluded);
  }
  if (out.chart_configuration && typeof out.chart_configuration === "object") {
    const next: Record<string, any> = {};
    for (const [k, v] of Object.entries<any>(out.chart_configuration)) {
      const id = map.get(Number(k));
      const c = structuredClone(v);
      if (c && typeof c === "object") {
        if (id !== undefined && c.id !== undefined) c.id = id;
        if (c.crossFilters?.chartsInScope) c.crossFilters.chartsInScope = ids(c.crossFilters.chartsInScope);
        if (c.crossFilters?.scope?.excluded) c.crossFilters.scope.excluded = ids(c.crossFilters.scope.excluded);
      }
      next[id !== undefined ? String(id) : k] = c;
    }
    out.chart_configuration = next;
  }
  if (out.global_chart_configuration?.chartsInScope) out.global_chart_configuration.chartsInScope = ids(out.global_chart_configuration.chartsInScope);
  if (out.global_chart_configuration?.scope?.excluded) out.global_chart_configuration.scope.excluded = ids(out.global_chart_configuration.scope.excluded);
  if (Array.isArray(out.timed_refresh_immune_slices)) out.timed_refresh_immune_slices = ids(out.timed_refresh_immune_slices);
  return out;
}
