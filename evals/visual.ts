import { type LanguageModel, generateText } from "ai";

// A vision model looks at the rendered board and scores it against the
// instruction. It cannot see the config; it sees what a person sees — which
// is the point. The rubric is fixed so scores are comparable across models.

export type VisualVerdict = {
  ok: boolean;
  score: number; // 0..1
  issues: string[];
  seen: string;
  raw: string;
};

export const VISUAL_RUBRIC = `You are checking a screenshot of a dashboard after a user gave an instruction.
Judge only what is visible. Check:
1. The requested widget(s) exist with the right kind (KPI = a big number; bar/line/area/pie = a drawn chart with visible bars/lines/slices and axis labels).
2. No widget shows an error message, "Loading", or an empty chart area.
3. No overlapping or clipped cards; titles readable.
4. Position and size intent ("at the top", "full width", "quarter width") is respected.
5. If a title change was requested, the page heading shows it.
Reply with JSON only: {"ok": boolean, "score": number 0..1, "issues": string[], "seen": "one sentence describing the board"}.`;

export async function judgeScreenshot(model: LanguageModel, png: Uint8Array, instruction: string, timeoutMs = 90_000): Promise<VisualVerdict> {
  const out = await generateText({
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: `${VISUAL_RUBRIC}\n\nInstruction the user gave: "${instruction}"` },
          { type: "image", image: png, mediaType: "image/png" },
        ],
      },
    ],
    maxOutputTokens: 400,
    abortSignal: AbortSignal.timeout(timeoutMs),
  });
  const raw = out.text.trim();
  const m = /\{[\s\S]*\}/.exec(raw);
  try {
    const parsed = JSON.parse(m ? m[0] : raw) as Partial<VisualVerdict>;
    return { ok: !!parsed.ok, score: Number(parsed.score ?? (parsed.ok ? 1 : 0)), issues: parsed.issues ?? [], seen: parsed.seen ?? "", raw };
  } catch {
    return { ok: false, score: 0, issues: ["judge did not return JSON"], seen: "", raw };
  }
}
