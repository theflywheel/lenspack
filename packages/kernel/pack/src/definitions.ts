import type { Catalogue } from "@lenspack/core";
import { z } from "zod";

import type { Pack } from "./pack";

// Definitions: what the people who run a deployment add to a pack without editing its file. Instruction
// lines, a hint on a measure or dimension, synonyms, and readings for a kind of question ("when someone
// asks about sales this month, use the calendar month to date"). A typed, versioned document like a pack
// or a board: every change is a new version that keeps who, when and why, with the entries before and
// after, so any change can be undone and any version restored. It has a size budget, because it is sent
// with every chat turn. Where it is kept is the host's business (a store); merging it into a pack is
// here, so every host and every turn merges it the same way. It is the first part of the documents a
// deployment layers over its packs (the ontology it settles, the policy it narrows).

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


/** What an admin, a proposal or an answer adds: everything but the bookkeeping. */
export type OverlayInput = Pick<OverlayEntry, "kind" | "text"> & Partial<Pick<OverlayEntry, "key" | "words" | "when" | "question" | "source">>;

export class OverlayError extends Error {}

/** The overlay's default budget, in characters of what it adds to the prompt. */
export const OVERLAY_BUDGET = 4000;

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

/** The definitions document for one pack. */
export type DefinitionsDoc = { kind: "lenspack/definitions"; pack: string; version: number; entries: OverlayEntry[]; history: OverlayChange[] };

const entrySchema = z.object({
  id: z.string(),
  kind: z.enum(["instruction", "hint", "synonym", "definition"]),
  key: z.string().optional(),
  text: z.string(),
  words: z.array(z.string()).optional(),
  when: z.string().optional(),
  question: z.string().optional(),
  source: z.enum(["admin", "proposal", "question"]).default("admin"),
  createdAt: z.string(),
  createdBy: z.string(),
});
const changeSchema = z.object({
  version: z.number().int(),
  at: z.string(),
  by: z.string(),
  why: z.string().default(""),
  action: z.enum(["add", "edit", "remove", "undo", "restore"]),
  summary: z.string().default(""),
  before: z.array(entrySchema),
  after: z.array(entrySchema),
  undoes: z.number().int().optional(),
  undone: z.boolean().optional(),
});
/** A definitions document as stored; one written before it had a kind and a pack reads too. */
export const definitionsDocSchema = z.object({
  kind: z.literal("lenspack/definitions").default("lenspack/definitions"),
  pack: z.string().default(""),
  version: z.number().int().min(0),
  entries: z.array(entrySchema),
  history: z.array(changeSchema).default([]),
});

export const emptyDefinitions = (pack: string): DefinitionsDoc => ({ kind: "lenspack/definitions", pack, version: 0, entries: [], history: [] });

/** A stored document, checked; anything unreadable is an OverlayError. */
export function parseDefinitions(raw: unknown, pack: string): DefinitionsDoc {
  const r = definitionsDocSchema.safeParse(raw);
  if (!r.success) throw new OverlayError(`the definitions for ${pack} do not read: ${r.error.issues[0]?.message ?? "bad shape"}`);
  return { ...r.data, pack: r.data.pack || pack } as DefinitionsDoc;
}

// FNV-1a, twice: a short, stable fingerprint that needs no crypto library, so this runs anywhere.
function fingerprint(s: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    a = Math.imul(a ^ s.charCodeAt(i), 0x01000193) >>> 0;
    b = Math.imul(b ^ s.charCodeAt(s.length - 1 - i), 0x811c9dc5) >>> 0;
  }
  return (a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0")).slice(0, 8);
}

/**
 * The version key for a definitions document: it changes whenever the entries do, and differs between two
 * documents that happen to share a counter (a state directory wiped and started again). An answer cache keys on it.
 */
export const definitionsDocKey = (doc: Pick<DefinitionsDoc, "version" | "entries">) =>
  `d${doc.version}-${fingerprint(JSON.stringify(doc.entries.map(({ kind, key, text, words, when }) => ({ kind, key, text, words, when }))))}`;

const HISTORY = 200;
const newId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`).replace(/-/g, "").slice(0, 8);

/**
 * Changes to one definitions document, made in memory: each returns what it did, and doc() is the
 * document after them. The caller stores the result (and, with a shared store, retries on a newer copy).
 * keys: the pack's measures and dimensions, checked when an entry names one.
 */
export function editDefinitions(start: DefinitionsDoc, opts: { keys: ReadonlySet<string>; budget?: number; now?: () => Date }) {
  const now = opts.now ?? (() => new Date());
  const budget = opts.budget ?? OVERLAY_BUDGET;
  let data = start;
  const commit = (entries: OverlayEntry[], change: Omit<OverlayChange, "version" | "at" | "before" | "after">) => {
    const size = overlaySize(entries);
    // Shrinking is always allowed, so a document over a lowered budget can still be cut back.
    if (size > budget && size > overlaySize(data.entries)) throw new OverlayError(`this would take the definitions to ${size} characters, over their budget of ${budget}: shorten or remove something first`);
    const version = data.version + 1;
    const record: OverlayChange = { version, at: now().toISOString(), ...change, why: change.why.trim().slice(0, 500), before: data.entries, after: entries };
    data = { ...data, version, entries, history: [...data.history, record].slice(-HISTORY) };
    return record;
  };
  const find = (id: string) => {
    const e = data.entries.find((x) => x.id === id);
    if (!e) throw new OverlayError(`no definition ${id}`);
    return e;
  };
  return {
    doc: () => data,
    add(input: OverlayInput, by: string, why: string): { entry: OverlayEntry; change: OverlayChange } {
      const entry: OverlayEntry = { id: newId(), ...checkEntry(input, opts.keys), source: input.source ?? "admin", createdAt: now().toISOString(), createdBy: by };
      const change = commit([...data.entries, entry], { by, why, action: "add", summary: `added ${entry.kind}: ${entryLine(entry).slice(0, 120)}` });
      return { entry, change };
    },
    edit(id: string, input: Partial<OverlayInput>, by: string, why: string): { entry: OverlayEntry; change: OverlayChange } {
      const was = find(id);
      const entry: OverlayEntry = { ...was, ...checkEntry({ ...was, ...input, kind: was.kind }, opts.keys) };
      const change = commit(data.entries.map((e) => (e.id === id ? entry : e)), { by, why, action: "edit", summary: `changed ${entry.kind}: ${entryLine(entry).slice(0, 120)}` });
      return { entry, change };
    },
    remove(id: string, by: string, why: string): OverlayChange {
      const was = find(id);
      return commit(data.entries.filter((e) => e.id !== id), { by, why, action: "remove", summary: `removed ${was.kind}: ${entryLine(was).slice(0, 120)}` });
    },
    /** Undoes the latest change that is not an undo and not already undone: the entries go back to what they were before it. */
    undo(by: string, why = ""): OverlayChange {
      const target = [...data.history].reverse().find((c) => c.action !== "undo" && !c.undone);
      if (!target) throw new OverlayError("there is nothing to undo");
      const change = commit(target.before, { by, why: why || `undo v${target.version}`, action: "undo", summary: `undid v${target.version} (${target.summary})`, undoes: target.version });
      data = { ...data, history: data.history.map((c) => (c.version === target.version ? { ...c, undone: true } : c)) };
      return change;
    },
    /** Puts the entries back as they were right after version v, as a new version. */
    restore(v: number, by: string, why = ""): OverlayChange {
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
