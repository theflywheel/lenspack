import { type DefinitionsDoc, type OverlayChange, type OverlayEntry, type OverlayInput, OVERLAY_BUDGET, definitionsDocKey, editDefinitions, emptyDefinitions, overlaySize, parseDefinitions } from "@lenspack/pack";

import { type DocStore, readDoc, updateDoc } from "./store";

// The definitions overlay as a running server keeps it: one definitions document per pack (the
// document, its checks, its versions and its merge into the pack are in @lenspack/pack), in a
// document store, read on every use so two servers sharing a store see each other's changes.

export { OverlayError, OVERLAY_BUDGET, applyOverlay, checkEntry, entryLine, overlayInstructions, overlaySize } from "@lenspack/pack";
export type { DefinitionsDoc, OverlayChange, OverlayEntry, OverlayInput, OverlayKind } from "@lenspack/pack";

export type Overlay = ReturnType<typeof overlayStore>;

/** One pack's definitions, kept as definitions-<pack>.json. keys: the pack's measures and dimensions. */
export function overlayStore(docs: DocStore, pack: string, opts: { keys: () => ReadonlySet<string>; budget?: number; now?: () => Date }) {
  const name = `definitions-${pack}.json`;
  const budget = opts.budget ?? OVERLAY_BUDGET;
  const read = async () => (await readDoc<DefinitionsDoc>(docs, name, () => emptyDefinitions(pack), (raw) => parseDefinitions(raw, pack))).value;
  const change = <R>(fn: (e: ReturnType<typeof editDefinitions>) => R) =>
    updateDoc<DefinitionsDoc, R>(
      docs,
      name,
      () => emptyDefinitions(pack),
      (current) => {
        const e = editDefinitions(current, { keys: opts.keys(), budget, now: opts.now });
        const result = fn(e);
        return { next: e.doc(), result };
      },
      (raw) => parseDefinitions(raw, pack),
    );
  return {
    name,
    budget,
    /** The whole document. */
    doc: read,
    /** The entries now, oldest first. */
    entries: async () => (await read()).entries,
    /** The changes, newest first. */
    history: async () => [...(await read()).history].reverse(),
    version: async () => (await read()).version,
    size: async () => overlaySize((await read()).entries),
    /** The version key an answer cache keys on. */
    key: async () => definitionsDocKey(await read()),
    add: (input: OverlayInput, by: string, why: string): Promise<{ entry: OverlayEntry; change: OverlayChange }> => change((e) => e.add(input, by, why)),
    edit: (id: string, input: Partial<OverlayInput>, by: string, why: string): Promise<{ entry: OverlayEntry; change: OverlayChange }> => change((e) => e.edit(id, input, by, why)),
    remove: (id: string, by: string, why: string): Promise<OverlayChange> => change((e) => e.remove(id, by, why)),
    undo: (by: string, why = ""): Promise<OverlayChange> => change((e) => e.undo(by, why)),
    restore: (v: number, by: string, why = ""): Promise<OverlayChange> => change((e) => e.restore(v, by, why)),
  };
}
