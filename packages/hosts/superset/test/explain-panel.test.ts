// @vitest-environment jsdom
// "How this was worked out" in the Superset panel: one expander under the answer, collapsed, a
// button with aria-expanded; each call's words, its SQL in a block with a copy button, and the
// first rows with how many there were. It comes back after a reload, in the panel's language,
// and the explain switch hides it.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

type Chat = { mount: (root: HTMLElement, opts: Record<string, unknown>) => { send: (t: string) => Promise<void> } };

const EXPLAIN = {
  sql: true,
  selections: [{ field: "area", label: "Area", value: "North", applied: false }],
  calls: [
    {
      tool: "query",
      description: "Visits (count of rows in visit, the pack's approved measure “visits”), from 1 to 7 September 2026, grouped by area, top 20 by value.",
      statements: [{ language: "sql", text: `SELECT area, COUNT(*) AS visits FROM visits WHERE visited_at >= $1 GROUP BY area ORDER BY visits DESC LIMIT 20 ${"-- long ".repeat(40)}`, params: ["'2026-09-01T00:00:00.000Z'"] }],
      columns: [{ key: "group", label: "Area" }, { key: "value", label: "Visits" }, { key: "share", label: "Share", format: "percent" }],
      rows: Array.from({ length: 20 }, (_, i) => [`Area ${i + 1}`, 1000 - i * 10, 0.05]),
      total: 45,
    },
    { tool: "query", description: "A saved one.", columns: [{ key: "value", label: "Visits" }], rows: [[12]], total: 1, saved: { asOf: "2026-09-01T06:00:00Z" } },
  ],
};

const enc = new TextEncoder();
const ev = (e: unknown) => `data: ${JSON.stringify(e)}\n\n`;
function stubFetch() {
  const frames = [ev({ type: "text-delta", id: "t", delta: "Area 1 had the most visits." }), ev({ type: "data-answer-card", data: EXPLAIN }), ev({ type: "data-usage", data: { summary: { costUsd: 0.001, models: ["m"], tokens: { in: 10, out: 2 } } } }), ev({ type: "finish" }), "data: [DONE]\n\n"];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
    if (init?.method !== "POST") return { ok: true, status: 200, json: async () => ({ board: { version: 1 } }) };
    let i = 0;
    return { ok: true, status: 200, body: { getReader: () => ({ read: async () => (i < frames.length ? { value: enc.encode(frames[i++]), done: false } : { value: undefined, done: true }) }) } };
  }));
}
function mount(opts: Record<string, unknown> = {}) {
  delete (window as unknown as Record<string, unknown>).LenspackChat;
  new Function(readFileSync(join(__dirname, "..", "web", "chat.js"), "utf8"))();
  document.body.innerHTML = "";
  const root = document.createElement("div");
  document.body.append(root);
  const chat = (window as unknown as { LenspackChat: Chat }).LenspackChat.mount(root, { api: "http://x/lenspack", pack: "p", board: "superset-3", speech: { enabled: false }, ...opts });
  return { root, chat };
}

describe("how this was worked out, in the panel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
    localStorage.clear();
    document.body.innerHTML = "";
  });

  it("one collapsed expander under the answer; opening it shows the words, the SQL and the rows", async () => {
    stubFetch();
    const { root, chat } = mount();
    await chat.send("which area had the most visits?");
    const boxes = root.querySelectorAll(".lpc-ex");
    expect(boxes).toHaveLength(1);
    // Under the answer, above its cost line.
    expect(boxes[0]!.previousElementSibling!.classList.contains("lpc-bot")).toBe(true);
    expect(boxes[0]!.nextElementSibling!.classList.contains("lpc-cost")).toBe(true);
    const btn = boxes[0]!.querySelector("button.lpc-ex-btn") as HTMLButtonElement;
    const body = boxes[0]!.querySelector(".lpc-ex-body") as HTMLElement;
    expect(btn.textContent).toBe("How this was worked out");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(btn.getAttribute("aria-controls")).toBe(body.id);
    expect(body.hidden).toBe(true);
    btn.click();
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(body.hidden).toBe(false);
    // One level: the calls sit directly in the body; nothing in it opens further.
    expect(body.querySelectorAll(".lpc-ex-call")).toHaveLength(2);
    expect(body.querySelectorAll("[aria-expanded]")).toHaveLength(0);
    expect(body.textContent).toContain("grouped by area, top 20 by value");
    const pre = body.querySelector("pre code")!;
    expect(pre.textContent).toMatch(/^SELECT area, COUNT\(\*\)/);
    expect(body.querySelector(".lpc-ex-bar")!.textContent).toContain("SQL that ran");
    expect(body.querySelector(".lpc-ex-copy")!.textContent).toBe("Copy");
    expect(body.querySelector(".lpc-ex-params")!.textContent).toBe("Values: 1 = '2026-09-01T00:00:00.000Z'");
    const table = body.querySelector("table")!;
    expect(Array.from(table.querySelectorAll("th"), (th) => th.textContent)).toEqual(["Area", "Visits", "Share"]);
    expect(table.querySelectorAll("tbody tr")).toHaveLength(20);
    expect(table.querySelector("caption")!.textContent).toBe("Showing 20 of 45 rows");
    expect(table.querySelector("tbody td:nth-child(3)")!.textContent).toBe("5%");
    expect(body.textContent).toContain("Saved answer · numbers read at");
    // The SQL and the table scroll inside their own boxes.
    const css = document.getElementById("lpc-css")!.textContent!;
    expect(css).toMatch(/\.lpc-ex pre\{[^}]*overflow:auto[^}]*white-space:pre/);
    expect(css).toMatch(/\.lpc-ex-tw\{overflow-x:auto/);
    expect(css).toMatch(/\[data-lp-theme=dark\] \.lpc-ex-btn/);
  });

  it("comes back after a reload, in the panel's language, without being sent back to the server", async () => {
    stubFetch();
    const first = mount();
    await first.chat.send("which area had the most visits?");
    localStorage.setItem("lenspack-voice", JSON.stringify({ lang: "fr", langPage: "en" }));
    const { root, chat } = mount();
    expect(root.querySelectorAll(".lpc-ex")).toHaveLength(1);
    expect(root.querySelector(".lpc-ex-btn")!.textContent).toBe("Comment ce résultat a été obtenu");
    // The next question's request carries the conversation, not the explanation.
    await chat.send("and last week?");
    const posts = (fetch as unknown as { mock: { calls: [string, { method?: string; body?: string }][] } }).mock.calls.filter(([, i]) => i?.method === "POST");
    expect(posts.at(-1)![1].body).not.toContain("SELECT area");
  });

  it("sends the viewer's dashboard filters with the question, and the card names them", async () => {
    stubFetch();
    const { root, chat } = mount({ selections: () => ({ area: "North" }) });
    await chat.send("which area had the most visits?");
    const posts = (fetch as unknown as { mock: { calls: [string, { method?: string; body?: string }][] } }).mock.calls.filter(([, i]) => i?.method === "POST");
    expect(JSON.parse(posts.at(-1)![1].body!).selections).toEqual({ area: "North" });
    expect(root.querySelector(".lpc-ex-filters")!.textContent).toBe("Dashboard filters when you asked: Area = North (not applied to these numbers)");
  });

  it("is hidden when the explain switch is off", async () => {
    stubFetch();
    const { root, chat } = mount({ features: { explain: false } });
    await chat.send("which area had the most visits?");
    expect(root.querySelectorAll(".lpc-ex")).toHaveLength(0);
  });
});
