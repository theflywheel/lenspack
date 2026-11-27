// How many questions one person may ask the assistant: a daily quota and two rolling windows. Pure functions of the
// deployment's limits and the counts the host keeps; the host keeps the counters, calls decideQuestion() before any
// model or data call, and answers 429 with the refusal it returns.
//
// The windows are sliding: "5 a minute" means at most 5 questions in any 60 seconds, counted from the times the
// questions were asked. That lets a person ask several at once (a burst) and still stops a script or a stuck client
// within a minute. It is also exact, easy to say in a message ("you have asked 5 questions in the last minute"), and
// the wait it gives is exact: the moment the oldest question in the window is a minute old. A token bucket would
// allow the same bursts but is harder to explain to the person refused.

/** One person's limits; 0 or absent is no limit. */
export type QuestionLimits = {
  /** Questions answered by the model per person per UTC day. */
  questionsPerDay?: number;
  /** Questions per person in any 60 seconds. */
  perMinute?: number;
  /** Questions per person in any 60 minutes. */
  perHour?: number;
};

/** The deployment's per-person limits: everyone's, whether admins are held to them, and higher (or lower) ones for named people. */
export type PerUserLimits = QuestionLimits & {
  /** Admins are not refused (they are still counted). Default false: admins are held to the limits like everyone. */
  adminsExempt?: boolean;
  /** By user name: limits that replace everyone's for that person, field by field. */
  users?: Record<string, QuestionLimits>;
};

export const LIMIT_KEYS = ["questionsPerDay", "perMinute", "perHour"] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];
/** The highest value each limit takes (0 is off). */
export const LIMIT_MAX: Record<LimitKey, number> = { questionsPerDay: 100_000, perMinute: 1_000, perHour: 10_000 };
const WINDOW_MS: Record<Exclude<LimitKey, "questionsPerDay">, number> = { perMinute: 60_000, perHour: 3_600_000 };

/** Whether any limit is set, for anyone. */
export const limitsOn = (l: PerUserLimits) => LIMIT_KEYS.some((k) => (l[k] ?? 0) > 0) || Object.values(l.users ?? {}).some((u) => LIMIT_KEYS.some((k) => (u[k] ?? 0) > 0));

/** One person's limits: everyone's, with their own entry's fields in place of those. */
export function questionLimitsFor(l: PerUserLimits, user: string): Required<QuestionLimits> {
  const own = Object.hasOwn(l.users ?? {}, user) ? l.users![user]! : {};
  const pick = (k: LimitKey) => own[k] ?? l[k] ?? 0;
  return { questionsPerDay: pick("questionsPerDay"), perMinute: pick("perMinute"), perHour: pick("perHour") };
}

/** What the host counted for this person. */
export type LimitFacts = {
  user: string;
  /** Lenspack's admin role (adminRights().administer). */
  admin: boolean;
  /** Questions counted against today's quota so far (including any still running). */
  today: number;
  /** When each of their recent questions was asked (ms since 1970), any order; older than an hour may be left out. */
  recent: readonly number[];
  now: number;
};

export type LimitRefusal = {
  ok: false;
  /** Which limit was reached. */
  limit: LimitKey;
  /** The limit's value. */
  max: number;
  /** Whole seconds until the person may ask again (at least 1): the Retry-After header. */
  retryAfterSeconds: number;
  /** When that is. */
  freeAt: string;
};
export type LimitDecision = { ok: true } | LimitRefusal;

const nextUtcMidnight = (now: number) => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
};

/**
 * May this person ask one more question now? Refused when today's count has reached the daily quota, or the questions
 * in the last minute or hour have reached that window's limit. When several are reached, the refusal names the one that
 * frees up last, so the wait it gives is the real one. Exempt admins are never refused.
 */
export function decideQuestion(limits: PerUserLimits, f: LimitFacts): LimitDecision {
  if (f.admin && limits.adminsExempt) return { ok: true };
  const mine = questionLimitsFor(limits, f.user);
  const refusals: LimitRefusal[] = [];
  const refuse = (limit: LimitKey, max: number, at: number) => {
    const secs = Math.max(1, Math.ceil((at - f.now) / 1000));
    refusals.push({ ok: false, limit, max, retryAfterSeconds: secs, freeAt: new Date(f.now + secs * 1000).toISOString() });
  };
  if (mine.questionsPerDay > 0 && f.today >= mine.questionsPerDay) refuse("questionsPerDay", mine.questionsPerDay, nextUtcMidnight(f.now));
  for (const k of ["perHour", "perMinute"] as const) {
    const max = mine[k];
    if (max <= 0) continue;
    const inWindow = f.recent.filter((t) => t > f.now - WINDOW_MS[k] && t <= f.now).sort((a, b) => a - b);
    // One more is allowed once the window holds max - 1: when the question at inWindow[length - max] leaves it.
    if (inWindow.length >= max) refuse(k, max, inWindow[inWindow.length - max]! + WINDOW_MS[k]);
  }
  if (!refusals.length) return { ok: true };
  return refusals.reduce((a, b) => (b.retryAfterSeconds > a.retryAfterSeconds ? b : a));
}

/** The values a config, the environment or the settings page gave, checked: whole numbers from 0 to the limit's maximum. */
export function questionLimitsFrom(input: unknown, where = "limits.perUser"): QuestionLimits {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) throw new Error(`${where} must be a map`);
  const out: QuestionLimits = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!(LIMIT_KEYS as readonly string[]).includes(k)) throw new Error(`${where}: unknown setting "${k}" (${LIMIT_KEYS.join(", ")})`);
    const max = LIMIT_MAX[k as LimitKey];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > max) throw new Error(`${where}.${k} is a whole number from 0 (no limit) to ${max}`);
    out[k as LimitKey] = v;
  }
  return out;
}

/** `limits.perUser` as a whole: the three limits, adminsExempt, and users (at most 1,000 named people). */
export function perUserLimitsFrom(input: unknown, where = "limits.perUser"): PerUserLimits {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) throw new Error(`${where} must be a map`);
  const { adminsExempt, users, ...rest } = input as Record<string, unknown>;
  const out: PerUserLimits = questionLimitsFrom(rest, where);
  if (adminsExempt !== undefined) {
    if (typeof adminsExempt !== "boolean") throw new Error(`${where}.adminsExempt is true or false`);
    out.adminsExempt = adminsExempt;
  }
  if (users !== undefined) {
    if (!users || typeof users !== "object" || Array.isArray(users)) throw new Error(`${where}.users must be a map of user name to limits`);
    const entries = Object.entries(users as Record<string, unknown>);
    if (entries.length > 1000) throw new Error(`${where}.users names at most 1000 people`);
    out.users = Object.fromEntries(entries.map(([u, l]) => {
      if (!u.trim() || u.length > 200) throw new Error(`${where}.users: a user name is 1 to 200 characters`);
      return [u, questionLimitsFrom(l, `${where}.users.${u}`)];
    }));
  }
  return out;
}

// --- what a refusal says, in the chat's languages ------------------------------------------------

export const LIMIT_LANGUAGES = ["en", "fr", "hi", "pt"] as const;
export type LimitLanguage = (typeof LIMIT_LANGUAGES)[number];

/** The first of these that is a language the messages are in ("fr-FR" counts as fr; "auto" does not); else English. */
export function limitLanguage(...asked: unknown[]): LimitLanguage {
  for (const a of asked) {
    if (typeof a !== "string") continue;
    // An Accept-Language header: "fr-FR,fr;q=0.9,en;q=0.8", in the order given.
    for (const part of a.split(",")) {
      const code = part.split(";")[0]!.trim().toLowerCase().split("-")[0]!;
      if ((LIMIT_LANGUAGES as readonly string[]).includes(code)) return code as LimitLanguage;
    }
  }
  return "en";
}

type Words = { questions: (n: number) => string; wait: (secs: number) => string; text: Record<LimitKey, string> };
const plural = (one: string, many: string) => (n: number) => `${n} ${n === 1 ? one : many}`;
const waitIn = (s: (n: number) => string, m: (n: number) => string, h: (n: number) => string) => (secs: number) =>
  secs < 90 ? s(secs) : secs < 90 * 60 ? m(Math.round(secs / 60)) : h(Math.round(secs / 3600));

const WORDS: Record<LimitLanguage, Words> = {
  en: {
    questions: plural("question", "questions"),
    wait: waitIn(plural("second", "seconds"), plural("minute", "minutes"), plural("hour", "hours")),
    text: {
      perMinute: "You have asked {n} in the last minute, the most allowed per person. You can ask again in {wait}.",
      perHour: "You have asked {n} in the last hour, the most allowed per person. You can ask again in {wait}.",
      questionsPerDay: "You have asked {n} today, the most allowed per person in a day. You can ask again after midnight UTC, in {wait}.",
    },
  },
  fr: {
    questions: plural("question", "questions"),
    wait: waitIn(plural("seconde", "secondes"), plural("minute", "minutes"), plural("heure", "heures")),
    text: {
      perMinute: "Vous avez posé {n} au cours de la dernière minute, le maximum autorisé par personne. Vous pourrez en poser de nouveau dans {wait}.",
      perHour: "Vous avez posé {n} au cours de la dernière heure, le maximum autorisé par personne. Vous pourrez en poser de nouveau dans {wait}.",
      questionsPerDay: "Vous avez posé {n} aujourd'hui, le maximum autorisé par personne et par jour. Vous pourrez en poser de nouveau après minuit UTC, dans {wait}.",
    },
  },
  hi: {
    questions: (n) => `${n} सवाल`,
    wait: waitIn((n) => `${n} सेकंड`, (n) => `${n} मिनट`, (n) => `${n} घंटे`),
    text: {
      perMinute: "आपने पिछले एक मिनट में {n} पूछे हैं, जो एक व्यक्ति के लिए तय सीमा है। आप {wait} बाद फिर पूछ सकते हैं।",
      perHour: "आपने पिछले एक घंटे में {n} पूछे हैं, जो एक व्यक्ति के लिए तय सीमा है। आप {wait} बाद फिर पूछ सकते हैं।",
      questionsPerDay: "आपने आज {n} पूछे हैं, जो एक व्यक्ति के लिए एक दिन की तय सीमा है। आप UTC आधी रात के बाद, यानी {wait} बाद, फिर पूछ सकते हैं।",
    },
  },
  pt: {
    questions: plural("pergunta", "perguntas"),
    wait: waitIn(plural("segundo", "segundos"), plural("minuto", "minutos"), plural("hora", "horas")),
    text: {
      perMinute: "Fez {n} no último minuto, o máximo permitido por pessoa. Pode voltar a perguntar dentro de {wait}.",
      perHour: "Fez {n} na última hora, o máximo permitido por pessoa. Pode voltar a perguntar dentro de {wait}.",
      questionsPerDay: "Fez {n} hoje, o máximo permitido por pessoa por dia. Pode voltar a perguntar depois da meia-noite UTC, dentro de {wait}.",
    },
  },
};

/** What the person refused is told: which limit, and when they can ask again, in plain words in their language. */
export function limitMessage(r: Pick<LimitRefusal, "limit" | "max" | "retryAfterSeconds">, lang: LimitLanguage = "en"): string {
  const w = WORDS[lang] ?? WORDS.en;
  return w.text[r.limit].replace("{n}", w.questions(r.max)).replace("{wait}", w.wait(r.retryAfterSeconds));
}
