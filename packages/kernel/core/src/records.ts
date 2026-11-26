import type { BoardConfig } from "./schema";

// Host state that has to outlive the process and be shared by every copy of the server: people's own
// dashboards and their saved layouts. Kept behind one small keyed interface, so a host can keep it in a
// file today and in a database table tomorrow without anything above it changing.

/** A small keyed store: one record per id, read and written whole. Implementations must be safe to share between processes. */
export interface RecordStore<T> {
  list(): Promise<T[]>;
  get(id: string): Promise<T | null>;
  put(id: string, value: T): Promise<void>;
  /** True when there was a record to delete. */
  delete(id: string): Promise<boolean>;
}

/** A store that keeps records in this process only: for tests and previews, never for a deployment. */
export function memoryRecords<T>(): RecordStore<T> {
  const m = new Map<string, T>();
  return {
    list: async () => [...m.values()].map((v) => structuredClone(v)),
    get: async (id) => (m.has(id) ? structuredClone(m.get(id)!) : null),
    put: async (id, v) => void m.set(id, structuredClone(v)),
    delete: async (id) => m.delete(id),
  };
}

/** A dashboard someone made for themselves through Lenspack: blank, or a copy of one they could view. */
export type PersonalDashboard = {
  /** The host's id for the dashboard (Superset's dashboard id). */
  dashboard: number;
  /** Lenspack's board for it. */
  board: string;
  /** Who it is for, as the host names them. */
  owner: string;
  /** The host's numeric id for that person (Superset's user id), so the dashboard can be theirs there too. */
  ownerId: number;
  title: string;
  /** The dashboard it was copied from; null for a blank one. */
  from: number | null;
  createdAt: string;
  /** Charts made for it (the copies of the original's charts): removed with it when nothing else uses them. */
  charts: number[];
};

/**
 * A board's layout and settings saved under a name, against the person who saved it, to apply later to a
 * dashboard they control. `sharing` is reserved for sharing with others later; nothing reads it yet.
 */
export type SavedLayout = {
  id: string;
  owner: string;
  name: string;
  /** Where it was saved from. */
  source: { board: string; dashboard: number | null; title: string };
  savedAt: string;
  renamedAt?: string;
  /** The pack, and its version, the widgets were written against. */
  pack: string;
  packVersion: number;
  config: BoardConfig;
  /** Widgets that stood for host charts Lenspack cannot redraw: never copied to another dashboard. */
  locked: string[];
  /** Reserved: who else may see and apply it. Not used yet. */
  sharing?: { users?: string[]; roles?: string[] };
};

export type PersonalResult<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string; code?: string };

/** A dashboard as the chat and the panel name it. */
export type PersonalDashboardRef = { dashboard: number; board: string; title: string; url: string };

/**
 * What a chat turn may do with the caller's own dashboards and saved layouts. A host implements it for
 * the signed-in person and the dashboard the turn is about; every call is checked by policy there.
 */
export interface PersonalPort {
  /** Whether the edit tools' "read only" answer should offer a copy of this dashboard the caller can change. */
  readonly offersCopy: boolean;
  /** The host would let the caller edit this dashboard, but the deployment keeps chat edits to their own dashboards. */
  readonly ownOnly?: boolean;
  mine(): Promise<{ dashboards: PersonalDashboardRef[]; layouts: { id: string; name: string; from: string; savedAt: string }[] }>;
  createDashboard(title: string): Promise<PersonalResult<PersonalDashboardRef>>;
  /** A copy of the turn's dashboard, the caller's own, its charts copied. */
  copyDashboard(title?: string): Promise<PersonalResult<PersonalDashboardRef & { from: number }>>;
  /** One of the caller's own dashboards, by title or id. */
  deleteDashboard(which: string): Promise<PersonalResult<{ dashboard: number; title: string }>>;
  saveLayout(name: string, config: BoardConfig): Promise<PersonalResult<{ id: string; name: string; replaced: boolean }>>;
  /** A saved layout to apply to the turn's dashboard, when the caller may. Also the turn dashboard's widgets the host keeps as its own. */
  layoutToApply(which: string, canEdit: boolean): Promise<PersonalResult<{ layout: SavedLayout; targetLocked: string[] }>>;
  renameLayout(which: string, name: string): Promise<PersonalResult<{ id: string; name: string }>>;
  deleteLayout(which: string): Promise<PersonalResult<{ id: string; name: string }>>;
  /** Told when a saved layout was applied through the chat (the audit line). */
  applied(layout: SavedLayout, outcome: { version?: number; skipped: number; held?: boolean }): void;
}
