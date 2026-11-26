// The cheap router: one small model call for a question the store has no exact or slotted match
// for. It sees the question and the few saved questions most like it (by words), and says which
// one, if any, would answer it as asked, with the place or time the new question names. A match
// runs that entry's plan; no match goes to the full assistant. It writes no reply and runs no tool.

import type { Entry } from "./store";

export const ROUTER_PROMPT = `You match a dashboard question to saved questions whose answers can be reused.
A saved question matches only if its answer, recomputed on fresh data, answers the new question exactly as asked: the same measure, the same grouping, the same comparison, the same filters except the slots listed for it, and the same time grain.
Slots are the parts that may differ: a value of a dimension (a place, a facility) or a time period ("today", "last week"). Give each slot's value exactly as the new question writes it.
The new question may be in another language than the saved one; that is fine.
If no saved question matches exactly, answer with match null. A near miss is no match.
Reply with JSON only: {"match": "<id>" or null, "slots": {"<slot name>": "<value>"}}`;

/** A slot's name for the router: the dimension of a value, or "time". */
export const slotName = (s: NonNullable<Entry["slots"]>[number]) => (s.kind === "time" ? "time" : s.dimension);

export function routerMessage(question: string, candidates: Entry[]): string {
  const lines = candidates.map((e) => {
    const slots = e.slots?.length ? `; slots: ${e.slots.map((s) => `${slotName(s)} (now "${s.kind === "time" ? s.text : s.value}")`).join(", ")}` : "";
    return `- id: ${e.id}; question: ${JSON.stringify(e.question)}${slots}`;
  });
  return `New question: ${JSON.stringify(question)}\n\nSaved questions:\n${lines.join("\n")}`;
}

export type Route = { match: string | null; slots: Record<string, string> };

/** The router's answer, or null when it is not the JSON asked for. */
export function parseRoute(text: string, ids: string[]): Route | null {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  try {
    const v = JSON.parse(m[0]) as { match?: unknown; slots?: unknown };
    const match = typeof v.match === "string" && ids.includes(v.match) ? v.match : null;
    const slots: Record<string, string> = {};
    if (v.slots && typeof v.slots === "object" && !Array.isArray(v.slots)) for (const [k, x] of Object.entries(v.slots)) if (typeof x === "string" && x.trim()) slots[k] = x.trim();
    return { match, slots };
  } catch {
    return null;
  }
}

export const REWRITE_PROMPT = `You update a reply about dashboard data with fresh numbers. You are given the question, the earlier reply, the results the earlier reply was written from, and the fresh results.
Write the reply again from the fresh results: the same language (unless told otherwise), the same length, style and structure. Change the numbers, and any claim the fresh results no longer support (which group leads, rises or falls, the dates). Add nothing else. Reply with the new reply only.`;

export function rewriteMessage(o: { question: string; reply: string; before: unknown[]; after: unknown[]; language?: string }): string {
  const cut = (v: unknown) => JSON.stringify(v).slice(0, 6000);
  return [
    `Question: ${o.question}`,
    o.language ? `Write the reply in this language: ${o.language}.` : "",
    `Earlier reply:\n${o.reply}`,
    `Earlier results:\n${cut(o.before)}`,
    `Fresh results:\n${cut(o.after)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
