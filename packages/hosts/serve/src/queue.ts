// The turn gate's HTTP side (the gate itself is @lenspack/agent's TurnGate): a waiting chat is
// told its place before its stream starts, and a busy one gets a short stream that says so. And,
// while a turn holds its place, a model call the provider turns away for its rate limit (429) or
// for being overloaded (529) is tried again after a pause that doubles each time, with jitter, for
// as long as the turn may wait; only then does it fail.

import { AsyncLocalStorage } from "node:async_hooks";
import type { ServerResponse } from "node:http";

import { QueueBusy, type TurnPlace, type TurnGate } from "@lenspack/agent";
import { type LanguageModel, UI_MESSAGE_STREAM_HEADERS, wrapLanguageModel } from "ai";

/**
 * Waits for a place for a chat turn. Waiting, the chat is told its place (`data-queue` parts, sent
 * before the turn's own stream on the same response). Busy, the response is a short stream that
 * says so, and the result is null.
 */
export async function waitForTurn(res: ServerResponse, queue: TurnGate, o: { board: string; edit: boolean; name?: string }): Promise<TurnPlace | null> {
  const { name, ...place } = o;
  try {
    return await queue.acquire({
      ...place,
      onWait: (w) => {
        openStream(res);
        sendPart(res, { type: "data-queue", data: w, transient: true });
      },
    });
  } catch (e) {
    if (!(e instanceof QueueBusy)) throw e;
    openStream(res);
    // Not transient: the client keeps it with the (empty) answer, to show the suggestions beside it.
    sendPart(res, { type: "start" });
    sendPart(res, { type: "data-queue", data: { state: "full", why: e.why, retryAfterSeconds: e.retryAfterSeconds } });
    // In words too, for a client that knows no queue, and so the conversation's history has a reply here.
    sendPart(res, { type: "text-start", id: "busy" });
    sendPart(res, { type: "text-delta", id: "busy", delta: busyText(name) });
    sendPart(res, { type: "text-end", id: "busy" });
    sendPart(res, { type: "finish" });
    res.end("data: [DONE]\n\n");
    return null;
  }
}

/** What a busy chat says, naming the assistant (brand.name). */
export const busyText = (name = "Lenspack") => `${name} is too busy right now. Try again in a minute; common questions that were answered before are answered at once.`;
export const BUSY_TEXT = busyText();

/** Starts a UI message stream on the response, once. */
export function openStream(res: ServerResponse) {
  if (res.headersSent) return;
  res.writeHead(200, { ...UI_MESSAGE_STREAM_HEADERS });
  res.flushHeaders();
  res.socket?.setNoDelay(true);
}
const sendPart = (res: ServerResponse, part: unknown) => {
  if (!res.writableEnded) res.write(`data: ${JSON.stringify(part)}\n\n`);
};

// How long a model call may keep retrying a rate limit: the turn's wait limit, set per turn.
const retryWindow = new AsyncLocalStorage<{ waitMs: number }>();
/** Runs fn with model calls retrying a rate limit for up to waitMs each. */
export const withRetryWindow = <T>(waitMs: number, fn: () => T): T => retryWindow.run({ waitMs }, fn);

export type RetryOptions = { baseMs?: number; capMs?: number; defaultWaitMs?: number; sleep?: (ms: number) => Promise<void>; random?: () => number; onRetry?: (status: number, delayMs: number) => void };

const statusOf = (e: unknown) => (e && typeof e === "object" ? ((e as { statusCode?: unknown }).statusCode as number | undefined) : undefined);
const retryAfterMs = (e: unknown) => {
  const h = e && typeof e === "object" ? (e as { responseHeaders?: Record<string, string> }).responseHeaders : undefined;
  const v = h?.["retry-after"] ?? h?.["Retry-After"];
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? n * 1000 : 0;
};

/**
 * A model whose calls, turned away for a rate limit (429) or overload (529), are tried again: after
 * about 1 s, 2 s, 4 s … (at most capMs, each between half and all of it, or the provider's
 * retry-after if longer), until the call's window (the turn's wait limit) would be passed.
 */
export function retrying(model: Exclude<LanguageModel, string>, o: RetryOptions = {}): Exclude<LanguageModel, string> {
  const baseMs = o.baseMs ?? 1000;
  const capMs = o.capMs ?? 15_000;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = o.random ?? Math.random;
  const attempt = async <T>(call: () => PromiseLike<T>): Promise<T> => {
    const until = Date.now() + (retryWindow.getStore()?.waitMs ?? o.defaultWaitMs ?? 20_000);
    for (let n = 0; ; n++) {
      try {
        return await call();
      } catch (e) {
        const status = statusOf(e);
        if (status !== 429 && status !== 529) throw e;
        const backoff = Math.min(capMs, baseMs * 2 ** n) * (0.5 + random() * 0.5);
        const delay = Math.max(backoff, Math.min(retryAfterMs(e), capMs * 2));
        if (Date.now() + delay > until) throw e;
        o.onRetry?.(status, delay);
        await sleep(delay);
      }
    }
  };
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v4",
      wrapGenerate: ({ doGenerate }) => attempt(doGenerate),
      wrapStream: ({ doStream }) => attempt(doStream),
    },
  });
}

