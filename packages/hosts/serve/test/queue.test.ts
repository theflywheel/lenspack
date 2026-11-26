// A model call turned away for a rate limit (429) or overload (529) is tried again with growing,
// jittered pauses, within the turn's wait limit; anything else fails at once.
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { retrying, withRetryWindow } from "../src/queue";

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const busy = (status: number, retryAfter?: string) =>
  new APICallError({ message: "busy", url: "mock:", requestBodyValues: {}, statusCode: status, responseHeaders: retryAfter ? { "retry-after": retryAfter } : {}, isRetryable: true });

/** A model that fails with these statuses first, then answers. */
function flaky(statuses: number[]) {
  let calls = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      calls++;
      const s = statuses.shift();
      if (s) throw busy(s);
      return { content: [{ type: "text", text: "ok" }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] };
    },
  });
  return { model, calls: () => calls };
}
const generate = (m: ReturnType<typeof retrying>) => (m as unknown as { doGenerate: (o: unknown) => Promise<{ content: { text: string }[] }> }).doGenerate({ prompt: [] });

describe("retrying a rate-limited model call", () => {
  it("tries again after 429 and 529 with doubling, jittered pauses", async () => {
    const f = flaky([429, 529, 429]);
    const slept: number[] = [];
    const m = retrying(f.model, { baseMs: 100, random: () => 1, sleep: async (ms) => void slept.push(ms) });
    const r = await generate(m);
    expect(r.content[0]!.text).toBe("ok");
    expect(f.calls()).toBe(4);
    expect(slept).toEqual([100, 200, 400]);
    // The jitter: between half and all of the pause.
    const half: number[] = [];
    await generate(retrying(flaky([429]).model, { baseMs: 100, random: () => 0, sleep: async (ms) => void half.push(ms) }));
    expect(half).toEqual([50]);
  });

  it("fails at once on other errors, and when the next pause would pass the turn's wait limit", async () => {
    const other = flaky([500]);
    await expect(generate(retrying(other.model, { sleep: async () => undefined }))).rejects.toMatchObject({ statusCode: 500 });
    expect(other.calls()).toBe(1);
    const slow = flaky([429, 429, 429, 429, 429, 429]);
    const slept: number[] = [];
    // A 1.5 s window: a pause of 1 s fits, the next of 2 s would pass it, so it gives up on the second failure.
    await expect(withRetryWindow(1500, () => generate(retrying(slow.model, { random: () => 1, sleep: async (ms) => void slept.push(ms) })))).rejects.toMatchObject({ statusCode: 429 });
    expect(slept).toEqual([1000]);
    expect(slow.calls()).toBe(2);
  });
});
