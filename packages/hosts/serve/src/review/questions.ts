import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { SettingsSaveError, writeWhole } from "../settings";

// The open-questions log: definitional questions with more than one reasonable reading and no
// sane default ("burn rate per facility": stock dispatched from the facility's store, or doses given
// to children there?). Entries come from three places: the chat, when a question had more than one
// reading (the clarify tool), the daily review, and an admin. Each keeps its readings (what each
// counts, and how to compute it with the pack's measures and compute steps), the questions people
// asked that raised it, and how often. An admin answers one by picking a reading, which becomes a
// definition in the overlay, or dismisses it.

/** How to compute a reading: the agent's own query arguments (query_kind, measure, dimension, grain, compute, …). */
export type ReadingQuery = Record<string, string | number | boolean>;

export type Reading = {
  id: string;
  label: string;
  explanation: string;
  /** In words, when no query is given (from the chat). */
  how?: string;
  query?: ReadingQuery;
};

export type QuestionSource = "turn" | "reviewer" | "review" | "admin";
export type QuestionStatus = "open" | "answered" | "dismissed";

/** A reading's figures, run with no model (compare.ts). */
export type ComparedReading = {
  reading: string;
  label: string;
  ok: boolean;
  error?: string;
  /** The query's kind: value, breakdown or series. */
  kind?: string;
  format?: string;
  /** A value query's number, or a series' latest bucket. */
  value?: number | null;
  /** A breakdown's top groups, or a series' last buckets. */
  rows?: { group: string; value: number | null }[];
  /** What was computed, in the engine's words. */
  computed?: string;
  /** The figure in one line: "1,240 for the top facility (Ward A)". */
  summary: string;
};
export type Comparison = { at: string; readings: ComparedReading[]; headline: string };

export type OpenQuestion = {
  id: string;
  pattern: string;
  readings: Reading[];
  /** The questions people asked that raised it, newest last. */
  examples: string[];
  firstSeen: string;
  lastSeen: string;
  count: number;
  status: QuestionStatus;
  sources: QuestionSource[];
  /** Quick replies people picked, by reading label. */
  choices?: Record<string, number>;
  /** Readings the assistant assumed when it answered without asking, by label. */
  assumed?: Record<string, number>;
  /** Once answered: the reading chosen, by whom, why, and the definition it became. */
  chosen?: string;
  answeredBy?: string;
  answeredAt?: string;
  why?: string;
  definition?: string;
  compared?: Comparison;
};

export type QuestionNote = {
  pattern: string;
  readings: Omit<Reading, "id">[];
  example?: string;
  source: QuestionSource;
  /** chat: the reading it answered with, when it did not ask. */
  assumed?: string;
};

export class QuestionError extends Error {}

const MAX = 500;
const EXAMPLES = 8;

/** A pattern as compared for repeats: lower case, letters and digits, single spaces. */
export const normalPattern = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const words = (s: string) => new Set(normalPattern(s).split(" ").filter((w) => w.length > 2));
/** Two patterns are the same question when they share most of their words. */
export function samePattern(a: string, b: string) {
  if (normalPattern(a) === normalPattern(b)) return true;
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return false;
  const both = [...x].filter((w) => y.has(w)).length;
  return both / new Set([...x, ...y]).size >= 0.75;
}

const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** Readings as given, tidied: each needs a label; at most six. */
export function cleanReadings(rs: unknown): Omit<Reading, "id">[] {
  if (!Array.isArray(rs)) return [];
  return rs
    .flatMap((r) => {
      if (!r || typeof r !== "object") return [];
      const o = r as Record<string, unknown>;
      const label = text(o.label, 120);
      if (!label) return [];
      const query = o.query && typeof o.query === "object" && !Array.isArray(o.query) ? (Object.fromEntries(Object.entries(o.query as object).filter(([, v]) => ["string", "number", "boolean"].includes(typeof v)).slice(0, 30)) as ReadingQuery) : undefined;
      return [{ label, explanation: text(o.explanation, 600), ...(text(o.how, 400) ? { how: text(o.how, 400) } : {}), ...(query && Object.keys(query).length ? { query } : {}) }];
    })
    .slice(0, 6);
}

export type QuestionLog = ReturnType<typeof questionLog>;

/** One pack's log, kept in <dir>/open-questions-<pack>.json. */
export function questionLog(dir: string, pack: string, opts: { now?: () => Date } = {}) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `open-questions-${pack}.json`);
  const now = opts.now ?? (() => new Date());
  let items: OpenQuestion[] = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as OpenQuestion[]) : [];
  const save = (next: OpenQuestion[]) => {
    try {
      writeWhole(path, JSON.stringify(next, null, 2));
    } catch (e) {
      throw new SettingsSaveError(e);
    }
    items = next;
  };
  const get = (id: string) => {
    const q = items.find((x) => x.id === id);
    if (!q) throw new QuestionError(`no open question ${id}`);
    return q;
  };
  const put = (q: OpenQuestion) => save(items.map((x) => (x.id === q.id ? q : x)));
  const withReadingIds = (rs: Omit<Reading, "id">[]): Reading[] => rs.map((r, i) => ({ id: `r${i + 1}`, ...r }));

  return {
    path,
    list: (status?: QuestionStatus) => (status ? items.filter((q) => q.status === status) : items).slice().sort((a, b) => (a.status === b.status ? b.lastSeen.localeCompare(a.lastSeen) : a.status === "open" ? -1 : b.status === "open" ? 1 : 0)),
    get,
    /**
     * Records a question with more than one reading. A repeat of an entry (the same pattern, or most of its words) counts
     * against it: seen once more, the example kept, readings it did not have added, the source noted. A repeat of an
     * answered or dismissed one is counted but stays as it is.
     */
    note(n: QuestionNote): OpenQuestion {
      const pattern = text(n.pattern, 200);
      if (!pattern) throw new QuestionError("a question needs its pattern");
      const readings = cleanReadings(n.readings);
      if (n.source !== "admin" && readings.length < 2) throw new QuestionError("an open question needs at least two readings");
      const at = now().toISOString();
      const example = text(n.example, 300);
      const was = items.find((q) => samePattern(q.pattern, pattern));
      if (was) {
        const labels = new Set(was.readings.map((r) => normalPattern(r.label)));
        const added = readings.filter((r) => !labels.has(normalPattern(r.label)));
        // A reading the earlier one only had in words gains the query the new one brings.
        const filled = was.readings.map((r) => (r.query ? r : { ...r, ...(readings.find((x) => normalPattern(x.label) === normalPattern(r.label) && x.query) ?? {}), id: r.id }));
        const q: OpenQuestion = {
          ...was,
          lastSeen: at,
          count: was.count + 1,
          examples: example && !was.examples.includes(example) ? [...was.examples, example].slice(-EXAMPLES) : was.examples,
          readings: [...filled, ...withReadingIds(added).map((r, i) => ({ ...r, id: `r${was.readings.length + i + 1}` }))].slice(0, 6),
          sources: was.sources.includes(n.source) ? was.sources : [...was.sources, n.source],
          ...(n.assumed ? { assumed: { ...was.assumed, [n.assumed]: (was.assumed?.[n.assumed] ?? 0) + 1 } } : {}),
        };
        put(q);
        return q;
      }
      const q: OpenQuestion = {
        id: randomUUID().slice(0, 8),
        pattern,
        readings: withReadingIds(readings),
        examples: example ? [example] : [],
        firstSeen: at,
        lastSeen: at,
        count: 1,
        status: "open",
        sources: [n.source],
        ...(n.assumed ? { assumed: { [n.assumed]: 1 } } : {}),
      };
      // Full: the oldest settled entries go first, then the oldest open ones.
      const kept = [...items, q];
      while (kept.length > MAX) {
        const i = kept.findIndex((x) => x.status !== "open");
        kept.splice(i >= 0 ? i : 0, 1);
      }
      save(kept);
      return q;
    },
    /** A quick reply someone picked: counted against the reading's label. */
    choose(id: string, label: string) {
      const q = items.find((x) => x.id === id);
      if (!q) return null;
      const l = text(label, 120);
      if (!l) return q;
      const next = { ...q, choices: { ...q.choices, [l]: (q.choices?.[l] ?? 0) + 1 } };
      put(next);
      return next;
    },
    /** Marks it answered with a reading; the caller has already written the definition. */
    answer(id: string, reading: string, by: string, why: string, definition: string) {
      const q = get(id);
      if (!q.readings.some((r) => r.id === reading)) throw new QuestionError(`question ${id} has no reading ${reading}`);
      const next: OpenQuestion = { ...q, status: "answered", chosen: reading, answeredBy: by, answeredAt: now().toISOString(), why: text(why, 500), definition };
      put(next);
      return next;
    },
    dismiss(id: string, by: string, why: string) {
      const q = get(id);
      const next: OpenQuestion = { ...q, status: "dismissed", answeredBy: by, answeredAt: now().toISOString(), why: text(why, 500) };
      put(next);
      return next;
    },
    /** Back to open (an answer undone, a dismissal taken back). */
    reopen(id: string) {
      const q = get(id);
      const { chosen: _c, answeredAt: _a, answeredBy: _b, definition: _d, ...rest } = q;
      const next: OpenQuestion = { ...rest, status: "open" };
      put(next);
      return next;
    },
    /** An admin's edit: the pattern and the readings. */
    edit(id: string, patch: { pattern?: unknown; readings?: unknown }) {
      const q = get(id);
      const pattern = patch.pattern === undefined ? q.pattern : text(patch.pattern, 200);
      if (!pattern) throw new QuestionError("a question needs its pattern");
      const readings = patch.readings === undefined ? q.readings : withReadingIds(cleanReadings(patch.readings));
      const next: OpenQuestion = { ...q, pattern, readings, ...(patch.readings === undefined ? {} : { compared: undefined }) };
      put(next);
      return next;
    },
    setCompared(id: string, compared: Comparison) {
      const q = items.find((x) => x.id === id);
      if (!q) return;
      put({ ...q, compared });
    },
  };
}
