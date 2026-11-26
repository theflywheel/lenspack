// The serve host's side of answer reuse. The reuse layer itself (@lenspack/agent's reuseLayer) knows
// no host: this file gives it what a host has. A small model to call, through this host's providers
// and metering. The stream a saved answer goes out as. And, for refreshes, the turn a saved answer
// is run in: its pack's host, its board, and the access it was made under. The admin routes are in
// routes.ts. See docs/features/saved-answers.md.

import { randomUUID } from "node:crypto";

import { type Entry, type Served, type SmallModel, type TurnFor, ctxOf } from "@lenspack/agent";
import { type ModelMessage, type UIMessageChunk, generateText } from "ai";

import type { Host } from "../app";
import { type Provider, effortFor, shapeCall } from "../llm";
import { type CallRecord, type MeterScope, type UsageSink, withMeter } from "../metering";
import { PROMPT_VERSION } from "../prompt";

export { cacheRoutes } from "./routes";
export { PROMPT_VERSION };

/** The cheap model for the router and rewrite steps: the router role's provider, else a Haiku, else the turn's own model. */
export function smallModel(providers: Provider[], o: { router?: string; builder?: string; meter: MeterScope }): SmallModel | null {
  const up = (p?: Provider) => (p && p.available !== false ? p : undefined);
  const p = up(providers.find((x) => x.name === o.router)) ?? up(providers.find((x) => /haiku/i.test(x.model))) ?? up(providers.find((x) => x.name === o.builder));
  if (!p) return null;
  return {
    name: p.name,
    async complete(system, user, maxOutputTokens) {
      const effort = p.efforts ? effortFor(p, p.efforts.levels.includes("low") ? "low" : null) : undefined;
      const messages: ModelMessage[] = [{ role: "user", content: user }];
      const r = await withMeter({ ...o.meter, role: "reuse", effort }, () => generateText({ model: p.languageModel, ...shapeCall(p, { system: [system], messages, effort }), maxOutputTokens }));
      return r.text;
    },
  };
}

/** A saved answer as UI message stream parts: its queries as steps with their results, the reply, and the note (usage and finish are the caller's). */
export function savedChunks(s: Served): UIMessageChunk[] {
  return [
    { type: "start" },
    ...(s.calls.length
      ? ([
          { type: "start-step" },
          ...s.calls.flatMap((c, i) => [
            { type: "tool-input-available", toolCallId: `saved-${i}`, toolName: c.tool, input: c.input },
            { type: "tool-output-available", toolCallId: `saved-${i}`, output: c.output },
          ]),
          { type: "finish-step" },
        ] as UIMessageChunk[])
      : []),
    { type: "start-step" },
    { type: "text-start", id: "saved-reply" },
    { type: "text-delta", id: "saved-reply", delta: s.reply },
    { type: "text-end", id: "saved-reply" },
    { type: "finish-step" },
    { type: "data-reuse", data: s.note },
  ];
}

/** Builds the turn a saved answer is refreshed in, as the person it was made for: their access, nothing wider. */
export function prewarmTurns(o: { hosts: Host[]; providers: Provider[]; router?: string; rules?: () => unknown; promptVersion?: () => string; sinks: UsageSink[] }): TurnFor {
  return async (e: Entry) => {
    const h = o.hosts.find((x) => x.name === e.pack);
    // An entry kept before access was recorded is not refreshed: its scope is not known well enough to run as it.
    if (!h || !e.access) return null;
    const board = await h.store.get(e.board);
    if (!board) return null;
    const calls: CallRecord[] = [];
    const meter: MeterScope = { user: "prewarm", pack: h.name, board: e.board, turn: randomUUID(), sinks: o.sinks, collect: calls };
    const builder = o.providers.find((p) => p.name === e.model)?.name ?? e.model;
    return {
      turn: {
        packName: h.name,
        pack: h.pack,
        board: e.board,
        config: board.config,
        ctx: ctxOf(e.access, h.ctx.now),
        connector: h.connector,
        store: h.store,
        proposals: h.proposals,
        question: e.question,
        firstTurn: true,
        picked: e.replyLang === "auto" ? undefined : e.replyLang,
        rules: o.rules?.(),
        promptVersion: o.promptVersion?.() ?? String(PROMPT_VERSION),
        readOnly: "a scheduled refresh does not change boards",
        builder,
        small: smallModel(o.providers, { router: o.router, builder, meter }),
      },
      spent: () => ({ usd: calls.reduce((s, c) => s + (c.usd ?? 0), 0), calls: calls.length }),
    };
  };
}
