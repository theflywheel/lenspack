// @vitest-environment jsdom
// The panel's side of usage telemetry: the device and network classes on each chat request, thumbs under an
// answer in the panel's language, the reason list on a thumbs down, and the helper other parts call.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

type Chat = { mount: (root: HTMLElement, opts: Record<string, unknown>) => { send: (t: string) => Promise<void> } };

describe("the panel's telemetry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
    localStorage.clear();
    document.body.innerHTML = "";
  });

  function mount(opts: Record<string, unknown> = {}) {
    const enc = new TextEncoder();
    const ev = (e: unknown) => `data: ${JSON.stringify(e)}\n\n`;
    const frames = [ev({ type: "data-turn", data: { turnId: "turn-1", sessionId: "s_1" } }), ev({ type: "text-delta", id: "t", delta: "There are 12." }), ev({ type: "finish" }), "data: [DONE]\n\n"];
    const posts: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        if (init?.method !== "POST") return { ok: true, status: 200, json: async () => ({ board: { version: 1 } }) };
        posts.push({ url, body: JSON.parse(init.body ?? "{}") });
        if (!url.endsWith("/chat")) return { ok: true, status: 202, json: async () => ({ ok: true }) };
        let i = 0;
        return { ok: true, status: 200, headers: new Headers({ "x-lenspack-turn": "turn-1" }), body: { getReader: () => ({ read: async () => (i < frames.length ? { value: enc.encode(frames[i++]), done: false } : { value: undefined, done: true }) }) } };
      }),
    );
    delete (window as unknown as Record<string, unknown>).LenspackChat;
    new Function(readFileSync(join(__dirname, "..", "web", "chat.js"), "utf8"))();
    const root = document.createElement("div");
    document.body.append(root);
    const chat = (window as unknown as { LenspackChat: Chat }).LenspackChat.mount(root, { api: "http://x/lenspack", pack: "p", board: "superset-12", speech: { enabled: false }, ...opts });
    return { root, chat, posts };
  }

  it("sends the device classes with the question, and puts thumbs under the answer", async () => {
    const { root, chat, posts } = mount();
    await chat.send("how many visits?");
    expect(posts[0]!.body.client).toMatchObject({ device: "desktop", viewport: expect.stringMatching(/^(narrow|medium|wide)$/) });
    expect(JSON.stringify(posts[0]!.body)).not.toContain("Mozilla");
    const [up, down] = Array.from(root.querySelectorAll(".lpc-fb > button")) as HTMLButtonElement[];
    expect(up!.getAttribute("aria-label")).toBe("Helpful");
    expect(down!.getAttribute("aria-label")).toBe("Not helpful");
    up!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(posts.at(-1)).toEqual({ url: "http://x/lenspack/api/_telemetry", body: { type: "feedback", turnId: "turn-1", rating: "up" } });
    expect(up!.getAttribute("aria-pressed")).toBe("true");
    // The choice is kept with the answer.
    expect(JSON.parse(sessionStorage.getItem("lenspack-chat:superset-12")!).messages.at(-1).metadata).toMatchObject({ turnId: "turn-1", rating: "up" });
  });

  it("asks what was wrong on a thumbs down, in the panel's language", async () => {
    localStorage.setItem("lenspack-voice", JSON.stringify({ lang: "pt" }));
    const { root, chat, posts } = mount();
    await chat.send("quantas visitas?");
    const down = root.querySelectorAll(".lpc-fb > button")[1] as HTMLButtonElement;
    expect(down.getAttribute("aria-label")).toBe("Não foi útil");
    down.click();
    const form = root.querySelector(".lpc-fbform") as HTMLFormElement;
    expect(form.querySelector("legend")!.textContent).toBe("O que estava errado?");
    expect(Array.from(form.querySelectorAll("label")).map((l) => l.textContent)).toEqual(["Número errado", "Local ou item errado", "Pergunta mal compreendida", "Muito lento", "Outro"]);
    (form.querySelector('input[value="wrong-number"]') as HTMLInputElement).checked = true;
    (form.querySelector("textarea") as HTMLTextAreaElement).value = "o total está errado";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(posts.slice(-2).map((p) => p.body)).toEqual([
      { type: "feedback", turnId: "turn-1", rating: "down" },
      { type: "feedback", turnId: "turn-1", rating: "down", reason: "wrong-number", comment: "o total está errado" },
    ]);
  });

  it("lets other parts of the page report an event about the latest answer", async () => {
    const { chat, posts } = mount();
    await chat.send("how many visits?");
    await (window as unknown as { lenspackTelemetry: { event: (t: string, d: unknown) => Promise<boolean> } }).lenspackTelemetry.event("explain-opened", { step: 2 });
    expect(posts.at(-1)!.body).toEqual({ type: "explain-opened", turnId: "turn-1", data: { step: 2 } });
  });

  it("hides the thumbs and posts nothing when telemetry is switched off", async () => {
    const { root, chat, posts } = mount({ features: { telemetry: false }, language: { default: "auto" } });
    await chat.send("how many visits?");
    expect(root.querySelector(".lpc")!.classList.contains("lpc-notel")).toBe(true);
    await (window as unknown as { lenspackTelemetry: { event: (t: string, d: unknown) => Promise<boolean> } }).lenspackTelemetry.event("explain-opened", {});
    expect(posts.filter((p) => p.url.endsWith("/_telemetry"))).toEqual([]);
  });
});
