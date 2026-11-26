import { z } from "zod";

import { type Tool, defineTool } from "@lenspack/agent";

import type { OpenQuestion, QuestionNote } from "./questions";

// Clarifying intent at turn time (the `clarify` switch). When a question has more than one
// reasonable reading and neither the pack nor the admin's definitions settle it, the assistant
// either asks one short question with the readings as quick replies (when they lead to materially
// different answers), or answers with the most likely reading, says which, and logs the question.
// Either way the question lands in the open-questions log for an admin to settle once.

/** The prompt's one rule, kept short: it rides on every turn. */
export const CLARIFY_RULE =
  "- When a question has two or more reasonable readings that give materially different numbers (stock dispatched or doses given; calendar days or days with data) and the domain rules, definitions and hints above do not settle it, call clarify once. ask: true when the readings would change the answer a lot: then write one short question and stop, the readings are shown as buttons. Otherwise answer with the most likely reading, pass ask: false and its label as assumed, and say in the reply which reading you used. Never call it when the definitions already settle the question.";

/** What the client draws under the reply: the readings as buttons, and what each sends. */
export type QuickReplies = { question: string; prompt?: string; options: { label: string; text: string }[] };

/** "label: explanation | label: explanation" → readings. */
export function readingsFrom(text: string): { label: string; explanation: string; how?: string }[] {
  return text
    .split(/\s*\|\s*|\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const [label, ...rest] = p.split(/\s*[:—–]\s+|\s+-\s+/);
      const explanation = rest.join(": ").trim();
      return { label: label!.trim().slice(0, 120), explanation: explanation.slice(0, 600) };
    })
    .filter((r) => r.label)
    .slice(0, 4);
}

/** The words a quick reply sends as the next message. */
export const replyText = (label: string, explanation: string) => (explanation ? `${label}: ${explanation}` : label);

export function clarifyTool(o: { note: (n: QuestionNote) => OpenQuestion | null; question: string }): Tool {
  return defineTool({
    name: "clarify",
    description:
      "Log a question that has more than one reasonable reading, and either ask the user which they mean (ask: true; the readings become buttons) or say you are answering with one (ask: false, assumed: its label). Call at most once per turn, and never when the domain rules or definitions already settle the question.",
    inputSchema: z.object({
      pattern: z.string().describe('The question in general words, with no names, places or dates: "burn rate per facility", "current stock balance"'),
      readings: z.string().describe('Two to four readings, separated by " | ", each "short label: what it counts, with the measure and compute it uses". E.g. "Stock dispatched: average daily units dispatched from the facility store | Doses given: average daily doses given to children there"'),
      ask: z.union([z.boolean(), z.string()]).transform((v) => v === true || v === "true").describe("true to ask the user one short question; false to answer with the reading in assumed"),
      assumed: z.string().nullish().transform((v) => v ?? "").describe("With ask: false, the label of the reading you answer with"),
    }),
    async execute({ pattern, readings, ask, assumed }) {
      const rs = readingsFrom(readings);
      if (rs.length < 2) return { ok: false, error: 'Give at least two readings, separated by " | ", each "label: what it counts".' };
      if (!ask && !rs.some((r) => r.label.toLowerCase() === assumed.trim().toLowerCase())) return { ok: false, error: `assumed must be one of the reading labels: ${rs.map((r) => r.label).join(", ")}` };
      let logged: OpenQuestion | null = null;
      try {
        logged = o.note({ pattern, readings: rs, example: o.question, source: "turn", ...(ask ? {} : { assumed: rs.find((r) => r.label.toLowerCase() === assumed.trim().toLowerCase())!.label }) });
      } catch {
        // The log is for an admin; a full disk must not cost the user the answer.
      }
      const options = rs.map((r) => ({ label: r.label, text: replyText(r.label, r.explanation) }));
      if (ask)
        return {
          ok: true,
          asked: true,
          ...(logged ? { question: logged.id } : {}),
          quickReplies: { question: logged?.id ?? "", options } satisfies QuickReplies,
          next: "Now write one short question to the user, in their language, naming the readings in plain words. Make no other tool calls this turn: the readings are shown to them as buttons.",
        };
      return { ok: true, asked: false, ...(logged ? { question: logged.id } : {}), next: `Answer with the reading "${assumed}", and say in one short clause which reading you used.` };
    },
  });
}
