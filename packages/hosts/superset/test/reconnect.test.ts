// @vitest-environment jsdom
// When Lenspack restarts: the overlay's button stays (muted, "reconnecting"), retries back off, a signed-out 401
// stops it, and the chat shows a banner while offline. When an answer is cut off, the chat first finds out whether the
// turn changed the dashboard (the turn record under its key, else the board's version) and says so; Retry checks again
// and sends the same key, so nothing is made twice.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const web = (f: string) => readFileSync(join(__dirname, "..", "web", f), "utf8");

type Reply = { status: number; body?: unknown } | "network";
let server: (url: string) => Reply;
const calls: string[] = [];

function respond(url: string): Promise<unknown> {
  calls.push(url);
  const r = server(url);
  if (r === "network") return Promise.reject(new TypeError("Failed to fetch"));
  return Promise.resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body ?? {} });
}
const up: (url: string) => Reply = (url) =>
  url.includes("/_superset/bind") ? { status: 200, body: { board: "superset-6", title: "Board" } }
  : url.includes("/_superset/info") ? { status: 200, body: { pack: "p", examples: [], panel: "float" } }
  : { status: 200, body: { ok: true } };
const down: (url: string) => Reply = () => ({ status: 502, body: { error: "The assistant's server is not reachable" } });

function startOverlay() {
  Object.defineProperty(document, "currentScript", { configurable: true, value: { src: "http://x/lenspack/overlay.js" } });
  new Function(web("overlay.js"))();
}
const btn = () => document.querySelector(".lpo-btn") as HTMLButtonElement;
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
  calls.length = 0;
  document.body.innerHTML = "";
  sessionStorage.clear();
  delete (window as unknown as Record<string, unknown>).__lenspackOverlay;
  window.history.pushState({}, "", "/superset/dashboard/6/");
  vi.stubGlobal("fetch", vi.fn((url: string) => respond(String(url))));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("overlay while Lenspack restarts", () => {
  it("shows a muted reconnecting button when the first bind fails, and the normal one once Lenspack answers", async () => {
    server = down;
    startOverlay();
    await tick(50);
    expect(btn().style.display).toBe("inline-flex");
    expect(btn().classList.contains("lpo-wait")).toBe(true);
    expect(btn().textContent).toContain("Reconnecting");
    server = up;
    await tick(1100);
    expect(btn().classList.contains("lpo-wait")).toBe(false);
    expect(btn().textContent).toContain("Ask Lenspack");
  });

  it("backs off 1, 2, 4… s up to 30 s instead of hammering", async () => {
    server = () => "network";
    startOverlay();
    await tick(120_000);
    const binds = calls.filter((u) => u.includes("/_superset/bind")).length;
    // t = 0, 1, 3, 7, 15, 31, 61, 91: eight tries in two minutes.
    expect(binds).toBeGreaterThanOrEqual(7);
    expect(binds).toBeLessThanOrEqual(9);
  });

  it("notices a restart after binding (health check) and recovers without a reload", async () => {
    server = up;
    startOverlay();
    await tick(50);
    expect(btn().textContent).toContain("Ask Lenspack");
    server = down;
    await tick(5000);
    expect(btn().classList.contains("lpo-wait")).toBe(true);
    expect(btn().style.display).toBe("inline-flex");
    server = up;
    await tick(4000);
    expect(btn().classList.contains("lpo-wait")).toBe(false);
  });

  it("stops when signed out (401): no button, no retrying", async () => {
    server = () => ({ status: 401, body: { error: "sign in to Superset first" } });
    startOverlay();
    await tick(50);
    expect(btn().style.display).toBe("none");
    const n = calls.length;
    await tick(60_000);
    expect(calls.length).toBe(n);
  });

  it("does not loop on another 4xx (no access to this dashboard)", async () => {
    server = (url) => (url.includes("/_superset/bind") ? { status: 403, body: { error: "no access" } } : up(url));
    startOverlay();
    await tick(60_000);
    expect(calls.filter((u) => u.includes("/_superset/bind")).length).toBe(1);
    expect(btn().style.display).not.toBe("inline-flex");
  });

  it("hides the button and panel when the next dashboard is not one the assistant is on (dashboardScope: listed)", async () => {
    server = (url) => (url.includes("/_superset/bind?dashboard=8") ? { status: 403, body: { error: "The assistant isn't turned on for this dashboard.", code: "out-of-scope" } } : up(url));
    startOverlay();
    await tick(50);
    expect(btn().style.display).toBe("inline-flex");
    // Superset moves to another dashboard without a page load.
    window.history.pushState({}, "", "/superset/dashboard/8/");
    await tick(1000);
    expect(calls.some((u) => u.includes("/_superset/bind?dashboard=8"))).toBe(true);
    expect(btn().style.display).toBe("none");
    // And back: the button returns.
    window.history.pushState({}, "", "/superset/dashboard/6/");
    await tick(1000);
    expect(btn().style.display).toBe("inline-flex");
  });
});

type Chat = { mount: (root: HTMLElement, opts: Record<string, unknown>) => { send: (t: string) => Promise<void>; setOffline: (on: boolean) => void } };

describe("chat while Lenspack restarts", () => {
  function mountChat(onUnreachable = () => {}) {
    delete (window as unknown as Record<string, unknown>).LenspackChat;
    new Function(web("chat.js"))();
    const root = document.createElement("div");
    document.body.append(root);
    const chat = (window as unknown as { LenspackChat: Chat }).LenspackChat.mount(root, { api: "http://x/lenspack", pack: "p", board: "superset-6", speech: { enabled: false }, onUnreachable });
    return { root, chat };
  }

  it("mounts with suggested questions (they read the offline state on the first render)", () => {
    vi.useRealTimers();
    delete (window as unknown as Record<string, unknown>).LenspackChat;
    new Function(web("chat.js"))();
    const root = document.createElement("div");
    document.body.append(root);
    const chat = (window as unknown as { LenspackChat: Chat }).LenspackChat.mount(root, { api: "http://x/lenspack", pack: "p", board: "superset-7", examples: { en: ["How many?", "Add a chart"] }, speech: { enabled: false } });
    const chips = root.querySelectorAll<HTMLButtonElement>(".lpc-chip");
    expect(chips).toHaveLength(2);
    expect(chips[0]!.disabled).toBe(false);
    chat.setOffline(true);
    expect(chips[0]!.disabled).toBe(true);
  });

  it("shows a banner and disables input while offline, and re-enables it when back", () => {
    vi.useRealTimers();
    const { root, chat } = mountChat();
    const bar = root.querySelector(".lpc-down") as HTMLElement;
    const input = root.querySelector(".lpc-in") as HTMLTextAreaElement;
    expect(bar.hidden).toBe(true);
    chat.setOffline(true);
    expect(bar.hidden).toBe(false);
    expect(bar.textContent).toContain("restarting");
    expect(input.disabled).toBe(true);
    expect((root.querySelector(".lpc-go") as HTMLButtonElement).disabled).toBe(true);
    chat.setOffline(false);
    expect(bar.hidden).toBe(true);
    expect(input.disabled).toBe(false);
  });

  it("says the connection was lost when an answer is cut off, and Retry asks again", async () => {
    vi.useRealTimers();
    const enc = new TextEncoder();
    let cut = true;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string }) => {
      if (init?.method !== "POST") return { ok: true, status: 200, json: async () => ({ board: { version: 1 } }) };
      const frames = cut
        ? ['data: {"type":"text-delta","id":"t","delta":"Half an ans"}\n\n']
        : ['data: {"type":"text-delta","id":"t","delta":"Done."}\n\n', 'data: {"type":"finish"}\n\n', "data: [DONE]\n\n"];
      let i = 0;
      return { ok: true, status: 200, body: { getReader: () => ({ read: async () => (i < frames.length ? { value: enc.encode(frames[i++]), done: false } : { value: undefined, done: true }) }) } };
    }));
    const lost = vi.fn();
    const { root, chat } = mountChat(lost);
    await chat.send("How many?");
    const note = root.querySelector(".lpc-note.bad") as HTMLElement;
    expect(note.textContent).toContain("connection to Lenspack was lost");
    expect(lost).toHaveBeenCalled();
    const retry = note.querySelector("button") as HTMLButtonElement;
    expect(retry.textContent).toBe("Retry");
    chat.setOffline(true);
    expect(retry.disabled).toBe(true);
    chat.setOffline(false);
    cut = false;
    retry.click();
    await vi.waitFor(() => expect(root.querySelector(".lpc-note.bad")).toBeNull());
    await vi.waitFor(() => expect(root.textContent).toContain("Done."));
    expect(root.querySelectorAll(".lpc-user")).toHaveLength(1);
  });

  // The board API as the chat sees it after a cut-off answer: the board's version, the turn record under a key, the
  // versions list. posts: each chat request's body.
  function boardApi(o: { version: () => number; turn: () => unknown; chat: () => string[]; versions?: unknown[] }) {
    const enc = new TextEncoder();
    const posts: { turnKey?: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === "POST") {
        posts.push(JSON.parse(init.body ?? "{}"));
        const frames = o.chat();
        let i = 0;
        return { ok: true, status: 200, body: { getReader: () => ({ read: async () => (i < frames.length ? { value: enc.encode(frames[i++]), done: false } : { value: undefined, done: true }) }) } };
      }
      if (url.includes("/turn?key=")) {
        const turn = o.turn();
        return { ok: !!turn, status: turn ? 200 : 404, json: async () => ({ version: o.version(), ...(turn ? { turn } : { error: "no such turn" }) }) };
      }
      if (url.endsWith("/versions")) return { ok: true, status: 200, json: async () => o.versions ?? [] };
      return { ok: true, status: 200, json: async () => ({ board: { version: o.version() } }) };
    }));
    return posts;
  }
  const CUT = ['data: {"type":"tool-input-available","toolCallId":"c1","toolName":"remove_widget","input":{"id":"w95"}}\n\n'];
  const REMOVED = { state: "done", from: 2, to: 3, changes: { added: [], removed: ["Stock by product"], changed: [], other: false }, reply: "I removed “Stock by product”." };
  function mountWith(onChanged: () => void) {
    delete (window as unknown as Record<string, unknown>).LenspackChat;
    new Function(web("chat.js"))();
    const root = document.createElement("div");
    document.body.append(root);
    const chat = (window as unknown as { LenspackChat: Chat }).LenspackChat.mount(root, { api: "http://x/lenspack", pack: "p", board: "superset-9", speech: { enabled: false }, onChanged });
    return { root, chat };
  }

  it("after a cut-off answer, finds the edit was made: says so plainly, refreshes the page, and sends nothing again", async () => {
    vi.useRealTimers();
    let version = 2;
    const posts = boardApi({ version: () => version, turn: () => (version === 3 ? REMOVED : null), chat: () => ((version = 3), CUT) });
    const changed = vi.fn();
    const { root, chat } = mountWith(changed);
    await chat.send("delete the stock by product chart");
    expect(root.querySelector(".lpc-note.bad")).toBeNull();
    const note = Array.from(root.querySelectorAll(".lpc-note.sync")).map((n) => n.textContent).join(" ");
    expect(note).toBe("Your change was made: removed “Stock by product”. The connection dropped before the reply finished.");
    expect(root.textContent).toContain("I removed “Stock by product”.");
    expect(changed).toHaveBeenCalledTimes(1);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.turnKey).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });

  it("offers Retry when nothing was changed, and Retry sends the same key", async () => {
    vi.useRealTimers();
    let cut = true;
    const posts = boardApi({ version: () => 2, turn: () => null, chat: () => (cut ? CUT : ['data: {"type":"text-delta","id":"t","delta":"Done."}\n\n', 'data: {"type":"finish"}\n\n']) });
    const { root, chat } = mountWith(() => {});
    await chat.send("delete the stock by product chart");
    const retry = (root.querySelector(".lpc-note.bad") as HTMLElement).querySelector("button") as HTMLButtonElement;
    cut = false;
    retry.click();
    await vi.waitFor(() => expect(root.textContent).toContain("Done."));
    expect(posts).toHaveLength(2);
    expect(posts[1]!.turnKey).toBe(posts[0]!.turnKey);
  });

  it("on Retry, checks again first: a turn that finished meanwhile is reported, not run again", async () => {
    vi.useRealTimers();
    let record: unknown = null;
    const posts = boardApi({ version: () => (record ? 3 : 2), turn: () => record, chat: () => CUT });
    const changed = vi.fn();
    const { root, chat } = mountWith(changed);
    await chat.send("delete the stock by product chart");
    const retry = (root.querySelector(".lpc-note.bad") as HTMLElement).querySelector("button") as HTMLButtonElement;
    record = REMOVED;
    retry.click();
    await vi.waitFor(() => expect(root.textContent).toContain("Your change was made: removed “Stock by product”."));
    expect(root.querySelector(".lpc-note.bad")).toBeNull();
    expect(posts).toHaveLength(1);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("with no record left (Lenspack restarted), a board that moved on is shown, by title, and not asked again", async () => {
    vi.useRealTimers();
    let version = 2;
    const widgets = { a: { title: "Visits" }, b: { title: "Stock by product" } };
    const posts = boardApi({
      version: () => version,
      turn: () => null,
      chat: () => ((version = 3), CUT),
      versions: [
        { version: 3, config: { widgets: { a: widgets.a } } },
        { version: 2, config: { widgets } },
      ],
    });
    const changed = vi.fn();
    const { root, chat } = mountWith(changed);
    await chat.send("delete the stock by product chart");
    expect(root.textContent).toContain("The dashboard changed while the connection was down: removed “Stock by product”.");
    expect(root.querySelector(".lpc-note.bad")).toBeNull();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(posts).toHaveLength(1);
  });

  it("a question asked again under a key the server already answered says the change was made, and refreshes", async () => {
    vi.useRealTimers();
    boardApi({ version: () => 3, turn: () => REMOVED, chat: () => [`data: ${JSON.stringify({ type: "data-recovered", data: REMOVED })}\n\n`, 'data: {"type":"text-delta","id":"r","delta":"I removed “Stock by product”."}\n\n', 'data: {"type":"finish"}\n\n'] });
    const changed = vi.fn();
    const { root, chat } = mountWith(changed);
    await chat.send("delete the stock by product chart");
    expect(root.textContent).toContain("Your change was made: removed “Stock by product”.");
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("treats a 502 from Superset's proxy as lost, not as an error to read", async () => {
    vi.useRealTimers();
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string }) =>
      init?.method === "POST" ? { ok: false, status: 502, json: async () => ({ error: "The assistant's server is not reachable: ConnectionError" }) } : { ok: false, status: 502, json: async () => ({}) }));
    const { root, chat } = mountChat();
    await chat.send("Hello");
    expect((root.querySelector(".lpc-note.bad") as HTMLElement).textContent).toContain("connection to Lenspack was lost");
  });
});
