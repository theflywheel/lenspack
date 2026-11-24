import { type LanguageModel, generateText } from "ai";

import { type Provider, shapeCall } from "./llm";
import { WIDGET_LIMITS } from "./prompt";

// The adversarial reviewer. It never sees pixels; it sees the instruction,
// the board before and after (the same summary the builder works from), and
// the receipt of versions the board actually gained. Its job is to find
// every way the result falls short, so the builder can fix it — and to say
// so honestly when nothing does.
//
// Each finding is material or minor. Material: the board would now mislead
// whoever reads it (wrong or double-counted numbers, a title that claims what
// the query does not do, a required filter missing, the wrong widget
// changed). The chat gives such a change one fix round and saves nothing
// that is still wrong after it. Minor: anything else; the change is saved
// and the reply mentions it.

export type Finding = {
  severity: "material" | "minor";
  /** The widget it is about, when there is one. */
  widget?: string;
  /** What is wrong, for the assistant that fixes it. */
  problem: string;
  /** The same in plain words for the person who asked: no widget ids, no mention of a review. */
  forUser: string;
};

export type Review = {
  /** No findings. */
  satisfied: boolean;
  findings: Finding[];
  /** One plain sentence for the person who asked, about the minor findings; empty when there are none. */
  userNote: string;
  note: string;
  /** The reviewer produced no usable verdict; never treat as a failure. */
  unavailable?: boolean;
  raw?: string;
};

export const REVIEW_PROMPT = `You are a strict, adversarial reviewer of a dashboard edit made by another assistant.
You will be given: the PACK (what each measure and dimension means) and its DOMAIN RULES, the user's instruction, the board BEFORE, the board AFTER, a RECEIPT listing the versions the board actually gained (this is the ground truth of what changed — the assistant's own claims are not), and REFUSALS: edits the system itself rejected during the turn, with the reason. A request the system refused cannot be satisfied as asked; the assistant is right to offer the nearest answerable alternative or to say so.

Find every way the result fails the instruction:
- a requested widget that does not exist in AFTER, or has the wrong kind (kpi vs bar vs line vs pie), measure, dimension, split, or time window;
- a requested rename, filter, removal, move, resize or packing that the RECEIPT does not show;
- placement intent not met ("across the top" but not on row 1; "full width" but not full width (12/12));
- anything added that was not asked for;
- a widget that breaks a DOMAIN RULE.
Judge only the widgets the instruction names or the RECEIPT shows changed, and ask for no change to any other; a change nobody asked for is wrong, to be undone.
Judge widgets by their query description in AFTER (measure, dimension, grain, split, window such as "last 10w"), never by their title or id — a title saying "last 10 weeks" with no window in the query is a defect.
Do not invent requirements the instruction did not state. If everything requested is present, say so.
If the instruction asked for something the pack cannot express (the assistant could only refuse, or offered the nearest answerable alternative and said so), and nothing wrong was added, that is satisfied — an honest refusal is the correct outcome, not a failure.
If the instruction was a question about the data (not an edit) and the assistant answered it, that is satisfied.
If the instruction asked to reset, undo or restore an earlier version and the RECEIPT shows a restore ("restored vN") to the right version, that is satisfied: the whole board changing back is the requested change, not unasked-for edits.
${WIDGET_LIMITS} A request for something widgets cannot do is satisfied when the assistant says so.

Give each finding a severity:
- "material" when a changed widget would mislead whoever reads the board: numbers that are wrong or counted more than once (a query whose grouping or measure counts the same record twice); a title or label that claims something the query does not do (a level, filter, window or measure it lacks); a filter the instruction or a DOMAIN RULE requires that the query lacks; a change to, or removal of, a widget the instruction did not mean.
- "minor" for everything else: an extra column, split or widget nobody asked for, wording or style, placement not quite as asked, something requested that is still missing.

Reply with JSON only: {"findings": [{"severity": "material" | "minor", "widget": "the widget id, or empty", "problem": "what is wrong, precisely enough for the assistant to fix it", "forUser": "the same in one plain sentence for the person who asked, in the language of the instruction, with no widget ids and no mention of a review"}], "userNote": "one plain sentence for the person who asked about the minor findings only, in the language of the instruction, with no widget ids and no mention of a review; empty when there are none", "note": "one sentence"}. No findings means the edit is right: {"findings": [], "userNote": "", "note": "…"}.`;

/** `reviewer` is a model, or a provider, whose adapter may shape the call (a cache breakpoint on the fixed prompt). */
export async function reviewTurn(
  reviewer: LanguageModel | Pick<Provider, "languageModel" | "prepare">,
  input: { catalogue: string; instructions?: string; instruction: string; before: string; after: string; receipt: string; refusals?: string[] },
  timeoutMs = 60_000,
): Promise<Review> {
  const provider = typeof reviewer === "object" && "languageModel" in reviewer ? reviewer : { languageModel: reviewer };
  const prompt = `PACK:\n${input.catalogue}\n\nDOMAIN RULES:\n${input.instructions?.trim() || "(none)"}\n\nINSTRUCTION:\n${input.instruction}\n\nBEFORE:\n${input.before}\n\nAFTER:\n${input.after}\n\nRECEIPT:\n${input.receipt || "(no versions gained)"}\n\nREFUSALS:\n${input.refusals?.length ? input.refusals.map((r) => `- ${r}`).join("\n") : "(none)"}`;
  const out = await generateText({
    model: provider.languageModel,
    ...shapeCall(provider, { system: [REVIEW_PROMPT], messages: [{ role: "user", content: prompt }] }),
    // Reasoning models spend output tokens on hidden reasoning before the
    // JSON, and this prompt carries a whole board; leave generous room.
    maxOutputTokens: 4000,
    abortSignal: AbortSignal.timeout(timeoutMs),
  });
  const raw = out.text.trim();
  const m = /\{[\s\S]*\}/.exec(raw);
  try {
    const p = JSON.parse(m ? m[0] : raw) as { findings?: unknown; satisfied?: unknown; userNote?: unknown; note?: unknown };
    if (!Array.isArray(p.findings) && p.satisfied !== true) throw new Error("no verdict");
    const findings = (Array.isArray(p.findings) ? p.findings : []).flatMap(findingOf);
    return { satisfied: findings.length === 0, findings, userNote: text(p.userNote), note: text(p.note), raw };
  } catch {
    return { ...unavailable(raw ? "reviewer returned no verdict" : "reviewer returned nothing"), raw };
  }
}

/** A review that could not be had: the change stands, as it would with no reviewer. */
export const unavailable = (note: string): Review => ({ satisfied: true, unavailable: true, findings: [], userNote: "", note });

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** A finding as the reviewer wrote it; a severity it did not name is minor, so an unclear finding never undoes a change. */
function findingOf(v: unknown): Finding[] {
  if (!v || typeof v !== "object") return [];
  const f = v as Record<string, unknown>;
  const problem = text(f.problem);
  if (!problem) return [];
  const widget = text(f.widget);
  return [{ severity: f.severity === "material" ? "material" : "minor", ...(widget ? { widget } : {}), problem, forUser: text(f.forUser) }];
}

export const materialFindings = (r: Review) => r.findings.filter((f) => f.severity === "material");

/** What the builder is told in its one round to correct a change the reviewer found wrong. */
export function fixPrompt(findings: Finding[]) {
  return [
    "Before your changes were saved, a check found these problems with them. Nothing from this turn is saved yet. Correct exactly these points with tool calls: change the widget so it is right, or remove it; do not leave the wrong version on the board. Then call get_board.",
    'Then reply to the user in one or two plain sentences, in the language they wrote in: say what was wrong with your earlier change and what you did about it (for example: "I removed the table because its numbers counted each transfer twice; here is the corrected one."), describing the board only as get_board shows it. Do not mention a check or a reviewer, and do not name widget ids.',
    ...findings.map((f) => `- ${f.widget ? `${f.widget}: ` : ""}${f.problem}`),
  ].join("\n");
}

/** Sent, tools off, when a change is still wrong after its fix round and nothing from the turn was saved. */
export const ROLLBACK_PROMPT =
  "None of your changes in this turn were saved: even after one correction they would have misled whoever reads the board, so the board is exactly as it was before this message. In one or two plain sentences, in the language the user wrote in, tell them you could not make a correct version, so you left the board unchanged, and say why in plain words. Do not mention a check or a reviewer, and do not name widget ids. The problem:";

/** The plain line a turn ends with when nothing from it was saved and no model could say so. */
export function rolledBackLine(findings: Finding[]) {
  const why = findings.map((f) => f.forUser).filter(Boolean).join(" ");
  return `I couldn't make a correct version, so I left the board unchanged.${why ? ` ${why}` : ""}`;
}

/** The refusals in a turn's tool results, as short lines for the reviewer. */
export function refusalsFrom(steps: { toolResults: { toolName?: string; output?: unknown }[] }[]): string[] {
  const out: string[] = [];
  for (const st of steps)
    for (const r of st.toolResults ?? []) {
      const v = r.output as { applied?: boolean; ok?: boolean; error?: string } | undefined;
      if ((v?.applied === false || v?.ok === false) && v?.error) out.push(`${r.toolName ?? "tool"}: ${v.error.slice(0, 200)}`);
    }
  return out.slice(0, 8);
}
