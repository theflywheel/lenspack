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
You will be given: the user's instruction, the board BEFORE, the board AFTER, and a RECEIPT listing the versions the board actually gained (this is the ground truth of what changed — the assistant's own claims are not).

Find every way the result fails the instruction:
- a requested widget that does not exist in AFTER, or has the wrong kind (kpi vs bar vs line vs pie), measure, dimension, split, or time window;
- a requested rename, filter, removal, move, resize or packing that the RECEIPT does not show;
- placement intent not met ("across the top" but not on row 1; "full width" but not 12/12 wide);
- anything added that was not asked for.
Do not invent requirements the instruction did not state. If everything requested is present, say so.

Reply with JSON only: {"satisfied": boolean, "missing": ["what was asked and is absent, naming the widget kind and keys"], "wrong": ["what exists but differs from the request, with the widget id"], "note": "one sentence"}.`;

export async function reviewTurn(model: LanguageModel, input: { instruction: string; before: string; after: string; receipt: string }, timeoutMs = 60_000): Promise<Review> {
  const out = await generateText({
    model,
    system: REVIEW_PROMPT,
    prompt: `INSTRUCTION:\n${input.instruction}\n\nBEFORE:\n${input.before}\n\nAFTER:\n${input.after}\n\nRECEIPT:\n${input.receipt || "(no versions gained)"}`,
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
