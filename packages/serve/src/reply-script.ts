import type { StreamTextTransform, TextStreamPart, ToolSet, UIMessage } from "ai";

import { type Script, scriptOf, scriptsOf } from "./speech";

// A reply never shows a script the user did not write in or choose. On "auto" the model picks the
// reply language itself, and once, after a Hindi turn, it opened an English answer with a line in
// Khmer. The prompt asks for the user's language; this makes it a rule, as the speech-to-text
// script check does for transcripts.

/** The text of each of the user's messages in a chat. */
export const userTexts = (messages: UIMessage[]) =>
  messages.filter((m) => m.role === "user").map((m) => m.parts.map((p) => ("text" in p ? (p as { text: string }).text : "")).join(" "));

/**
 * The scripts a reply may use: Latin always (the data's keys, names and codes are Latin), the
 * script of each message the user wrote in this chat, and those of the language they picked.
 */
export function replyScripts(texts: string[], picked?: string | null): Script[] {
  const allowed = new Set<Script>(["latin"]);
  for (const t of texts) {
    const s = scriptOf(t);
    if (s) allowed.add(s);
  }
  if (picked && picked !== "auto") for (const s of scriptsOf(picked)) allowed.add(s);
  return [...allowed];
}

/** Letters a line must have before it is judged; the rest of a kept line then streams as it comes. */
const JUDGE_AFTER = 12;
const letters = (s: string) => (s.match(/\p{L}/gu) ?? []).length;
/** What a reply says when every line of it was in a script the user did not use. */
export const UNREADABLE = "The answer came back in a language you did not use, so it is not shown. Please ask again.";

/**
 * A streamText transform that drops each reply line whose script is outside `allowed`. A line is
 * judged on its first letters (or whole, if shorter), so a reply still streams almost as it comes.
 * Blank lines before the first kept line are dropped with it, so a reply never opens on a gap. A
 * reply with nothing left says so in one line rather than ending blank.
 */
export function keepReplyScripts<TOOLS extends ToolSet>(allowed: Script[]): StreamTextTransform<TOOLS> {
  return () => {
    type State = { pending: string; mode: "judge" | "keep" | "drop"; shown: boolean; dropped: boolean };
    const states = new Map<string, State>();
    const fits = (line: string) => {
      const s = scriptOf(line);
      return s === null || allowed.includes(s);
    };
    // Runs the pending text through the line rule; `end` judges a last line however short.
    const step = (st: State, end: boolean) => {
      let out = "";
      while (st.pending) {
        const nl = st.pending.indexOf("\n");
        const line = nl === -1 ? st.pending : st.pending.slice(0, nl + 1);
        if (st.mode === "judge") {
          if (nl === -1 && !end && letters(line) < JUDGE_AFTER) break;
          st.mode = fits(line) && (st.shown || line.trim() !== "") ? "keep" : "drop";
        }
        if (st.mode === "keep") {
          out += line;
          st.shown = true;
        } else if (line.trim()) st.dropped = true;
        st.pending = st.pending.slice(line.length);
        if (nl !== -1) st.mode = "judge";
      }
      return out;
    };
    return new TransformStream<TextStreamPart<TOOLS>, TextStreamPart<TOOLS>>({
      transform(part, controller) {
        if (part.type === "text-delta") {
          const st = states.get(part.id) ?? { pending: "", mode: "judge", shown: false, dropped: false };
          states.set(part.id, st);
          st.pending += part.text;
          const text = step(st, false);
          if (text) controller.enqueue({ ...part, text });
          return;
        }
        if (part.type === "text-end") {
          const st = states.get(part.id);
          let text = st ? step(st, true) : "";
          if (st && !st.shown && st.dropped) text = UNREADABLE;
          if (text) controller.enqueue({ type: "text-delta", id: part.id, text });
        }
        controller.enqueue(part);
      },
    });
  };
}
