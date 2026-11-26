// Questions as the answer store compares them. Two wordings that differ only in case, punctuation,
// spacing or a number written as a word ("two" for 2) are the same question; the language is kept,
// so a French question never matches an English one here (the router may still pair them).

// Number words in the chat's languages, after accents are stripped. Articles ("un", "um", "a") are
// left alone: "un rapport" is not "1 rapport".
const NUMBER_WORDS: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  eleven: "11", twelve: "12", fifteen: "15", twenty: "20", thirty: "30", fifty: "50", hundred: "100",
  deux: "2", trois: "3", quatre: "4", cinq: "5", sept: "7", huit: "8", neuf: "9", dix: "10", onze: "11", douze: "12", quinze: "15", vingt: "20", trente: "30", cinquante: "50", cent: "100",
  dois: "2", duas: "2", tres: "3", quatro: "4", cinco: "5", seis: "6", sete: "7", oito: "8", nove: "9", dez: "10", doze: "12", vinte: "20", trinta: "30", cinquenta: "50", cem: "100",
  "एक": "1", "दो": "2", "तीन": "3", "चार": "4", "पांच": "5", "पाँच": "5", "छह": "6", "छः": "6", "सात": "7", "आठ": "8", "नौ": "9", "दस": "10", "बीस": "20", "तीस": "30", "पचास": "50", "सौ": "100",
};

const DEVANAGARI_DIGITS = "०१२३४५६७८९";

/** Latin accents off ("dernière" → "derniere"); Devanagari vowel signs are marks too, so only Latin ones go. */
export function stripLatinAccents(s: string): string {
  return s.normalize("NFD").replace(/([A-Za-z])[̀-ͯ]+/g, "$1").normalize("NFC");
}

/** A question as the store compares it: lower case, no punctuation, single spaces, digits for number words. */
export function normalise(q: string): string {
  const s = stripLatinAccents(q.normalize("NFC").toLowerCase())
    .replace(/[०-९]/g, (d) => String(DEVANAGARI_DIGITS.indexOf(d)))
    // A decimal or a thousands separator between digits is part of the number; anything else that is not a letter, mark, digit or % is a space.
    .replace(/(\d)[.,](?=\d)/g, "$1\u0001")
    .replace(/[^\p{L}\p{M}\p{N}%\u0001\s]/gu, " ")
    .replace(/\u0001/g, ".");
  return s
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => NUMBER_WORDS[w] ?? w)
    .join(" ");
}

export const tokens = (norm: string) => norm.split(" ").filter(Boolean);

const trigrams = (s: string) => {
  const t = ` ${s} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3));
  return out;
};
const jaccard = <T>(a: Set<T>, b: Set<T>) => {
  if (!a.size && !b.size) return 1;
  let both = 0;
  for (const x of a) if (b.has(x)) both++;
  return both / (a.size + b.size - both);
};

/** How alike two normalised questions are, 0 to 1: half whole words, half letter triples (so "ward"/"wards" still count). */
export function similarity(a: string, b: string): number {
  return 0.5 * jaccard(new Set(tokens(a)), new Set(tokens(b))) + 0.5 * jaccard(trigrams(a), trigrams(b));
}

// A few words per language that only that language uses often, for a question typed with the language menu on Auto.
const MARKERS: Record<string, string[]> = {
  en: ["the", "what", "which", "how", "many", "by", "is", "are", "of", "today", "show", "per", "last", "week", "much", "behind"],
  fr: ["le", "la", "les", "des", "du", "quel", "quels", "quelle", "combien", "par", "est", "sont", "aujourd", "hui", "semaine", "derniere", "dernier", "mois"],
  pt: ["o", "os", "as", "do", "da", "dos", "das", "qual", "quais", "quantos", "quantas", "por", "hoje", "semana", "passada", "mes", "estao", "esta"],
};

/** The question's language: the one picked in the menu, else Hindi for Devanagari, else the European language whose common words it uses most. */
export function guessLanguage(q: string, picked?: string | null): string {
  if (picked && picked !== "auto") return picked.slice(0, 2).toLowerCase();
  if (/[ऀ-ॿ]/.test(q)) return "hi";
  const words = tokens(normalise(q));
  let best = "en";
  let score = 0;
  for (const [lang, list] of Object.entries(MARKERS)) {
    const n = words.filter((w) => list.includes(w)).length;
    if (n > score) [best, score] = [lang, n];
  }
  return best;
}

// Words that lean on an earlier turn: "and for last week?", "show it as a line", "et pour hier ?". A question with one
// of them, after the first turn of a conversation, is not answered from the store, and its answer is not kept.
const LEANS = [
  "it", "its", "that", "those", "these", "them", "same", "also", "too", "instead", "again", "above", "previous", "else",
  "ca", "cela", "celui", "celle", "ceux", "aussi", "meme", "plutot", "encore", "pareil", "precedent",
  "isso", "isto", "esse", "essa", "esses", "essas", "tambem", "mesmo", "mesma", "ainda", "anterior",
  "वही", "यह", "इसे", "उसे", "इसको", "उसको", "भी", "फिर",
];
const OPENERS = ["and", "but", "what about", "how about", "now", "et", "mais", "e", "mas", "agora", "और", "तो"];

/** Whether a question stands on its own: always the first of a conversation; later, only without words that refer back. */
export function standalone(question: string, first: boolean): boolean {
  if (first) return true;
  const norm = normalise(question);
  const words = tokens(norm);
  if (words.length < 3) return false;
  if (OPENERS.some((o) => norm === o || norm.startsWith(`${o} `))) return false;
  return !words.some((w) => LEANS.includes(w));
}

/** A short stable id for a string (FNV-1a, 52 bits, base 36). */
export function shortHash(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ c, 2246822519) >>> 0;
  }
  return ((h2 & 0xfffff) * 0x100000000 + h1).toString(36);
}

/** JSON with object keys in order, so two equal values always print the same. */
export function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x instanceof Set ? [...x].sort() : x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
}
