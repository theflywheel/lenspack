import { type LanguageModel, generateText } from "ai";

// The adversarial reviewer. It never sees pixels; it sees the instruction,
// the board before and after (the same summary the builder works from), and
// the receipt of versions the board actually gained. Its job is to find
// every way the result falls short, so the builder can fix it — and to say
// so honestly when nothing does.

export type Review = {
  satisfied: boolean;
  missing: string[];
  wrong: string[];
  note: string;
  /** The reviewer produced no usable verdict; never treat as a failure. */
  unavailable?: boolean;
  raw?: string;
};

export const REVIEW_PROMPT = `You are a strict, adversarial reviewer of a dashboard edit made by another assistant.
You will be given: the user's instruction, the board BEFORE, the board AFTER, a RECEIPT listing the versions the board actually gained (this is the ground truth of what changed — the assistant's own claims are not), and REFUSALS: edits the system itself rejected during the turn, with the reason. A request the system refused cannot be satisfied as asked; the assistant is right to offer the nearest answerable alternative or to say so.

Find every way the result fails the instruction:
- a requested widget that does not exist in AFTER, or has the wrong kind (kpi vs bar vs line vs pie), measure, dimension, split, or time window;
- a requested rename, filter, removal, move, resize or packing that the RECEIPT does not show;
- placement intent not met ("across the top" but not on row 1; "full width" but not 12/12 wide);
- anything added that was not asked for.
Judge widgets by their query description in AFTER (measure, dimension, grain, split, window such as "last 10w"), never by their title or id — a title saying "last 10 weeks" with no window in the query is a defect.
Do not invent requirements the instruction did not state. If everything requested is present, say so.
If the instruction asked for something the pack cannot express (the assistant could only refuse, or offered the nearest answerable alternative and said so), and nothing wrong was added, that is satisfied — an honest refusal is the correct outcome, not a failure.
If the instruction was a question about the data (not an edit) and the assistant answered it, that is satisfied.

Reply with JSON only: {"satisfied": boolean, "missing": ["what was asked and is absent, naming the widget kind and keys"], "wrong": ["what exists but differs from the request, with the widget id"], "note": "one sentence"}.`;

export async function reviewTurn(model: LanguageModel, input: { instruction: string; before: string; after: string; receipt: string; refusals?: string[] }, timeoutMs = 60_000): Promise<Review> {
  const out = await generateText({
    model,
    system: REVIEW_PROMPT,
    prompt: `INSTRUCTION:\n${input.instruction}\n\nBEFORE:\n${input.before}\n\nAFTER:\n${input.after}\n\nRECEIPT:\n${input.receipt || "(no versions gained)"}\n\nREFUSALS:\n${input.refusals?.length ? input.refusals.map((r) => `- ${r}`).join("\n") : "(none)"}`,
    // Reasoning models spend output tokens before the JSON; leave room.
    maxOutputTokens: 2000,
    abortSignal: AbortSignal.timeout(timeoutMs),
  });
  const raw = out.text.trim();
  const m = /\{[\s\S]*\}/.exec(raw);
  try {
    const p = JSON.parse(m ? m[0] : raw) as Partial<Review>;
    if (typeof p.satisfied !== "boolean") throw new Error("no verdict");
    return { satisfied: p.satisfied, missing: p.missing ?? [], wrong: p.wrong ?? [], note: p.note ?? "", raw };
  } catch {
    return { satisfied: true, unavailable: true, missing: [], wrong: [], note: raw ? "reviewer returned no verdict" : "reviewer returned nothing", raw };
  }
}

/** What the builder is told when the reviewer is not satisfied. */
export function healingPrompt(review: Review) {
  return [
    "A reviewer checked the board against the request and found it incomplete. Fix exactly these points with tool calls, then call get_board and report only what it shows:",
    ...review.missing.map((m) => `- missing: ${m}`),
    ...review.wrong.map((w) => `- wrong: ${w}`),
  ].join("\n");
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
