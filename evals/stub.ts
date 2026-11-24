// A scripted model for testing the runner itself without spending: each
// question's `stub` lists, per turn, the tool calls to make and the final
// text. "{{rows}}" in the text renders the last tool result's rows, so a stub
// can answer from real data (and a deliberately wrong stub can not).
import { type Provider, buildProvider, registerLlmAdapter } from "@lenspack/serve";
import { MockLanguageModelV4 } from "ai/test";

import type { StubStep, Suite } from "./suite";
import { turnsOf } from "./suite";

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };

type PromptMessage = { role: string; content: unknown };

const textOf = (m: PromptMessage) => (typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((p: { text?: string }) => p.text ?? "").join("") : "");

function renderRows(out: unknown): string {
  const v = (out as { value?: unknown })?.value ?? out;
  const rows = (v as { rows?: { group?: string; value?: number | null }[] })?.rows ?? [];
  const fmt = (x: number | null | undefined) => (x === null || x === undefined ? "—" : !Number.isInteger(x) && Math.abs(x) <= 1.5 ? `${(x * 100).toFixed(2)}%` : x.toLocaleString("en-US"));
  return rows.map((r) => (r.group !== undefined && r.group !== "" ? `${r.group}: ${fmt(r.value)}` : fmt(r.value))).join("\n");
}

export function stubProvider(suite: Suite): Provider {
  const scripts = new Map<string, StubStep[]>();
  for (const q of suite.questions) turnsOf(q).forEach((t, i) => q.stub?.[i] && scripts.set(t, q.stub[i]!));
  let n = 0;
  const model = new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      const msgs = prompt as unknown as PromptMessage[];
      const lastUser = msgs.map((m, i) => ({ m, i })).filter((x) => x.m.role === "user").at(-1);
      const said = lastUser ? textOf(lastUser.m).trim() : "";
      const script = scripts.get(said) ?? [{ text: "I can't answer that." }];
      const after = msgs.slice((lastUser?.i ?? 0) + 1);
      const step = after.filter((m) => m.role === "tool").length;
      const lastTool = after.filter((m) => m.role === "tool").at(-1);
      const lastOut = Array.isArray(lastTool?.content) ? (lastTool!.content as { output?: unknown }[]).at(-1)?.output : undefined;
      const s = script[Math.min(step, script.length - 1)]!;
      return {
        stream: new ReadableStream({
          start(c) {
            if ("tool" in s && step < script.length - 1) {
              const id = `call${++n}`;
              c.enqueue({ type: "tool-call", toolCallId: id, toolName: s.tool, input: JSON.stringify(s.input) });
              c.enqueue({ type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage });
            } else {
              const text = "text" in s ? s.text.replace("{{rows}}", renderRows(lastOut)) : "Done.";
              c.enqueue({ type: "text-start", id: "t" });
              c.enqueue({ type: "text-delta", id: "t", delta: text });
              c.enqueue({ type: "text-end", id: "t" });
              c.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage });
            }
            c.close();
          },
        }),
      };
    },
  });
  registerLlmAdapter({ kind: "eval-stub", defaultBaseUrl: "stub:", build: () => model });
  return { ...buildProvider({ name: "stub", kind: "eval-stub", model: "stub" }), available: true };
}
