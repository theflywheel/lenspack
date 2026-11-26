// The turn gate. Questions come in bursts (a morning briefing, an evening review), and a burst of
// model turns all at once hits the provider's rate limit and slows every answer. So at most
// `maxConcurrent` model turns run at a time; the next `maxWaiting` wait their turn for at most
// `maxWaitSeconds`, and are told their place and about how long; past that, the asker is told the
// assistant is busy and to try again in a minute. Saved answers (reuse/) never wait: they are
// answered before a turn asks for a place.
//
// Edits to one board run one after another: a second edit turn on a board waits for the first to
// finish, and then reads the board as the first left it, instead of editing a board that changed
// under it.
//
// TurnGate is the interface a host uses. localTurnGate keeps its counts and lines in this process,
// which is right for one copy of a host. Two copies behind one address need a shared one (a
// Postgres advisory lock per board and a counter row, or Redis): the same interface, another backend.

import type { SettingsLike } from "./reuse/settings";

export type QueueSettings = {
  /** Model turns running at once, across the server. */
  maxConcurrent: number;
  /** Turns that may wait for a place; one more is told to try again later. */
  maxWaiting: number;
  /** The longest a turn waits for a place (and a call retries a rate limit) before giving up. */
  maxWaitSeconds: number;
};

export const QUEUE_DEFAULTS: QueueSettings = { maxConcurrent: 8, maxWaiting: 50, maxWaitSeconds: 60 };
const LIMITS: Record<keyof QueueSettings, [number, number]> = { maxConcurrent: [1, 200], maxWaiting: [0, 2000], maxWaitSeconds: [1, 600] };

/** A waiting turn's place, sent to the chat as a `data-queue` part. */
export type QueueWait = { state: "waiting"; reason: "busy" | "edit"; position: number; etaSeconds: number };

export class QueueBusy extends Error {
  constructor(
    readonly why: "full" | "timeout",
    readonly retryAfterSeconds: number,
  ) {
    super(why === "full" ? "the queue is full" : "waited too long for a place");
  }
}

export type TurnPlace = {
  /** How long the turn waited, in ms. */
  queueMs: number;
  /** It waited for another edit on the same board: the board may have changed meanwhile. */
  boardWaited: boolean;
  release(): void;
};

/** Places for model turns: the interface a shared backend implements for a host that runs more than one copy. */
export interface TurnGate {
  /**
   * A place for one model turn. `edit`: the turn is likely to change `board`, so it waits for any
   * other edit turn on it first. Throws QueueBusy when the line is full or the wait runs out.
   */
  acquire(o?: { board?: string; edit?: boolean; onWait?: (w: QueueWait) => void }): Promise<TurnPlace>;
  settings(): QueueSettings;
  /** Running and waiting turns, for the admin page. */
  stats(): { running: number; waiting: number; editsWaiting: number; turnSeconds: number };
}

type Waiter = { go: () => void; notify: (w: QueueWait) => void };

/** The gate in this process: right for one copy of a host. */
export function localTurnGate(settings: () => QueueSettings = () => QUEUE_DEFAULTS): TurnGate {
  let running = 0;
  const waiting: Waiter[] = [];
  // A board with an edit turn running, and the edit turns waiting for it.
  const boards = new Map<string, Waiter[]>();
  // How long recent turns ran, for the wait estimate.
  const recent: number[] = [];
  const turnMs = () => (recent.length ? recent.reduce((s, x) => s + x, 0) / recent.length : 20_000);
  const eta = (position: number, lanes: number) => Math.max(1, Math.ceil((position * turnMs()) / lanes / 1000));
  const renumber = () => waiting.forEach((w, i) => w.notify({ state: "waiting", reason: "busy", position: i + 1, etaSeconds: eta(i + 1, settings().maxConcurrent) }));
  const renumberBoard = (q: Waiter[]) => q.forEach((w, i) => w.notify({ state: "waiting", reason: "edit", position: i + 1, etaSeconds: eta(i + 1, 1) }));

  /** Waits in a line until let through, or until the deadline. */
  const wait = (line: Waiter[], notify: (w: QueueWait) => void, deadline: number, renum: () => void) =>
    new Promise<void>((resolve, reject) => {
      const me: Waiter = {
        go: () => {
          clearTimeout(timer);
          resolve();
        },
        notify,
      };
      const timer = setTimeout(() => {
        const at = line.indexOf(me);
        if (at >= 0) line.splice(at, 1);
        renum();
        reject(new QueueBusy("timeout", 60));
      }, Math.max(0, deadline - Date.now()));
      line.push(me);
      renum();
    });

  const next = () => {
    while (running < settings().maxConcurrent && waiting.length) {
      running++;
      waiting.shift()!.go();
    }
    renumber();
  };
  const releaseBoard = (key: string) => {
    const q = boards.get(key);
    if (q?.length) {
      q.shift()!.go();
      renumberBoard(q);
    } else boards.delete(key);
  };

  return {
    async acquire(o: { board?: string; edit?: boolean; onWait?: (w: QueueWait) => void } = {}): Promise<TurnPlace> {
      const s = settings();
      const start = Date.now();
      const deadline = start + s.maxWaitSeconds * 1000;
      const notify = o.onWait ?? (() => undefined);
      const key = o.edit && o.board ? o.board : null;
      let boardWaited = false;
      if (key) {
        const q = boards.get(key);
        if (!q) boards.set(key, []);
        else {
          if (q.length >= Math.max(1, s.maxWaiting)) throw new QueueBusy("full", 60);
          boardWaited = true;
          await wait(q, notify, deadline, () => renumberBoard(q));
        }
      }
      try {
        if (running < s.maxConcurrent && !waiting.length) running++;
        else {
          if (waiting.length >= s.maxWaiting) throw new QueueBusy("full", 60);
          await wait(waiting, notify, deadline, renumber);
        }
      } catch (e) {
        if (key) releaseBoard(key);
        throw e;
      }
      const queueMs = Date.now() - start;
      let done = false;
      return {
        queueMs,
        boardWaited,
        release() {
          if (done) return;
          done = true;
          recent.push(Date.now() - start - queueMs);
          if (recent.length > 20) recent.shift();
          running--;
          next();
          if (key) releaseBoard(key);
        },
      };
    },
    settings,
    stats: () => ({ running, waiting: waiting.length, editsWaiting: [...boards.values()].reduce((n, q) => n + q.length, 0), turnSeconds: Math.round(turnMs() / 100) / 10 }),
  };
}

/** A word that asks to change a board ("add", "remove", "make", …, in English, French, Portuguese and Hindi). */
const EDIT_WORDS =
  /(?<![\p{L}])(add|remove|delete|drop|change|make|move|put|rename|replace|resize|swap|sort|hide|widen|narrow|split|merge|group|colou?r|ajoute[rz]?|supprime[rz]?|enl[eè]ve[rz]?|change[rz]?|modifie[rz]?|d[eé]place[rz]?|renomme[rz]?|mets|mettez|remplace[rz]?|adicion[ea]r?|remov[ea]r?|apag[ea]r?|alter[ea]r?|mud[ea]r?|mov[ea]r?|renomei[ea]r?|coloqu[ea]r?|substitu[ia]r?|जोड़ो|जोड़ें|जोड़िए|हटाओ|हटाएं|हटाइए|बदलो|बदलें|बदलिए|बनाओ|बनाएं|बनाइए)(?![\p{L}])/iu;
export const looksLikeEdit = (question: string) => EDIT_WORDS.test(question);

/** A partial queue settings object, checked. */
export function queueSettingsFrom(input: unknown, where = "queue"): Partial<QueueSettings> {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) throw new Error(`${where} must be a map`);
  const out: Partial<QueueSettings> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!(k in LIMITS)) throw new Error(`${where}: unknown setting "${k}" (${Object.keys(LIMITS).join(", ")})`);
    const [min, max] = LIMITS[k as keyof QueueSettings];
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new Error(`${where}.${k} is a whole number from ${min} to ${max}`);
    out[k as keyof QueueSettings] = v;
  }
  return out;
}

/** The queue's settings: the config's `queue:`, then an admin's changes (settings.json, section "queue"). */
export function queueSettings(settings: SettingsLike | null, config?: unknown) {
  const defaults: QueueSettings = { ...QUEUE_DEFAULTS, ...queueSettingsFrom(config) };
  const saved = () => settings?.get<Partial<QueueSettings>>("queue") ?? {};
  const get = (): QueueSettings => ({ ...defaults, ...saved() });
  return {
    get,
    view: (writable: boolean) => ({ ...get(), defaults, source: Object.keys(saved()).length ? "settings" : "default", writable }),
    update(body: Record<string, unknown>): { ok: true } | { ok: false; error: string } {
      if (!settings) return { ok: false, error: "settings cannot be changed on this server" };
      const next: Record<string, unknown> = { ...saved() };
      const set: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(body)) {
        if (v === null) delete next[k];
        else set[k] = v;
      }
      try {
        Object.assign(next, queueSettingsFrom(set));
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      for (const k of Object.keys(body)) if (!(k in LIMITS)) return { ok: false, error: `queue: unknown setting "${k}"` };
      settings.set("queue", Object.keys(next).length ? next : undefined);
      return { ok: true };
    },
  };
}
