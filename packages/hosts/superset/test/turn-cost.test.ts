// @vitest-environment jsdom
// What a chat turn cost, where people see it: a line under each reply in the panel (hidden by the turnCost
// switch), a running total in the chat menu, and the settings page's recent turns and totals read from the
// audit log (the durable record).
import { mkdtempSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { rotatingAudit } from "@lenspack/serve";
import { FEATURES, features } from "@lenspack/serve";
import { settingsStore } from "@lenspack/serve";
import { turnRow, turnsReport } from "@lenspack/serve";

const web = (f: string) => readFileSync(join(__dirname, "..", "web", f), "utf8");

const turnLine = (at: string, user: string, costUsd: number, extra: Record<string, unknown> = {}) => ({
  at,
  user,
  board: "superset-12",
  action: "chat-turn",
  outcome: "ok" as const,
  detail: JSON.stringify({ builder: "sonnet", costUsd, tokens: { in: 1000, out: 50, cacheRead: 0, cacheWrite: 0 }, models: ["claude-sonnet-5-5"], sttUsd: 0, unpriced: 0, ...extra }),
});

describe("turnsReport", () => {
  const now = new Date("2026-11-24T10:00:00Z");

  it("totals today (UTC) and the last 7 days, newest turns first, and skips everything that isn't a turn", () => {
    const events = [
      turnLine("2026-11-24T09:00:00Z", "ana", 0.002, { sttUsd: 0.0003, models: ["claude-sonnet-5-5", "stt"] }),
      { at: "2026-11-24T08:59:00Z", user: "ana", action: "chat-edit", outcome: "ok" as const, detail: "add_widget → v2" },
      turnLine("2026-11-24T01:00:00Z", "ben", 0.001),
      turnLine("2026-11-20T12:00:00Z", "ana", 0.01),
      turnLine("2026-11-10T12:00:00Z", "ana", 5),
    ];
    const r = turnsReport(events, now);
    expect(r.today).toEqual({ turns: 2, costUsd: 0.003, sttUsd: 0.0003, tokensIn: 2000, tokensOut: 100, unpriced: 0 });
    expect(r.week).toMatchObject({ turns: 3, costUsd: 0.013 });
    expect(r.recent.map((t) => t.user)).toEqual(["ana", "ben", "ana"]);
    expect(r.recent[0]).toEqual({ at: "2026-11-24T09:00:00Z", user: "ana", board: "superset-12", models: ["claude-sonnet-5-5", "stt"], tokens: { in: 1000, out: 50 }, costUsd: 0.002, sttUsd: 0.0003, unpriced: 0 });
    expect(r.estimate).toMatch(/estimates from list prices/);
    expect(turnsReport(events, now, 1).recent).toHaveLength(1);
  });

  it("reads turns logged before the summary fields existed from their cost", () => {
    const old = {
      at: "2026-11-23T10:00:00Z",
      user: "ana",
      action: "chat-turn",
      outcome: "ok" as const,
      detail: JSON.stringify({ builder: "sonnet", cost: { total: { usd: 0.004, inputTokens: 900, outputTokens: 40, unpriced: 0 }, models: [{ role: "build", model: "claude-sonnet-5-5", usd: 0.004 }] } }),
    };
    expect(turnRow(old)).toMatchObject({ costUsd: 0.004, tokens: { in: 900, out: 40 }, models: ["claude-sonnet-5-5"], sttUsd: 0 });
    expect(turnRow({ ...old, detail: "not json" })).toBeNull();
  });
});

describe("the audit log across months", () => {
  it("since() reads the current file and the archived months it needs, newest first", () => {
    const dir = mkdtempSync(join(tmpdir(), "lp-turns-"));
    writeFileSync(join(dir, "audit-2026-10.jsonl"), `${JSON.stringify(turnLine("2026-10-30T10:00:00Z", "old", 1))}\n${JSON.stringify(turnLine("2026-10-01T10:00:00Z", "older", 1))}\n`);
    writeFileSync(join(dir, "audit-2026-09.jsonl"), `${JSON.stringify(turnLine("2026-09-30T10:00:00Z", "oldest", 1))}\n`);
    writeFileSync(join(dir, "audit.jsonl"), `${JSON.stringify(turnLine("2026-11-02T10:00:00Z", "new", 1))}\n`);
    const log = rotatingAudit(dir, { now: () => new Date("2026-11-03T00:00:00Z"), retentionDays: 3650 });
    expect(log.since(new Date("2026-10-27T00:00:00Z")).map((e) => e.user)).toEqual(["new", "old"]);
  });
});

describe("the turnCost switch", () => {
  it("is on by default and can be turned off like the others", () => {
    expect(FEATURES).toContain("turnCost");
    const f = features({ settings: settingsStore(mkdtempSync(join(tmpdir(), "lp-tc-"))) });
    expect(f.on("turnCost")).toBe(true);
    f.update({ turnCost: false });
    expect(f.on("turnCost")).toBe(false);
  });
});

type Chat = { mount: (root: HTMLElement, opts: Record<string, unknown>) => { send: (t: string) => Promise<void> } };

describe("the panel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
    document.body.innerHTML = "";
  });

  function mount(features?: Record<string, boolean>) {
    const enc = new TextEncoder();
    const summary = { costUsd: 0.0042, tokens: { in: 12345, out: 678, cacheRead: 0, cacheWrite: 0 }, models: ["claude-sonnet-5-5", "voxtral"], sttUsd: 0.0002, unpriced: 0 };
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string }) => {
      if (init?.method !== "POST") return { ok: true, status: 200, json: async () => ({ board: { version: 1 } }) };
      const frames = [
        'data: {"type":"text-delta","id":"t","delta":"Coverage is high."}\n\n',
        `data: ${JSON.stringify({ type: "data-usage", data: { total: {}, models: [], summary } })}\n\n`,
        'data: {"type":"finish"}\n\n',
        "data: [DONE]\n\n",
      ];
      let i = 0;
      return { ok: true, status: 200, body: { getReader: () => ({ read: async () => (i < frames.length ? { value: enc.encode(frames[i++]), done: false } : { value: undefined, done: true }) }) } };
    }));
    delete (window as unknown as Record<string, unknown>).LenspackChat;
    new Function(web("chat.js"))();
    const root = document.createElement("div");
    document.body.append(root);
    const chat = (window as unknown as { LenspackChat: Chat }).LenspackChat.mount(root, { api: "http://x/lenspack", pack: "p", board: "superset-12", speech: { enabled: false }, ...(features ? { features } : {}) });
    return { root, chat };
  }

  it("shows the turn's cost under the reply, details on opening it, and the session total in the menu", async () => {
    const { root, chat } = mount();
    await chat.send("How is coverage?");
    const line = root.querySelector(".lpc-cost") as HTMLDetailsElement;
    expect(line.querySelector("summary")!.textContent).toBe("≈ $0.0042");
    expect(line.querySelector("summary")!.title).toMatch(/estimated cost .* list prices/i);
    expect(line.textContent).toContain("claude-sonnet-5-5, voxtral: 12,345 tokens in, 678 out");
    expect(line.textContent).toContain("speech to text, $0.0002");
    expect(root.querySelector(".lpc")!.classList.contains("lpc-nocost")).toBe(false);
    await chat.send("And by ward?");
    expect(root.querySelector(".lpc-total")!.textContent).toBe("This session: ≈ $0.0084 for 2 answers (estimate from list prices)");
    // Kept with the conversation, so a reload shows it again.
    const saved = JSON.parse(sessionStorage.getItem("lenspack-chat:superset-12")!);
    expect(saved.messages[1].metadata.cost.costUsd).toBe(0.0042);
    expect(saved.spent).toEqual({ usd: 0.0084, turns: 2 });
  });

  it("hides the line and the total when the switch is off", async () => {
    const { root, chat } = mount({ turnCost: false });
    await chat.send("How is coverage?");
    expect(root.querySelector(".lpc")!.classList.contains("lpc-nocost")).toBe(true);
    expect(root.querySelector(".lpc-total")).toBeNull();
  });
});
