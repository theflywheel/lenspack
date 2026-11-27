// The deployment's data boundary while the server runs (docs/hosts/superset/runtime.md#the-boundary-narrows-only):
// the datasets, the row scope, the dashboards, the host and edit policies, and who may administer and use the
// assistant. The deploy config sets it; an admin, or an admin API key, may only narrow it here. Whether a value narrows
// is policy's (@lenspack/policy boundary.ts); this file keeps the narrowing in settings.json (section "boundary"),
// answers PUT <prefix>/settings/boundary, and has the pack built again when the datasets or the scope change.

import { BOUNDARY_FIELDS, type Boundary, type BoundaryNarrowing, boundaryRefusals, narrowedBoundary, narrowingStillValid, narrowingWith } from "@lenspack/policy";
import type { SettingsStore } from "@lenspack/serve";

import { dashboardBoard, dashboardLabel } from "./dashboard-scope";
import type { Area } from "./runtime-settings";

type Rebuilt = { ok: true; warnings: string[] } | { ok: false; status: number; problems: string[] };

/** The boundary as the settings API shows it: dashboards by their Superset ids. */
function shown(b: Partial<Boundary>): Record<string, unknown> {
  const { dashboards, ...rest } = b;
  return { ...rest, ...(dashboards ? { dashboards: dashboards.scope === "any" ? { scope: "any" } : { scope: "listed", dashboards: dashboards.boards.map((d) => Number(dashboardLabel(d))) } } : {}) };
}

export function boundarySetup(o: {
  deploy: Boundary;
  settings: SettingsStore;
  log: (line: string) => void;
  /** Builds the pack for these datasets and this scope, checked first; calls commit, then swaps it in, only when it passes. */
  rebuild: (next: Boundary, commit: () => void) => Promise<Rebuilt>;
}) {
  // A narrowing saved earlier that no longer narrows (the deploy config changed since) is set aside, and said.
  const checked = narrowingStillValid(o.deploy, o.settings.get<BoundaryNarrowing>("boundary") ?? {});
  let narrowing = checked.kept;
  let notApplied = checked.dropped;
  for (const w of notApplied) o.log(`warning: a saved narrowing of the boundary is not applied, as the deploy config changed: ${w}`);
  const now = () => narrowedBoundary(o.deploy, narrowing);
  if (Object.keys(narrowing).length) o.log(`boundary: narrowed by an admin (${Object.keys(narrowing).join(", ")}); the deploy config's is the widest it can be`);

  const area: Area = {
    name: "boundary",
    view: (writable) => ({
      rule: "narrow only: a change here may keep fewer datasets, add scope clauses, keep fewer dashboards, turn the host or edit policy on and keep fewer access modes, roles, owners or seeded people; widening needs the deploy config",
      fields: BOUNDARY_FIELDS,
      deploy: shown(o.deploy),
      narrowed: shown({ ...narrowing, ...(narrowing.dashboards ? { dashboards: { scope: "listed", boards: narrowing.dashboards } } : {}) } as Partial<Boundary>),
      now: shown(now()),
      ...(notApplied.length ? { notApplied } : {}),
      source: Object.keys(narrowing).length ? "settings" : "config",
      writable,
    }),
    async update(body) {
      const asked: Record<string, unknown> = { ...body };
      if (asked.dashboards !== undefined && asked.dashboards !== null) {
        const ids = asked.dashboards;
        if (!Array.isArray(ids) || ids.some((d) => !Number.isSafeInteger(d) || (d as number) <= 0)) return { ok: false, error: "dashboards is a list of Superset dashboard ids, like [25, 31]" };
        asked.dashboards = ids.map((d) => dashboardBoard(d as number));
      }
      if (!Object.keys(asked).length) return { ok: false, error: `send one or more of ${BOUNDARY_FIELDS.join(", ")}; null hands a field back to the deploy config` };
      const why = boundaryRefusals(o.deploy, asked, narrowing);
      if (why.length) return { ok: false, error: why.join("; ") };
      const next = narrowingWith(narrowing, asked);
      const was = now();
      const will = narrowedBoundary(o.deploy, next);
      const commit = () => {
        o.settings.set("boundary", Object.keys(next).length ? next : undefined);
        narrowing = next;
        notApplied = [];
      };
      const detail = Object.entries(body)
        .map(([k, v]) => (v === null ? `${k} back to the deploy config's` : `${k} ${JSON.stringify(v)}`))
        .join("; ");
      // Other datasets or another scope: the pack is built again and checked before anything changes.
      if (JSON.stringify(was.datasets) !== JSON.stringify(will.datasets) || JSON.stringify(was.scope) !== JSON.stringify(will.scope)) {
        const r = await o.rebuild(will, commit);
        if (!r.ok) return { ok: false, status: r.status, error: `the pack can't be built for this boundary, so nothing changed: ${r.problems.join("; ")}` };
        return { ok: true, detail: `${detail} (pack built again${r.warnings.length ? `; ${r.warnings.length} warning(s)` : ""})` };
      }
      commit();
      return { ok: true, detail };
    },
  };
  return { deploy: o.deploy, now, area };
}
