import { z } from "zod";

import { type Tool, defineTool } from "./tools";

// Clarifying intent at turn time (the deployment's `clarify` switch). When a question has more than one
// reasonable reading and neither the pack nor the deployment's definitions settle it, the assistant either
// asks one short question with the readings as quick replies (when they lead to materially different
// answers), or answers with the most likely reading, says which, and logs the question. Either way the
// question goes to an open-questions log (ClarifyLog) for someone to settle once. The reviewer's side of
// it is here too: the rule that has it check which reading a result used, and the note it returns.
// Nothing here knows about HTTP or any host: a host passes the log and reads the round's steps.

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

/** A question with more than one reading, as the turn (the clarify call, or the reviewer's reading note) hands it to whatever keeps the open questions. */
export type ClarifyNote = { pattern: string; readings: { label: string; explanation: string; how?: string }[]; example?: string; source: "turn" | "reviewer"; assumed?: string };

/** Where the turn logs a question with more than one reading: the id it was logged under, or null when it was not. */
export type ClarifyLog = (n: ClarifyNote) => { id: string } | null | Promise<{ id: string } | null>;

export function clarifyTool(o: { note: ClarifyLog; question: string }): Tool {
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
      let logged: { id: string } | null = null;
      try {
        logged = await o.note({ pattern, readings: rs, example: o.question, source: "turn", ...(ask ? {} : { assumed: rs.find((r) => r.label.toLowerCase() === assumed.trim().toLowerCase())!.label }) });
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

/** The quick reply a chat request names: { question, option }, both short strings. */
export function quickReplyOf(v: unknown): { question: string; option: string } | null {
  if (!v || typeof v !== "object") return null;
  const { question, option } = v as { question?: unknown; option?: unknown };
  return typeof question === "string" && typeof option === "string" && question.length <= 40 && option ? { question, option: option.slice(0, 120) } : null;
}

/** What a turn's record keeps of its clarify call. */
export type ClarifyRecord = { asked: boolean; pattern: string; question?: string; options?: string[]; assumed?: string };

/** A round's clarify call, if it made one that worked: the record for the turn and, when it asked, the quick replies. */
export function clarifyOf(steps: { toolCalls: { toolName: string; toolCallId: string; input?: unknown }[]; toolResults: { toolCallId: string; output?: unknown }[] }[]): { record: ClarifyRecord; quickReplies?: QuickReplies } | null {
  for (const s of steps)
    for (const c of s.toolCalls) {
      if (c.toolName !== "clarify") continue;
      const out = s.toolResults.find((r) => r.toolCallId === c.toolCallId)?.output as { ok?: boolean; asked?: boolean; question?: string; quickReplies?: QuickReplies } | undefined;
      if (!out?.ok) continue;
      const input = (c.input ?? {}) as { pattern?: string; assumed?: string; readings?: string };
      const options = out.quickReplies?.options.map((o) => o.label) ?? readingsFrom(String(input.readings ?? "")).map((r) => r.label);
      return { record: { asked: !!out.asked, pattern: String(input.pattern ?? "").slice(0, 200), ...(out.question ? { question: out.question } : {}), ...(options.length ? { options } : {}), ...(out.asked ? {} : { assumed: String(input.assumed ?? "").slice(0, 120) }) }, quickReplies: out.asked ? out.quickReplies : undefined };
    }
  return null;
}

export type ReadingIssue = { issue: "unstated" | "wrong"; question: string; readings: string[]; note: string };

/** Added to the reviewer's instructions when clarifying is on (the clarify switch). */
export const READING_RULE = `
Readings: when the instruction can reasonably be read in more than one way that gives materially different numbers (stock dispatched or doses given; calendar days or days with data; one side's records or the other's), check which reading AFTER uses. If a DOMAIN RULE or definition settles it and AFTER uses another, that is a material finding. If nothing settles it and no title or note says which reading was used, add a minor finding asking for the title to say so. In either case also add "reading": {"issue": "wrong" | "unstated", "question": "the question in general words, no names or dates", "readings": ["short label", "short label"], "note": "one sentence"} to your JSON. Leave "reading" out when there is only one reasonable reading.`;


const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** The reviewer's reading note, when it is whole: an issue, a question and two or more readings. */
export function readingOf(v: unknown): ReadingIssue | undefined {
  if (!v || typeof v !== "object") return undefined;
  const r = v as Record<string, unknown>;
  const issue = r.issue === "wrong" || r.issue === "unstated" ? r.issue : null;
  const question = text(r.question).slice(0, 200);
  const readings = (Array.isArray(r.readings) ? r.readings : []).map(text).filter(Boolean).map((x) => x.slice(0, 120)).slice(0, 6);
  return issue && question && readings.length >= 2 ? { issue, question, readings, note: text(r.note).slice(0, 300) } : undefined;
}
