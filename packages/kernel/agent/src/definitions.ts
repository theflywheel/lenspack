import type { Catalogue } from "@lenspack/core";
import type { Pack } from "@lenspack/pack";

import type { ClarifyNote } from "./clarify";

/**
 * What a chat turn reads of the deployment's definitions on every turn: its definitions document merged into
 * the pack, their version key, whether clarifying is on, and where a question with more than one reading is
 * logged. A host passes an implementation (the standalone server's review system does); every call may be
 * answered from a shared store, so each may return a promise.
 */
export type TurnDefinitions = {
  /** The pack and catalogue with the pack's definitions merged in (applyOverlay). */
  apply<C extends Pick<Catalogue, "dimensions" | "measures">>(packName: string, pack: Pack, catalogue: C): { pack: Pack; catalogue: C } | Promise<{ pack: Pack; catalogue: C }>;
  /** Changes whenever the pack's definitions do (its file's version, or the definitions document). */
  version(packName: string, pack: Pack): string | Promise<string>;
  /** The clarify switch, read per turn. */
  clarify(): boolean;
  /** Logs a question with more than one reading; null when the log refused it. */
  note(packName: string, n: ClarifyNote): { id: string } | null | Promise<{ id: string } | null>;
  /** A quick reply someone picked. */
  choose(packName: string, questionId: string, label: string): void | Promise<void>;
};

/** The definitions version for a pack: its own version, then the definitions document's key. */
export const definitionsKey = (pack: Pick<Pack, "pack" | "version">, documentKey: string) => `${pack.pack}@${pack.version}+${documentKey}`;
