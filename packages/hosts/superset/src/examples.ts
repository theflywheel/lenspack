// The overlay's suggested questions (the chat's chips), in the languages the deployment wrote.
// Each example in the config is a question and the query that answers it; the question may be one
// string or a map by language ({en, fr, hi}), so every translation answers with the same query.
// The model sees only the English (or first) wording, as a few-shot example; the other languages' words go
// into the pack as the example's wordings, so asking one of them runs the same checked query.

export type ExampleQuestion = string | Record<string, string>;

const LANG = /^[a-z]{2,3}$/;

/** The words of a question in one language: that language, else English, else the first written. */
export function questionIn(q: unknown, lang = "en"): string | null {
  if (typeof q === "string") return q.trim() || null;
  if (!q || typeof q !== "object") return null;
  const m = q as Record<string, unknown>;
  const pick = [m[lang], m.en, ...Object.values(m)].find((v) => typeof v === "string" && v.trim());
  return typeof pick === "string" ? pick.trim() : null;
}

/** The config's examples as lists of questions by language. "en" is always there; a language missing from one example falls back to its English. */
export function examplesByLanguage(examples: unknown): Record<string, string[]> {
  const list = Array.isArray(examples) ? examples : [];
  const langs = new Set(["en"]);
  for (const e of list) {
    const q = (e as { question?: unknown })?.question;
    if (q && typeof q === "object") for (const k of Object.keys(q)) if (LANG.test(k)) langs.add(k);
  }
  const out: Record<string, string[]> = {};
  for (const lang of langs) out[lang] = list.map((e) => questionIn((e as { question?: unknown })?.question, lang)).filter((q): q is string => !!q);
  return out;
}

/** One language's list, for a client that asks for one (?lang=fr); English when it is not written. */
export function examplesFor(byLang: Record<string, string[]>, lang: string | null): string[] {
  const l = (lang ?? "en").slice(0, 2).toLowerCase();
  return byLang[l] ?? byLang.en ?? [];
}

/**
 * Examples with each question as one string, for the pack, and its other languages' words as wordings: a chip
 * clicked in French, Hindi or Portuguese is answered by the same checked query as the English one.
 */
export function examplesForPack<T extends { question?: unknown }>(examples: T[]): (Omit<T, "question"> & { question: string; wordings?: string[] })[] {
  return examples.map((e) => {
    const question = questionIn(e.question) ?? "";
    const all = e.question && typeof e.question === "object" ? Object.values(e.question as Record<string, unknown>) : [];
    const wordings = [...new Set(all.filter((v): v is string => typeof v === "string" && !!v.trim()).map((v) => v.trim()))].filter((v) => v !== question && v.length <= 200).slice(0, 10);
    return { ...e, question, ...(wordings.length ? { wordings } : {}) };
  });
}
