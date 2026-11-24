// @vitest-environment jsdom
// The panel's reply after a reviewed turn: the reviewer's findings are data for tools, not text for
// the person, and a line the server adds after the model's answer (a minor finding in plain words)
// is part of the same reply.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

type Chat = { mount: (root: HTMLElement, opts: Record<string, unknown>) => { send: (t: string) => Promise<void> } };

describe("the panel after a reviewed turn", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
    document.body.innerHTML = "";
  });

  it("shows no reviewer note, and keeps the added sentence in the reply and the history", async () => {
    const enc = new TextEncoder();
    const ev = (e: unknown) => `data: ${JSON.stringify(e)}\n\n`;
    const frames = [
      ev({ type: "tool-input-available", toolCallId: "c1", toolName: "add_widget", input: { id: "hf_burn", kind: "table", title: "Burn" } }),
      ev({ type: "tool-output-available", toolCallId: "c1", output: { applied: true, version: 2 } }),
      ev({ type: "text-delta", id: "t", delta: "I added the burn rate." }),
      ev({ type: "data-review", data: { round: 1, satisfied: false, findings: [{ severity: "minor", widget: "hf_burn", problem: "hf_burn: stock_received not requested", forUser: "x" }], userNote: "The table also shows stock received.", note: "" } }),
      ev({ type: "text-delta", id: "note-1", delta: "The table also shows stock received." }),
      ev({ type: "finish" }),
      "data: [DONE]\n\n",
    ];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: { method?: string }) => {
      if (init?.method !== "POST") return { ok: true, status: 200, json: async () => ({ board: { version: 1 } }) };
      let i = 0;
      return { ok: true, status: 200, body: { getReader: () => ({ read: async () => (i < frames.length ? { value: enc.encode(frames[i++]), done: false } : { value: undefined, done: true }) }) } };
    }));
    delete (window as unknown as Record<string, unknown>).LenspackChat;
    new Function(readFileSync(join(__dirname, "..", "web", "chat.js"), "utf8"))();
    const root = document.createElement("div");
    document.body.append(root);
    const chat = (window as unknown as { LenspackChat: Chat }).LenspackChat.mount(root, { api: "http://x/lenspack", pack: "p", board: "superset-12", speech: { enabled: false } });
    await chat.send("add the burn rate");
    expect(root.textContent).not.toMatch(/Reviewer|hf_burn: |stock_received/);
    const saved = JSON.parse(sessionStorage.getItem("lenspack-chat:superset-12")!);
    expect(saved.messages.at(-1).parts[0].text).toBe("I added the burn rate.\n\nThe table also shows stock received.");
  });
});
