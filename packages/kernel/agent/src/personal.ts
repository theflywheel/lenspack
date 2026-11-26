import { z } from "zod";

import type { BoardConfig, BoardStore, PersonalPort } from "@lenspack/core";
import { type Connector, type Ctx, fitSavedLayout } from "@lenspack/engine";
import type { Pack } from "@lenspack/pack";

import { str } from "./args";
import { type Tool, defineTool } from "./tools";

// The chat's tools for the caller's own dashboards and saved layouts: part of the edit mode. Making,
// copying and deleting a dashboard and saving a layout never change the dashboard the turn is on; applying
// a saved layout does, as one change through the turn's own store (so it is held for the reviewer, saved
// as one version and undone like any other edit). Every right is decided by the host's PersonalPort.

export type PersonalToolsOptions = {
  port: PersonalPort;
  pack: Pack;
  connector: Connector;
  store: BoardStore;
  boardId: string;
  ctx: Ctx;
  /** Set when the caller may not change this board: applying a layout answers with it, and offers a copy. */
  readOnly?: string;
  /** The board as the caller is shown it, in words. */
  shown: (config: BoardConfig) => unknown;
  /** The edit queue of the turn's board tools, so an apply never interleaves with another edit. */
  edit: (work: () => Promise<{ applied: boolean; [k: string]: unknown }>) => Promise<unknown>;
  /** Reads wait for queued edits. */
  afterEdits: <T>(read: () => Promise<T>) => Promise<T>;
  held?: boolean;
};

const result = <T extends object>(r: { ok: true } & T | { ok: false; error: string; code?: string }) => (r.ok ? r : { ok: false, applied: false, error: r.error, ...(r.code ? { code: r.code } : {}) });

export function personalTools(o: PersonalToolsOptions): Tool[] {
  const { port } = o;
  return [
    defineTool({
      name: "list_my_dashboards",
      description: "The user's own dashboards (made or copied through this chat) and their saved layouts, by name. Call this before applying, renaming or deleting one the user names loosely.",
      inputSchema: z.object({}),
      execute: async () => ({ ok: true, ...(await port.mine()) }),
    }),
    defineTool({
      name: "create_dashboard",
      description: "Make a new, empty dashboard that belongs to the user, with this title. It does not change the dashboard this chat is on. The reply should give the link so they can open it; the chat works there too.",
      inputSchema: z.object({ title: str().describe("The new dashboard's title") }),
      execute: async ({ title }) => result(await port.createDashboard(title.trim() || "My dashboard")),
    }),
    defineTool({
      name: "copy_dashboard",
      description:
        'Make the user their own copy of the dashboard this chat is on, with copies of its charts, so they can change it without changing the original. Use it when they ask for their own copy, or accept one after a change was refused because they can only view this dashboard. then: the change they asked for, in their words, to make on the copy once it opens (empty for none). The reply gives the link.',
      inputSchema: z.object({ title: str().describe("The copy's title (empty: the original's, marked as a copy)"), then: str().describe("The change to make on the copy, in the user's words, or empty") }),
      async execute({ title, then }) {
        const r = await port.copyDashboard(title.trim() || undefined);
        return r.ok ? { ...r, ...(then.trim() ? { then: then.trim().slice(0, 1000) } : {}) } : result(r);
      },
    }),
    defineTool({
      name: "delete_dashboard",
      description: "Delete one of the user's own dashboards, by its title or id (from list_my_dashboards). Only their own; ask them to confirm first unless they already named it plainly. It cannot be undone.",
      inputSchema: z.object({ dashboard: str().describe("Its title or id") }),
      execute: async ({ dashboard }) => result(await port.deleteDashboard(dashboard)),
    }),
    defineTool({
      name: "save_layout",
      description: "Save this dashboard's current layout and settings (charts, their places, filters) under a name for the user, to apply later to a dashboard they control. Saving again under the same name replaces it. It does not change the dashboard.",
      inputSchema: z.object({ name: str().describe('The name, e.g. "Morning briefing layout"') }),
      async execute({ name }) {
        const board = await o.afterEdits(() => o.store.get(o.boardId));
        if (!board) return { ok: false, error: "This board no longer exists" };
        return result(await port.saveLayout(name.trim() || board.config.title, board.config));
      },
    }),
    defineTool({
      name: "apply_layout",
      description:
        "Put one of the user's saved layouts on this dashboard, as one change that can be undone. Charts whose measures or datasets the user can't use here are left out and named in the result: say which. Only on a dashboard they may edit; otherwise they can make their own copy first (copy_dashboard).",
      inputSchema: z.object({ layout: str().describe("The saved layout's name or id") }),
      execute: ({ layout }) =>
        o.edit(async () => {
          const got = await port.layoutToApply(layout, !o.readOnly);
          if (!got.ok) return { applied: false, error: got.error, ...(got.code ? { code: got.code } : {}), ...(got.code === "no-edit" && port.offersCopy ? { readOnly: true, offer: "copy_dashboard" } : {}) };
          const board = await o.store.get(o.boardId);
          if (!board) return { applied: false, error: "This board no longer exists" };
          const fit = fitSavedLayout(got.layout.config, board.config, o.pack, { ctx: o.ctx, capabilities: o.connector.capabilities, savedLocked: got.layout.locked, targetLocked: got.targetLocked });
          const saved = await o.store.replaceConfig({ id: o.boardId, config: fit.config, source: "chat", summary: `applied saved layout “${got.layout.name}”` });
          port.applied(got.layout, { version: saved.version, skipped: fit.skipped.length, held: o.held });
          return {
            applied: true,
            layout: got.layout.name,
            version: saved.version,
            ...(o.held ? { held: true } : {}),
            ...(fit.skipped.length ? { skipped: fit.skipped.map((s) => `“${s.title}”: ${s.why}`) } : {}),
            ...(fit.skippedFilters.length ? { skippedFilters: fit.skippedFilters.map((s) => `“${s.label}”: ${s.why}`) } : {}),
            ...(fit.packChanged ? { note: "The layout was saved against an earlier version of the metrics; charts that no longer fit were left out." } : {}),
            board: o.shown(saved.config),
          };
        }),
    }),
    defineTool({
      name: "rename_layout",
      description: "Rename one of the user's saved layouts.",
      inputSchema: z.object({ layout: str().describe("Its current name or id"), name: str().describe("The new name") }),
      execute: async ({ layout, name }) => result(await port.renameLayout(layout, name)),
    }),
    defineTool({
      name: "delete_layout",
      description: "Delete one of the user's saved layouts. It does not change any dashboard.",
      inputSchema: z.object({ layout: str().describe("Its name or id") }),
      execute: async ({ layout }) => result(await port.deleteLayout(layout)),
    }),
  ];
}
