import { type DeploymentContext, type Identity, contextFor, reportsOn } from "@lenspack/policy";

import { CORE_FIELDS, type SwitchValues, keptFields, onlyKept, signalDefaults, signalForEvent, signalsOn } from "./signals";

// Usage telemetry: one flat record per chat turn, per transcription and per event a client reports (a thumbs up or
// down, an answer left before it finished, a transcript the user corrected). It answers how the assistant is used:
// by whom (the user and the role names the host signed), where (board, pack, datasets, and the campaign and country
// the deployment's context maps them to), what was asked and how it went. The schema is in docs/telemetry.md; keep
// it flat, and add fields rather than change them.
//
// This module is the whole of it except storage and the key questions are hashed under: no HTTP, no host. A host
// gives it a TelemetryStore (a file today, a database tomorrow) and calls a few hooks on each turn (TurnCapture).
// Nothing here models an organisation: what a board, dataset or role belongs to is the deployment's context
// (@lenspack/policy). Secrets never reach a record.
//
// What is recorded follows the deployment's switches (signals.ts): a record keeps only the fields of the signals
// that are on, and a client event no signal keeps is not written. The switches are read on every record.

export const TELEMETRY_VERSION = 2;

export type TurnKind = "direct" | "derived" | "chart" | "meta";
export type RecordedOutcome = "answered" | "declined" | "failed" | "clarify";
export type DeviceClass = "mobile" | "tablet" | "desktop";
export type NetworkType = "slow-2g" | "2g" | "3g" | "4g";
export type ViewportClass = "narrow" | "medium" | "wide";
export const FEEDBACK_REASONS = ["wrong-number", "wrong-place", "misunderstood", "too-slow", "other"] as const;
export type FeedbackReason = (typeof FEEDBACK_REASONS)[number];

export type TurnRecord = {
  type: "turn";
  v: number;
  turnId: string;
  sessionId: string;
  /** When the question arrived. */
  at: string;
  user: string;
  roles: string[];
  tenant: string | null;
  board: string | null;
  pack: string;
  datasets: string[];
  /** The viewer's dashboard filter selections when they asked (filter → value); values hashed when question text is off. */
  selections: Record<string, string> | null;
  campaign: string | null;
  campaignType: string | null;
  country: string | null;
  /** The language picked in the chat ("auto" or a code), null when none was sent. */
  languagePicked: string | null;
  /** The language the reply was asked in: the pick, or the question's when the pick is auto. */
  replyLanguage: string | null;
  /** The question's language, from the speech provider for a spoken one, else guessed from its words. */
  questionLanguage: string | null;
  input: "typed" | "spoken";
  /** The question as sent; null when question text is off. */
  question: string | null;
  /** A keyed hash of the question's normalised words: equal questions share it, whether or not the text is kept. */
  questionHash: string;
  questionWords: number;
  transcriptId: string | null;
  transcriptIds: string[];
  /** What speech to text returned; null when typed or when question text is off. */
  transcript: string | null;
  transcriptHash: string | null;
  /** Word-level edits between the transcript and the question sent (0: sent as heard). */
  transcriptEditDistance: number | null;
  kind: TurnKind;
  outcome: RecordedOutcome;
  outcomeReason: string | null;
  toolCalls: number;
  queries: number;
  queriesFailed: number;
  computeSteps: number;
  editsApplied: number;
  editsRefused: number;
  firstTokenMs: number | null;
  totalMs: number;
  abandoned: boolean;
  abandonedMs: number | null;
  costUsd: number;
  modelUsd: number;
  speechUsd: number;
  reviewUsd: number;
  unpricedCalls: number;
  tokensIn: number;
  tokensOut: number;
  models: string[];
  builder: string;
  effort: string | null;
  reviewRan: boolean;
  reviewMaterial: number;
  fixRound: boolean;
  /** Filled by answer reuse when a turn was answered from a saved answer (its tier); null otherwise. */
  reuse: string | null;
  /** What the saved answer saved against running the model (an estimate); null when not reused. */
  reuseSavedUsd: number | null;
  /** How long the turn waited for a free place in the turn queue; 0 for a saved answer, which skips the queue. */
  queueMs: number | null;
  rephraseOf: string | null;
  reAskAfterVoice: string | null;
  device: DeviceClass | null;
  network: NetworkType | null;
  saveData: boolean | null;
  viewport: ViewportClass | null;
};

export type AudioLink = { stored: true; bytes: number; format: string };

export type TranscriptRecord = {
  type: "transcript";
  v: number;
  transcriptId: string;
  at: string;
  user: string;
  roles: string[];
  pack: string | null;
  model: string;
  languageRequested: string | null;
  languageDetected: string | null;
  seconds: number | null;
  usd: number | null;
  ms: number;
  retried: boolean;
  transcript: string | null;
  transcriptHash: string;
  words: number;
  /** The clip itself, when the deployment keeps recordings; null when not kept. */
  audio: AudioLink | null;
};

export type Scalar = string | number | boolean | null;

export type EventRecord = {
  type: "event";
  v: number;
  event: string;
  at: string;
  user: string;
  roles: string[];
  turnId: string | null;
  sessionId: string | null;
  board: string | null;
  pack: string | null;
  rating: "up" | "down" | null;
  reason: FeedbackReason | null;
  comment: string | null;
  commentHash: string | null;
  transcriptId: string | null;
  transcript: string | null;
  transcriptSent: string | null;
  transcriptEditDistance: number | null;
  transcriptWords: number | null;
  how: string | null;
  stage: string | null;
  choice: string | null;
  data: Record<string, Scalar> | null;
};

/** A record as written: the fields that place it always, the rest only while a signal that needs them is on. */
export type Kept<T, K extends keyof T> = Pick<T, K> & Partial<Omit<T, K>>;
export type TurnLine = Kept<TurnRecord, "type" | "v" | "turnId" | "at" | "pack" | "board" | "tenant" | "datasets">;
export type TranscriptLine = Kept<TranscriptRecord, "type" | "v" | "transcriptId" | "at" | "pack">;
export type EventLine = Kept<EventRecord, "type" | "v" | "event" | "at" | "turnId" | "pack" | "board" | "data">;
export type TelemetryLine = TurnLine | TranscriptLine | EventLine;

// --- storage ------------------------------------------------------------------

export type TelemetryQuery = { from: Date; to?: Date; type?: TelemetryLine["type"]; user?: string; turnId?: string };

/**
 * Where telemetry lives. Two parts: the log, which is the record (append-only, read back by time), and working
 * state, short-lived values the next turn reads (a user's session, their last questions, turns in flight,
 * transcripts waiting for their question). A file-backed store serves one copy of Lenspack; a database-backed one
 * lets several copies share both. take() must be atomic there: it is how a transcript is claimed exactly once.
 */
export interface TelemetryStore {
  append(line: TelemetryLine): Promise<void>;
  /** The lines at or after from (and at or before to) that match, newest first. */
  find(q: TelemetryQuery): Promise<TelemetryLine[]>;
  state: {
    get<T>(key: string): Promise<T | null>;
    put(key: string, value: unknown, ttlMs: number): Promise<void>;
    /** Reads and removes a value in one step: whoever takes it, nobody else does. */
    take<T>(key: string): Promise<T | null>;
    list<T>(prefix: string): Promise<{ key: string; value: T }[]>;
  };
}

// --- text ---------------------------------------------------------------------

/** Lower case, letters and digits only, single spaces: what two askings of one question share. */
export function normaliseText(text: string): string {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
    .trim();
}

export const wordsOf = (text: string) => {
  const n = normaliseText(text);
  return n ? n.split(" ") : [];
};

/** Levenshtein distance over two lists of words. */
export function editDistance(x: readonly string[], y: readonly string[]): number {
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const row = [i];
    for (let j = 1; j <= y.length; j++) row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[y.length]!;
}

/** Word insertions, deletions and substitutions to turn a into b, ignoring case and punctuation. */
export const wordEditDistance = (a: string, b: string) => editDistance(wordsOf(a), wordsOf(b));

const trigrams = (s: string) => {
  const t = ` ${s} `;
  const out = new Map<string, number>();
  for (let i = 0; i + 3 <= t.length; i++) out.set(t.slice(i, i + 3), (out.get(t.slice(i, i + 3)) ?? 0) + 1);
  return out;
};

const jaccard = (a: readonly string[], b: readonly string[]) => {
  const wa = new Set(a);
  const wb = new Set(b);
  if (!wa.size || !wb.size) return 0;
  const shared = [...wa].filter((w) => wb.has(w)).length;
  return shared / (wa.size + wb.size - shared);
};

/** How alike two questions are, 0 to 1: the larger of word overlap (Jaccard) and letter-trigram overlap (Dice). */
export function textSimilarity(a: string, b: string): number {
  const na = normaliseText(a);
  const nb = normaliseText(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ta = trigrams(na);
  const tb = trigrams(nb);
  let both = 0;
  let total = 0;
  for (const [g, n] of ta) both += Math.min(n, tb.get(g) ?? 0), (total += n);
  for (const n of tb.values()) total += n;
  return Math.max(jaccard(na.split(" "), nb.split(" ")), (2 * both) / total);
}

/** Questions at least this alike, from one user within REPHRASE_MS, count as the same question asked again. */
export const REPHRASE_SIMILARITY = 0.6;
export const REPHRASE_MS = 2 * 60_000;

// Short, common words of the panel's Latin-script languages; a guess, not a detector.
const STOPWORDS: Record<string, string[]> = {
  en: "the is are what how many much of in by and show me which per for to last this with total number average was were did do does from top each give".split(" "),
  fr: "le la les des du est sont quel quelle quels quelles combien par et dans pour sur au aux une un mois nombre moyenne montre montrez affiche ajoute ajoutez semaine chaque".split(" "),
  pt: "o os as do da dos das é são qual quais quantos quantas por e em no na nos nas para um uma mês número média mostre mostrar adicione semana cada".split(" "),
};

/** The question's language from its words: hi for Devanagari, else the Latin-script language with the most common words, or null. */
export function scriptLanguage(text: string): string | null {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (!letters.length) return null;
  const deva = letters.filter((c) => /\p{Script=Devanagari}/u.test(c)).length;
  if (deva * 2 > letters.length) return "hi";
  if (letters.filter((c) => /\p{Script=Latin}/u.test(c)).length * 2 <= letters.length) return null;
  const words = wordsOf(text);
  const scores = Object.entries(STOPWORDS).map(([lang, list]) => [lang, words.filter((w) => list.includes(w)).length] as const).sort((a, b) => b[1] - a[1]);
  const [best, second] = scores;
  return best && best[1] > 0 && best[1] > (second?.[1] ?? 0) ? best[0] : null;
}

// --- the client -----------------------------------------------------------------

export type ClientInfo = { device: DeviceClass | null; network: NetworkType | null; saveData: boolean | null; viewport: ViewportClass | null };

const oneOf = <T extends string>(v: unknown, list: readonly T[]): T | null => (typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : null);

/** What the browser said about itself, kept only when it is one of the known classes: never a raw user agent. */
export function clientInfo(input: unknown): ClientInfo {
  const c = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  return {
    device: oneOf(c.device, ["mobile", "tablet", "desktop"] as const),
    network: oneOf(c.network, ["slow-2g", "2g", "3g", "4g"] as const),
    saveData: typeof c.saveData === "boolean" ? c.saveData : null,
    viewport: oneOf(c.viewport, ["narrow", "medium", "wide"] as const),
  };
}

// --- classifying a turn -------------------------------------------------------------

/** One tool call of a turn and how it ended. */
export type ToolFact = { tool: string; input?: unknown; output?: unknown; error?: string };

export const EDIT_TOOLS = new Set(["add_widget", "update_widget", "move_widget", "resize_widget", "remove_widget", "add_filter", "update_filter", "remove_filter", "set_layout_mode", "rename_board", "restore_version"]);
const QUERY_TOOLS = new Set(["query", "run_sql"]);

const record = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** The tool calls in a model run's steps, read by shape: each step's tool-result and tool-error parts. */
export function factsFromSteps(steps: readonly unknown[]): ToolFact[] {
  const out: ToolFact[] = [];
  for (const s of steps)
    for (const c of (record(s)?.content as unknown[] | undefined) ?? []) {
      const p = record(c);
      if (!p || typeof p.toolName !== "string") continue;
      if (p.type === "tool-result") out.push({ tool: p.toolName, input: p.input, output: p.output });
      else if (p.type === "tool-error") out.push({ tool: p.toolName, input: p.input, error: (p.error instanceof Error ? p.error.message : String(p.error)).slice(0, 300) });
    }
  return out;
}

/** A call that worked: no error, and a result that does not say ok: false, applied: false or carry an error. */
export function factOk(f: ToolFact): boolean {
  if (f.error) return false;
  const o = record(f.output);
  return !(o && (o.ok === false || o.applied === false || (typeof o.error === "string" && o.error)));
}
const computeSteps = (f: ToolFact) => {
  const c = record(f.input)?.compute;
  return Array.isArray(c) ? c.length : 0;
};

/**
 * What kind of question a turn was, from its tool calls alone. chart: it tried to change the board. derived: its
 * queries had compute steps, or it needed more than one distinct query (a failed query retried does not count).
 * direct: one query. meta: no query and no edit (what the pack has, what is on the board, a greeting).
 */
export function classifyKind(facts: ToolFact[]): TurnKind {
  if (facts.some((f) => EDIT_TOOLS.has(f.tool))) return "chart";
  const queries = facts.filter((f) => QUERY_TOOLS.has(f.tool));
  if (!queries.length) return "meta";
  const worked = queries.filter(factOk);
  const counted = worked.length ? worked : queries;
  if (counted.some((f) => computeSteps(f) > 0)) return "derived";
  return new Set(counted.map((f) => JSON.stringify(f.input ?? null))).size > 1 ? "derived" : "direct";
}

/** What the turn's run said about how it ended, beside its tool calls. */
export type TurnEnd = {
  facts: ToolFact[];
  /** A stream error or an exception, as text. */
  error?: string | null;
  /** The first round's finish reason. */
  finish?: string | null;
  /** The first round stopped at the step cap without a reply. */
  stepCap?: boolean;
  /** The reviewer still found the change misleading after its fix round: nothing was saved. */
  rolledBack?: boolean;
  /** The staged changes could not be saved. */
  saveFailed?: boolean;
  /** The turn ended by asking the user a clarifying question. */
  clarify?: boolean;
  /** Edit refusals the tools reported. */
  refusals?: string[];
  /** The caller may read but not change the board. */
  readOnly?: boolean;
};

/**
 * How a turn ended, from its structured results, never from its words. failed: an error, a timeout, the step cap,
 * a change rolled back or not saved. clarify: it asked a clarifying question. declined: the provider declined it,
 * every edit was refused, or no query it ran returned data. answered: anything else.
 */
export function classifyOutcome(end: TurnEnd): { outcome: RecordedOutcome; reason: string | null } {
  if (end.error) return { outcome: "failed", reason: /time(d)? ?out|abort/i.test(end.error) ? "timeout" : "error" };
  if (end.stepCap) return { outcome: "failed", reason: "step-cap" };
  if (end.rolledBack) return { outcome: "failed", reason: "rolled-back" };
  if (end.saveFailed) return { outcome: "failed", reason: "not-saved" };
  if (end.clarify) return { outcome: "clarify", reason: null };
  if (end.finish === "content-filter") return { outcome: "declined", reason: "content-filter" };
  const kind = classifyKind(end.facts);
  if (kind === "chart" && !end.facts.some((f) => EDIT_TOOLS.has(f.tool) && factOk(f))) return { outcome: "declined", reason: end.readOnly ? "read-only" : "refused" };
  if ((kind === "direct" || kind === "derived") && !end.facts.some((f) => QUERY_TOOLS.has(f.tool) && factOk(f))) return { outcome: "declined", reason: "no-data" };
  if (kind === "meta" && (end.refusals?.length ?? 0) > 0) return { outcome: "declined", reason: "refused" };
  return { outcome: "answered", reason: null };
}

/** The counts a turn record carries about its tool calls. */
export function factCounts(facts: ToolFact[]) {
  const queries = facts.filter((f) => QUERY_TOOLS.has(f.tool));
  const edits = facts.filter((f) => EDIT_TOOLS.has(f.tool));
  return {
    toolCalls: facts.length,
    queries: queries.length,
    queriesFailed: queries.filter((f) => !factOk(f)).length,
    computeSteps: queries.filter(factOk).reduce((s, f) => s + computeSteps(f), 0),
    editsApplied: edits.filter(factOk).length,
    editsRefused: edits.filter((f) => !factOk(f)).length,
  };
}

/** The pack keys named anywhere in the turn's tool inputs, as the datasets they belong to, in first-use order. */
export function datasetsTouched(facts: ToolFact[], datasetOf: (key: string) => string | undefined): string[] {
  const out: string[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 6) return;
    if (typeof v === "string") {
      const name = datasetOf(v);
      if (name && !out.includes(name)) out.push(name);
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
    else if (v && typeof v === "object") Object.values(v).forEach((x) => walk(x, depth + 1));
  };
  for (const f of facts) walk(f.input, 0);
  return out;
}

// --- recording ---------------------------------------------------------------------

export type TelemetryOptions = {
  store: TelemetryStore;
  /** A keyed hash (the host keeps the key), given normalised text: equal texts share it, and nobody without the key can test a guess. */
  hash: (text: string) => string;
  /** Whether to record now (the telemetry switch, which turns every signal off). */
  on?: () => boolean;
  /**
   * The signals recording now (signals.ts signalsOn), read on every record: a record keeps only their fields.
   * Absent: the catalogue's defaults. Texts (questions, transcripts, comments) are kept only with question-text
   * and transcript-text on; otherwise a keyed hash stands in.
   */
  signals?: () => ReadonlySet<string>;
  /** The deployment's context: what a board, dataset or role belongs to. */
  context?: () => DeploymentContext;
  now?: () => Date;
  /** How long a transcript may wait for the question it was spoken for before it counts as abandoned. */
  transcriptWaitMs?: number;
  newId?: () => string;
};

/** Who is asking, as the host's identity says: the user, the role names it signed, the tenant. */
export type Asker = Pick<Identity, "user" | "tenant"> & { roles: string[] };

/** A turn as it starts. */
export type TurnStart = {
  turnId: string;
  who: Asker;
  board: string | null;
  pack: string;
  question: string;
  /** The transcript ids the request named. */
  transcriptIds: string[];
  /** The request holds a single question: a new conversation. */
  newConversation: boolean;
  languagePicked: string | null;
  client: unknown;
  /** The viewer's dashboard filter selections, part of the turn's context. */
  selections?: Record<string, string>;
  builder: string;
  effort: string | null;
  readOnly: boolean;
  /** The dataset a pack key reads, by the name the deployment knows it by. */
  datasetOf: (key: string) => string | undefined;
  /** When the request arrived (ms), for the timings. */
  startedAt?: number;
};

/** A turn's cost as the host meters it, read by shape: the total, and a line per model role. */
export type TurnCostLike = { total: { usd: number; unpriced: number; inputTokens: number; outputTokens: number }; models: { role: string; model: string; usd: number }[] };

/** What a turn's own code may say beside what is read from its run: the tier of a reused answer, or that it asked a clarifying question. */
export type TurnMarks = { reuse?: string | null; reuseSavedUsd?: number | null; clarify?: boolean; queueMs?: number | null };

/**
 * The hooks a host calls on a turn, each one line where the thing happens. The record is written by record(), once
 * ended() has been called, even when the reader left long before.
 */
export type TurnCapture = {
  turnId: string;
  sessionId: string;
  /** The stream part that tells the client the turn's id (for its feedback). */
  part(): { type: "data-turn"; data: { turnId: string; sessionId: string } };
  /** One model round ended: its steps, its finish reason, whether it said anything, and whether it was the fix round. */
  round(r: { steps: readonly unknown[]; finish: string; answered: boolean; maxSteps: number; fix: boolean }): void;
  reviewed(r: { material: number; fix: boolean }): void;
  failed(e: unknown): void;
  mark(m: TurnMarks): void;
  /** Passes the reply stream through, timing the first words and noting an error, the end, and parts that mark the turn. */
  watch<T extends { type: string }>(stream: ReadableStream<T>): ReadableStream<T>;
  /** The reader went away (counts only before the reply finished). */
  left(): void;
  ended(e: { cost?: TurnCostLike; rolledBack?: boolean; saveFailed?: boolean; refusals?: string[] }): void;
  record(): Promise<void>;
};

export type EventInput = { type?: unknown; turnId?: unknown; data?: unknown; [k: string]: unknown };
/** recorded: false when the signal that keeps this event is switched off (accepted, not written). */
export type EventResult = { ok: true; recorded: boolean } | { ok: false; status: number; error: string };

const SESSION_IDLE_MS = 30 * 60_000;
/** A turn in flight is known by its id this long; after that its record answers who it belongs to. */
const OPEN_TURN_MS = 60 * 60_000;
const SECRET_KEY = /key|token|secret|password|passwd|authori[sz]ation|cookie|credential|dsn|connection/i;
const EVENT_TYPE = /^[a-z][a-z0-9-]{1,39}$/;
const DATA_KEY = /^[A-Za-z][\w-]{0,39}$/;
const ID = /^[\w-]{1,64}$/;

/** Working state, as kept between turns: texts only when question text is on, and always the hashed words. */
type Session = { id: string; board: string | null; last: number };
type Asked = { turnId: string; at: number; text: string | null; words: string[]; spoken: boolean };
type OpenTurn = { user: string; tenant: string | null; sessionId: string; board: string | null; pack: string; at: number };
type Heard = { id: string; user: string; at: number; text: string | null; hashed: string; words: string[]; language: string | null; pack: string | null };

export type Telemetry = ReturnType<typeof turnTelemetry>;

export function turnTelemetry(opts: TelemetryOptions) {
  const store = opts.store;
  const now = () => (opts.now ?? (() => new Date()))().getTime();
  const enabled = () => opts.on?.() ?? true;
  const defaults: SwitchValues = { telemetry: true, ...signalDefaults() };
  /** The signals on now: none while telemetry is off. */
  const on = (): ReadonlySet<string> => (enabled() ? (opts.signals?.() ?? signalsOn(defaults, { voice: true, clarify: true, cache: true })) : new Set());
  const keepText = () => on().has("question-text");
  const keepTranscript = () => on().has("transcript-text");
  const waitMs = opts.transcriptWaitMs ?? 60 * 60_000;
  const newId = opts.newId ?? (() => globalThis.crypto.randomUUID());
  // Over the normalised words, so equal questions share a hash whatever their case and punctuation.
  const hash = (s: string) => opts.hash(normaliseText(s));
  const text = (s: string | null) => (s === null ? null : keepText() ? s : null);
  const heardText = (s: string | null) => (s === null ? null : keepTranscript() ? s : null);
  /** Writes a record with only the fields its on signals need. */
  const append = <T extends TurnRecord | TranscriptRecord | EventRecord>(kind: "turn" | "transcript" | "event", line: T) => store.append(onlyKept(kind, line, on()) as TelemetryLine);
  const iso = (ms: number) => new Date(ms).toISOString();
  /** The words of a text as working state keeps them: each one hashed, so edits and overlaps can be counted whether or not texts are kept. */
  const keptWords = (s: string) => wordsOf(s).map((w) => hash(w).slice(0, 10));

  /** The conversation a turn belongs to: the last one, unless 30 minutes passed, the board changed or a new chat began. */
  async function sessionFor(user: string, board: string | null, at: number, fresh: boolean): Promise<string> {
    const key = `session:${user}`;
    const s = await store.state.get<Session>(key);
    const id = s && !fresh && s.board === board && at - s.last <= SESSION_IDLE_MS ? s.id : `s_${newId().replace(/-/g, "").slice(0, 16)}`;
    await store.state.put(key, { id, board, last: at } satisfies Session, SESSION_IDLE_MS);
    return id;
  }

  /** Which earlier turn of this user, within two minutes, asked the same thing (any, and a spoken one). */
  async function repeats(user: string, now_: Asked): Promise<{ rephraseOf: string | null; reAskAfterVoice: string | null }> {
    const key = `asked:${user}`;
    const mine = ((await store.state.get<Asked[]>(key)) ?? []).filter((r) => now_.at - r.at <= REPHRASE_MS);
    const alike = (r: Asked) => (r.text !== null && now_.text !== null ? textSimilarity(r.text, now_.text) : jaccard(r.words, now_.words)) >= REPHRASE_SIMILARITY;
    const similar = mine.filter(alike);
    const last = similar.at(-1);
    const lastSpoken = similar.filter((r) => r.spoken).at(-1);
    await store.state.put(key, [...mine, now_].slice(-10), REPHRASE_MS);
    return { rephraseOf: last?.turnId ?? null, reAskAfterVoice: lastSpoken && lastSpoken === last ? lastSpoken.turnId : null };
  }

  /** Who a turn belongs to: while in flight from working state, then from its record (the last 30 days). */
  async function ownerOf(turnId: string): Promise<OpenTurn | null> {
    const open = await store.state.get<OpenTurn>(`turn:${turnId}`);
    if (open) return open;
    const [line] = await store.find({ from: new Date(now() - 30 * 86_400_000), type: "turn", turnId });
    // A record written with the user signals off names nobody: no one can report on it.
    return line?.type === "turn" && line.user ? { user: line.user, tenant: line.tenant ?? null, sessionId: line.sessionId ?? "", board: line.board, pack: line.pack, at: Date.parse(line.at) } : null;
  }

  const eventLine = (e: Partial<EventRecord> & Pick<EventRecord, "event" | "user">): EventRecord => ({
    type: "event",
    v: TELEMETRY_VERSION,
    at: iso(now()),
    roles: [],
    turnId: null,
    sessionId: null,
    board: null,
    pack: null,
    rating: null,
    reason: null,
    comment: null,
    commentHash: null,
    transcriptId: null,
    transcript: null,
    transcriptSent: null,
    transcriptEditDistance: null,
    transcriptWords: null,
    how: null,
    stage: null,
    choice: null,
    data: null,
    ...e,
  });

  /** Transcripts no question claimed in time: each recorded once as abandoned after transcription. */
  async function sweep() {
    const t = now();
    for (const { key, value } of await store.state.list<Heard>("heard:")) {
      if (t - value.at < waitMs) continue;
      const p = await store.state.take<Heard>(key);
      if (!p || !on().has("voice-not-sent")) continue;
      await append("event", eventLine({ event: "abandoned", user: p.user, pack: p.pack, transcriptId: p.id, transcript: p.text, how: "not-sent", stage: "after-transcription", data: { waitedMs: t - p.at } }));
    }
  }

  return {
    enabled,
    /** The signals recording now. */
    signals: on,
    hash,
    sweep,

    /** A transcription the speech endpoint returned: recorded now, and waiting for the question it was spoken for. */
    async transcribed(t: { id: string; who: Asker; pack: string | null; model: string; languageRequested: string | null; languageDetected: string | null; seconds: number | null; usd: number | null; ms: number; retried: boolean; text: string; audio?: AudioLink | null }) {
      if (!enabled()) return;
      const at = now();
      // A transcript record only while some signal reads one (its cost, its words, the text, the recording).
      if (keptFields("transcript", on()).size > CORE_FIELDS.transcript.length)
        await append("transcript", {
        type: "transcript",
        v: TELEMETRY_VERSION,
        transcriptId: t.id,
        at: iso(at),
        user: t.who.user,
        roles: t.who.roles,
        pack: t.pack,
        model: t.model,
        languageRequested: t.languageRequested,
        languageDetected: t.languageDetected,
        seconds: t.seconds,
        usd: t.usd,
        ms: t.ms,
        retried: t.retried,
        transcript: t.text,
        transcriptHash: hash(t.text),
        words: wordsOf(t.text).length,
        audio: t.audio ?? null,
      });
      // Only words the user can send wait for a question; an empty transcript is a miss, not an abandoned one.
      if (t.text.trim()) await store.state.put(`heard:${t.id}`, { id: t.id, user: t.who.user, at, text: heardText(t.text), hashed: hash(t.text), words: keptWords(t.text), language: t.languageDetected ?? t.languageRequested, pack: t.pack } satisfies Heard, waitMs + 86_400_000);
    },

    /** Starts a turn: its session and the repeats it makes now, and the hooks that gather the rest. Null while telemetry is off. */
    async begin(s: TurnStart): Promise<TurnCapture | null> {
      if (!enabled()) return null;
      const startedAt = s.startedAt ?? now();
      const at = now();
      const ids = s.transcriptIds.filter((id) => ID.test(id)).slice(0, 10);
      // The transcripts this question was spoken through: each claimed once, and only by its speaker.
      const heard: Heard[] = [];
      for (const id of ids) {
        const h = await store.state.get<Heard>(`heard:${id}`);
        if (h?.user !== s.who.user) continue;
        const taken = await store.state.take<Heard>(`heard:${id}`);
        if (taken) heard.push(taken);
      }
      const spoken = ids.length > 0;
      const sessionId = await sessionFor(s.who.user, s.board, at, s.newConversation);
      const words = keptWords(s.question);
      const { rephraseOf, reAskAfterVoice } = await repeats(s.who.user, { turnId: s.turnId, at, text: text(s.question), words, spoken });
      await store.state.put(`turn:${s.turnId}`, { user: s.who.user, tenant: s.who.tenant ?? null, sessionId, board: s.board, pack: s.pack, at } satisfies OpenTurn, OPEN_TURN_MS);
      const transcriptText = heard.every((h) => h.text !== null) && heard.length ? heard.map((h) => h.text).join(" ") : null;
      const transcriptWords = heard.flatMap((h) => h.words);
      const questionLanguage = heard.find((h) => h.language)?.language?.split("-")[0] ?? scriptLanguage(s.question);
      const picked = s.languagePicked;

      // What the run reports, as it goes.
      const facts: ToolFact[] = [];
      const end: Omit<TurnEnd, "facts"> & { review: { ran: boolean; material: number; fixRound: boolean }; cost?: TurnCostLike } = { review: { ran: false, material: 0, fixRound: false }, readOnly: s.readOnly };
      const marks: TurnMarks = {};
      let firstTokenMs: number | null = null;
      let finished = false;
      let abandonedMs: number | null = null;
      let done = () => {};
      const ended = new Promise<void>((r) => (done = r));

      return {
        turnId: s.turnId,
        sessionId,
        part: () => ({ type: "data-turn", data: { turnId: s.turnId, sessionId } }),
        round(r) {
          facts.push(...factsFromSteps(r.steps));
          if (r.fix) end.review.fixRound = true;
          else {
            end.finish = r.finish;
            // The step cap, not the guard on repeated refusals: that one stops a turn the pack cannot do.
            end.stepCap = r.finish === "tool-calls" && !r.answered && r.steps.length >= r.maxSteps;
          }
        },
        reviewed(r) {
          end.review.ran = true;
          if (!r.fix) end.review.material = r.material;
        },
        failed(e) {
          end.error ??= (e instanceof Error ? e.message : String(e)).slice(0, 300);
        },
        mark(m) {
          if (m.clarify) marks.clarify = true;
          if (m.reuse !== undefined) marks.reuse ??= m.reuse;
          if (m.reuseSavedUsd !== undefined) marks.reuseSavedUsd ??= m.reuseSavedUsd;
          if (m.queueMs !== undefined) marks.queueMs = m.queueMs;
        },
        watch<T extends { type: string }>(stream: ReadableStream<T>) {
          return stream.pipeThrough(
            new TransformStream<T, T>({
              transform(chunk, out) {
                const c = chunk as T & { errorText?: string; data?: { tier?: unknown; savedUsd?: unknown } };
                if (c.type === "text-delta" && firstTokenMs === null) firstTokenMs = now() - startedAt;
                else if (c.type === "error") end.error ??= String(c.errorText ?? "error").slice(0, 300);
                else if (c.type === "finish") finished = true;
                else if (c.type === "data-quick-replies" || c.type === "data-clarify") marks.clarify = true;
                else if (c.type === "data-reuse") {
                  marks.reuse ??= String(c.data?.tier ?? "reused");
                  if (typeof c.data?.savedUsd === "number") marks.reuseSavedUsd ??= c.data.savedUsd;
                }
                out.enqueue(chunk);
              },
            }),
          );
        },
        left() {
          if (!finished) abandonedMs ??= now() - startedAt;
        },
        ended(e) {
          end.cost = e.cost;
          end.rolledBack = e.rolledBack;
          end.saveFailed = e.saveFailed;
          end.refusals = e.refusals;
          done();
        },
        async record() {
          await ended;
          if (!enabled()) return;
          const { outcome, reason } = classifyOutcome({ facts, ...end, clarify: end.clarify || marks.clarify });
          const datasets = datasetsTouched(facts, s.datasetOf);
          const lines = end.cost?.models ?? [];
          const usd = (keep: (role: string) => boolean) => Math.round(lines.filter((m) => keep(m.role)).reduce((t, m) => t + m.usd, 0) * 1e6) / 1e6;
          const line: TurnRecord = {
            type: "turn",
            v: TELEMETRY_VERSION,
            turnId: s.turnId,
            sessionId,
            at: iso(at),
            user: s.who.user,
            roles: s.who.roles,
            tenant: s.who.tenant ?? null,
            board: s.board,
            pack: s.pack,
            datasets,
            selections: s.selections && Object.keys(s.selections).length ? Object.fromEntries(Object.entries(s.selections).map(([f, v]) => [f, keepText() ? v : hash(v)])) : null,
            ...contextFor(opts.context?.() ?? {}, { board: s.board, datasets, roles: s.who.roles }),
            languagePicked: picked,
            replyLanguage: picked && picked !== "auto" ? picked.split("-")[0]! : questionLanguage,
            questionLanguage,
            input: spoken ? "spoken" : "typed",
            question: s.question,
            questionHash: hash(s.question),
            questionWords: wordsOf(s.question).length,
            transcriptId: ids[0] ?? null,
            transcriptIds: ids,
            transcript: transcriptText,
            transcriptHash: heard.length === 1 ? heard[0]!.hashed : heard.length ? hash(heard.map((h) => h.hashed).join(" ")) : null,
            transcriptEditDistance: heard.length ? editDistance(transcriptWords, words) : null,
            kind: classifyKind(facts),
            outcome,
            outcomeReason: reason,
            ...factCounts(facts),
            firstTokenMs,
            totalMs: now() - startedAt,
            abandoned: abandonedMs !== null,
            abandonedMs,
            costUsd: end.cost?.total.usd ?? 0,
            modelUsd: usd((r) => r !== "review" && r !== "speech"),
            speechUsd: usd((r) => r === "speech"),
            reviewUsd: usd((r) => r === "review"),
            unpricedCalls: end.cost?.total.unpriced ?? 0,
            tokensIn: end.cost?.total.inputTokens ?? 0,
            tokensOut: end.cost?.total.outputTokens ?? 0,
            models: [...new Set([...lines.filter((m) => m.role !== "speech"), ...lines.filter((m) => m.role === "speech")].map((m) => m.model))],
            builder: s.builder,
            effort: s.effort,
            reviewRan: end.review.ran,
            reviewMaterial: end.review.material,
            fixRound: end.review.fixRound,
            reuse: marks.reuse ?? null,
            reuseSavedUsd: marks.reuse ? (marks.reuseSavedUsd ?? null) : null,
            queueMs: marks.queueMs ?? null,
            rephraseOf,
            reAskAfterVoice,
            ...clientInfo(s.client),
          };
          await append("turn", line);
          // Its record says whose it is from now on.
          await store.state.take(`turn:${s.turnId}`);
        },
      };
    },

    /** An event a client reports (feedback, a corrected transcript, an answer left early, …), checked and kept. */
    async event(who: Asker & { board?: string | null; pack?: string | null }, body: EventInput): Promise<EventResult> {
      if (!enabled()) return { ok: false, status: 404, error: "telemetry is off on this server" };
      const type = body.type;
      if (typeof type !== "string" || !EVENT_TYPE.test(type)) return { ok: false, status: 400, error: "type must be a short lower-case name, like feedback" };
      let owner: OpenTurn | null = null;
      if (body.turnId !== undefined && body.turnId !== null) {
        if (typeof body.turnId !== "string" || !ID.test(body.turnId)) return { ok: false, status: 400, error: "bad turnId" };
        owner = await ownerOf(body.turnId);
        if (!owner) return { ok: false, status: 404, error: "no such turn" };
        if (!reportsOn(who, owner)) return { ok: false, status: 403, error: "that turn is not yours" };
      }
      const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
      const base = { event: type, user: who.user, roles: who.roles, turnId: (body.turnId as string | undefined) ?? null, sessionId: owner?.sessionId ?? null, board: owner?.board ?? who.board ?? null, pack: owner?.pack ?? who.pack ?? null };
      const data = flatData(body.data);
      if (data === undefined) return { ok: false, status: 400, error: "data must be a flat map of up to 20 short values" };
      // The signal that keeps this event: none, not an event this server records; switched off, accepted and not written.
      const signal = signalForEvent(type, typeof body.stage === "string" ? body.stage : null);
      if (!signal) return { ok: false, status: 400, error: `not an event this server records: ${type}` };
      const keeps = on().has(signal.id);

      if (type === "feedback") {
        if (!owner) return { ok: false, status: 400, error: "feedback needs the turnId it is about" };
        const rating = body.rating === "up" || body.rating === "down" ? body.rating : null;
        if (!rating) return { ok: false, status: 400, error: 'rating must be "up" or "down"' };
        const reason = body.reason === undefined || body.reason === null ? null : oneOf(body.reason, FEEDBACK_REASONS);
        if (body.reason !== undefined && body.reason !== null && !reason) return { ok: false, status: 400, error: `reason must be one of ${FEEDBACK_REASONS.join(", ")}` };
        const comment = str(body.comment, 1000);
        if (keeps) await append("event", eventLine({ ...base, rating, reason, comment, commentHash: comment === null ? null : hash(comment), data }));
        return { ok: true, recorded: keeps };
      }
      if (type === "transcript") {
        // The fallback when a question was spoken without a transcript id: both texts, from the browser.
        const returned = str(body.transcript, 4000);
        const sent = str(body.sent, 4000);
        if (returned === null || sent === null) return { ok: false, status: 400, error: "transcript and sent are both needed" };
        if (keeps) await append("event", eventLine({ ...base, transcript: returned, transcriptSent: sent, transcriptEditDistance: wordEditDistance(returned, sent), transcriptWords: wordsOf(sent).length, data }));
        return { ok: true, recorded: keeps };
      }
      const how = str(body.how, 40);
      const stage = str(body.stage, 40);
      const choice = str(body.choice, 200);
      if (keeps) await append("event", eventLine({ ...base, how, stage, choice: choice === null ? null : keepText() ? choice : hash(choice), data }));
      return { ok: true, recorded: keeps };
    },

    /** Records between from and to (newest first), optionally of one type, a page at a time. */
    async read(q: { from: Date; to?: Date; type?: TelemetryLine["type"]; offset?: number; limit?: number }) {
      const all = await store.find({ from: q.from, to: q.to ?? new Date(now()), type: q.type });
      const offset = Math.max(0, Math.floor(q.offset ?? 0));
      const limit = Math.max(1, Math.min(Math.floor(q.limit ?? 500), 5000));
      const records = all.slice(offset, offset + limit);
      return { total: all.length, offset, limit, next: offset + limit < all.length ? offset + limit : null, records };
    },
  };
}

/** A client's extra fields: up to 20 short scalars under plain names, nothing that looks like a secret. undefined: refused. */
function flatData(input: unknown): Record<string, Scalar> | null | undefined {
  if (input === undefined || input === null) return null;
  if (typeof input !== "object" || Array.isArray(input)) return undefined;
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > 20) return undefined;
  const out: Record<string, Scalar> = {};
  for (const [k, v] of entries) {
    if (!DATA_KEY.test(k)) return undefined;
    if (SECRET_KEY.test(k)) continue;
    if (v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) out[k] = v as Scalar;
    else if (typeof v === "string") out[k] = v.slice(0, 500);
    else return undefined;
  }
  return Object.keys(out).length ? out : null;
}

/** The same records with each user name replaced by a stable stand-in, for a reader who may not see names. */
export function withoutNames<L extends { user?: string }>(lines: L[], hash: (text: string) => string): L[] {
  return lines.map((l) => (typeof l.user === "string" ? { ...l, user: `u_${hash(`user:${l.user}`).slice(0, 12)}` } : l));
}
