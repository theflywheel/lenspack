import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Catalogue } from "@lenspack/core";
import type { Pack } from "@lenspack/pack";

import { SettingsSaveError, writeWhole } from "../settings";

// The definitions overlay: what an admin adds to a pack on a running server, without touching
// the deployment's pack file or ConfigMap. Instruction lines, a hint on a measure or dimension,
// synonyms, and definitions ("when X, use reading Y"). It lives in the state directory, one file
// per pack, and is merged into the pack at the start of every chat turn, so a change applies to the
// next question with no restart. Every change is a new version with who, when and why, and any
// change can be undone. The overlay has its own size budget, because it is sent with every turn.

export type OverlayKind = "instruction" | "hint" | "synonym" | "definition";

export type OverlayEntry = {
  id: string;
  kind: OverlayKind;
  /** hint, synonym: the measure or dimension it is about. */
  key?: string;
  /** instruction, hint: the line itself. definition: the reading to use. */
  text: string;
  /** synonym: the words people use for the key. */
  words?: string[];
  /** definition: the kind of question it settles ("burn rate per facility"). */
  when?: string;
  /** definition: the open question it answered, if any. */
  question?: string;
  /** Where it came from: written by an admin, an accepted proposal, or an answered open question. */
  source: "admin" | "proposal" | "question";
  createdAt: string;
  createdBy: string;
};

export type OverlayChange = {
  version: number;
  at: string;
  by: string;
  why: string;
  action: "add" | "edit" | "remove" | "undo" | "restore";
  summary: string;
  /** The entries before and after the change, so any change can be undone, or any version restored. */
  before: OverlayEntry[];
  after: OverlayEntry[];
  /** undo: the version it undid. */
  undoes?: number;
  /** Set on a change that a later undo reverted. */
  undone?: boolean;
};

type OverlayFile = { version: number; entries: OverlayEntry[]; history: OverlayChange[] };

/** What an admin, a proposal or an answer adds: everything but the bookkeeping. */
export type OverlayInput = Pick<OverlayEntry, "kind" | "text"> & Partial<Pick<OverlayEntry, "key" | "words" | "when" | "question" | "source">>;

export class OverlayError extends Error {}

/** The overlay's default budget, in characters of what it adds to the prompt. */
export const OVERLAY_BUDGET = 4000;
const HISTORY = 200;

/** One entry as the model reads it. */
export function entryLine(e: Pick<OverlayEntry, "kind" | "key" | "text" | "words" | "when">): string {
  switch (e.kind) {
    case "instruction":
      return e.text;
    case "definition":
      return `When ${e.when}: ${e.text}`;
    case "hint":
      return `${e.key}: ${e.text}`;
    case "synonym":
      return `${e.key}: ${(e.words ?? []).join(", ")}`;
  }
}

const clean = (s: unknown, max: number, what: string) => {
  if (typeof s !== "string") throw new OverlayError(`${what} must be text`);
  const t = s.replace(/\s+/g, " ").trim();
  if (!t) throw new OverlayError(`${what} is empty`);
  if (t.length > max) throw new OverlayError(`${what} is longer than ${max} characters`);
  return t;
};

/** An entry checked and tidied, or an OverlayError saying what is wrong. keys: the pack's measures and dimensions. */
export function checkEntry(input: OverlayInput, keys: ReadonlySet<string>): Omit<OverlayInput, "source"> {
  const kind = input.kind;
  if (!["instruction", "hint", "synonym", "definition"].includes(kind)) throw new OverlayError(`unknown kind "${String(kind)}": instruction, hint, synonym or definition`);
  if (kind === "hint" || kind === "synonym") {
    const key = clean(input.key, 80, "key");
    if (!keys.has(key)) throw new OverlayError(`"${key}" is not a measure or dimension of this pack`);
    if (kind === "synonym") {
      const words = (Array.isArray(input.words) ? input.words : String(input.text ?? "").split(",")).map((w) => String(w).replace(/\s+/g, " ").trim()).filter(Boolean);
      if (!words.length) throw new OverlayError("a synonym needs at least one word");
      if (words.some((w) => w.length > 40)) throw new OverlayError("a synonym is at most 40 characters");
      return { kind, key, words: [...new Set(words)].slice(0, 20), text: words.join(", ") };
    }
    return { kind, key, text: clean(input.text, 400, "the hint") };
  }
  if (kind === "definition") return { kind, when: clean(input.when, 200, "when"), text: clean(input.text, 600, "the reading"), ...(input.question ? { question: String(input.question) } : {}) };
  return { kind, text: clean(input.text, 600, "the instruction") };
}

/** How much of the budget entries use: the characters they add to the prompt. */
export const overlaySize = (entries: Pick<OverlayEntry, "kind" | "key" | "text" | "words" | "when">[]) => entries.reduce((n, e) => n + entryLine(e).length + 3, 0);

export type Overlay = ReturnType<typeof overlayStore>;

/**
 * One pack's overlay, kept in <dir>/definitions-<pack>.json. keys: the pack's measures and
 * dimensions, read when an entry names one.
 */
export function overlayStore(dir: string, pack: string, opts: { keys: () => ReadonlySet<string>; budget?: number; now?: () => Date }) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `definitions-${pack}.json`);
  const now = opts.now ?? (() => new Date());
  const budget = opts.budget ?? OVERLAY_BUDGET;
  let data: OverlayFile = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as OverlayFile) : { version: 0, entries: [], history: [] };

  const save = (next: OverlayFile) => {
    try {
      writeWhole(path, JSON.stringify(next, null, 2));
    } catch (e) {
      throw new SettingsSaveError(e);
    }
    data = next;
  };

  const commit = (entries: OverlayEntry[], change: Omit<OverlayChange, "version" | "at" | "before" | "after">) => {
    const size = overlaySize(entries);
    // Shrinking is always allowed, so an overlay over a lowered budget can still be cut back.
    if (size > budget && size > overlaySize(data.entries)) throw new OverlayError(`this would take the definitions to ${size} characters, over their budget of ${budget}: shorten or remove something first`);
    const version = data.version + 1;
    const record: OverlayChange = { version, at: now().toISOString(), ...change, why: change.why.trim().slice(0, 500), before: data.entries, after: entries };
    save({ version, entries, history: [...data.history, record].slice(-HISTORY) });
    return record;
  };

  const find = (id: string) => {
    const e = data.entries.find((x) => x.id === id);
    if (!e) throw new OverlayError(`no definition ${id}`);
    return e;
  };

  return {
    path,
    budget,
    /** The entries now, oldest first. */
    entries: () => data.entries,
    history: () => [...data.history].reverse(),
    version: () => data.version,
    size: () => overlaySize(data.entries),
    /**
     * The version key for this pack's definitions: changes whenever the overlay does, and differs between
     * two overlays that happen to share a counter (a state directory wiped and started again).
     */
    key: () => `d${data.version}-${createHash("sha256").update(JSON.stringify(data.entries.map(({ kind, key, text, words, when }) => ({ kind, key, text, words, when })))).digest("hex").slice(0, 8)}`,
    add(input: OverlayInput, by: string, why: string): { entry: OverlayEntry; change: OverlayChange } {
      const entry: OverlayEntry = { id: randomUUID().slice(0, 8), ...checkEntry(input, opts.keys()), source: input.source ?? "admin", createdAt: now().toISOString(), createdBy: by };
      const change = commit([...data.entries, entry], { by, why, action: "add", summary: `added ${entry.kind}: ${entryLine(entry).slice(0, 120)}` });
      return { entry, change };
    },
    edit(id: string, input: Partial<OverlayInput>, by: string, why: string) {
      const was = find(id);
      const entry: OverlayEntry = { ...was, ...checkEntry({ ...was, ...input, kind: was.kind }, opts.keys()) };
      const change = commit(data.entries.map((e) => (e.id === id ? entry : e)), { by, why, action: "edit", summary: `changed ${entry.kind}: ${entryLine(entry).slice(0, 120)}` });
      return { entry, change };
    },
    remove(id: string, by: string, why: string) {
      const was = find(id);
      return commit(data.entries.filter((e) => e.id !== id), { by, why, action: "remove", summary: `removed ${was.kind}: ${entryLine(was).slice(0, 120)}` });
    },
    /** Undoes the latest change that is not an undo and not already undone: the entries go back to what they were before it. */
    undo(by: string, why = "") {
      const target = [...data.history].reverse().find((c) => c.action !== "undo" && !c.undone);
      if (!target) throw new OverlayError("there is nothing to undo");
      const change = commit(target.before, { by, why: why || `undo v${target.version}`, action: "undo", summary: `undid v${target.version} (${target.summary})`, undoes: target.version });
      save({ ...data, history: data.history.map((c) => (c.version === target.version ? { ...c, undone: true } : c)) });
      return change;
    },
    /** Puts the entries back as they were right after version v, as a new version. */
    restore(v: number, by: string, why = "") {
      const target = data.history.find((c) => c.version === v);
      if (!target) throw new OverlayError(`no version ${v} in the history`);
      return commit(target.after, { by, why: why || `restore v${v}`, action: "restore", summary: `restored the definitions as they were at v${v}` });
    },
  };
}

/** The admin's lines as the prompt's section, appended to the pack's own instructions. */
export function overlayInstructions(entries: OverlayEntry[]): string {
  const lines = entries.filter((e) => e.kind === "instruction" || e.kind === "definition").map((e) => `- ${entryLine(e)}`);
  return lines.length ? `DEFINITIONS SET BY AN ADMIN (they settle these questions; use them rather than guessing, and say which reading you used):\n${lines.join("\n")}` : "";
}

const withHint = (hint: string | undefined, extra: string[]) => (extra.length ? [hint, ...extra].filter(Boolean).join(" ") : hint);
const withWords = (words: string[] | undefined, extra: string[]) => (extra.length ? [...new Set([...(words ?? []), ...extra])] : words);

/**
 * The pack and catalogue with the overlay merged in: instructions after the pack's own, hints after a key's own
 * hint, synonyms added to its own. Pure: neither input is changed, and an empty overlay returns them as they are.
 */
export function applyOverlay<C extends Pick<Catalogue, "dimensions" | "measures">>(entries: OverlayEntry[], pack: Pack, catalogue: C): { pack: Pack; catalogue: C } {
  if (!entries.length) return { pack, catalogue };
  const hints = new Map<string, string[]>();
  const words = new Map<string, string[]>();
  for (const e of entries) {
    if (e.kind === "hint" && e.key) hints.set(e.key, [...(hints.get(e.key) ?? []), e.text]);
    if (e.kind === "synonym" && e.key) words.set(e.key, [...(words.get(e.key) ?? []), ...(e.words ?? [])]);
  }
  const section = overlayInstructions(entries);
  const keyed = <T extends { key: string; hint?: string; synonyms?: string[] }>(x: T): T => {
    const h = hints.get(x.key) ?? [];
    const w = words.get(x.key) ?? [];
    return h.length || w.length ? { ...x, hint: withHint(x.hint, h), synonyms: withWords(x.synonyms, w) } : x;
  };
  return {
    pack: {
      ...pack,
      ...(section ? { instructions: [pack.instructions?.trim(), section].filter(Boolean).join("\n\n") } : {}),
      dimensions: pack.dimensions.map(keyed),
      measures: pack.measures.map(keyed),
    },
    catalogue: { ...catalogue, dimensions: catalogue.dimensions.map(keyed), measures: catalogue.measures.map(keyed) },
  };
}
