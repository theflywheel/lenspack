import type { Catalogue } from "@lenspack/core";
import type { Pack } from "@lenspack/pack";

import type { OpenQuestion, QuestionNote } from "./questions";

/**
 * What the chat reads of the review system on every turn (AppOptions.definitions): the admin's overlay
 * merged into the pack, its version key, whether clarifying is on, and where a question with more than one
 * reading is logged.
 */
export type TurnDefinitions = {
  /** The pack and catalogue with the pack's overlay merged in. */
  apply<C extends Pick<Catalogue, "dimensions" | "measures">>(packName: string, pack: Pack, catalogue: C): { pack: Pack; catalogue: C };
  /** Changes whenever the pack's definitions do (its file's version, or the overlay). */
  version(packName: string, pack: Pack): string;
  /** The clarify switch, read per turn. */
  clarify(): boolean;
  /** Logs a question with more than one reading; null when the log refused it. */
  note(packName: string, n: QuestionNote): OpenQuestion | null;
  /** A quick reply someone picked. */
  choose(packName: string, questionId: string, label: string): void;
};

/** The definitions version for a pack: its own version, then the overlay's key. */
export const definitionsKey = (pack: Pick<Pack, "pack" | "version">, overlayKey: string) => `${pack.pack}@${pack.version}+${overlayKey}`;
