// @vitest-environment jsdom
// The words the Superset host's chat and overlay show, in every language the panel offers: each table has the same
// keys in English, French, Hindi and Portuguese with the same placeholders, every tool the agent can call has a step
// line, and the step lines follow the panel's language (a tool with no words gets a neutral one, never its id).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const web = (f: string) => readFileSync(join(__dirname, "..", "web", f), "utf8");
const LANGUAGES = ["en", "fr", "hi", "pt"];

/** A table's object literal, read from the script's source by name (`const NAME = {...}`, `var NAME = {...}` or `NAME: {...}`). */
function table(file: string, name: string): Record<string, Record<string, string>> {
  const src = web(file);
  const at = new RegExp(`(?:(?:const|var|let) ${name} =|\\b${name}:) \\{`).exec(src);
  if (!at) throw new Error(`${name} not found in ${file}`);
  const open = src.indexOf("{", at.index);
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return new Function(`return ${src.slice(open, i + 1)}`)();
  }
  throw new Error(`${name} in ${file} never closes`);
}

const TABLES: [string, string][] = [
  ["chat.js", "STRINGS"],
  ["chat.js", "EXPLAIN_STRINGS"],
  ["chat.js", "TEL_STRINGS"],
  ["chat.js", "TOOL"],
  ["chat.js", "NAMES_IN"],
  ["mine.js", "S"],
  ["mine.js", "TOOLS"],
  ["overlay.js", "STRINGS"],
];
const placeholders = (s: string) => [...new Set(s.match(/\{(?:\d|name)\}/g) ?? [])].sort();

describe("the panel's word tables", () => {
  it.each(TABLES)("%s %s has every key in en, fr, hi and pt, with the same placeholders", (file, name) => {
    const t = table(file, name);
    expect(Object.keys(t).sort()).toEqual(LANGUAGES);
    const keys = Object.keys(t.en!);
    expect(keys.length).toBeGreaterThan(3);
    for (const lang of LANGUAGES) {
      const words = t[lang]!;
      const missing = keys.filter((k) => typeof words[k] !== "string" || !words[k]!.trim());
      const extra = Object.keys(words).filter((k) => !keys.includes(k));
      expect({ lang, missing, extra }).toEqual({ lang, missing: [], extra: [] });
      for (const k of keys) expect({ lang, key: k, placeholders: placeholders(words[k]!) }).toEqual({ lang, key: k, placeholders: placeholders(t.en![k]!) });
    }
  });

  it("the language menu offers exactly the languages the tables have", () => {
    const src = web("chat.js");
    const menu = [...src.slice(src.indexOf("const LANGS = ["), src.indexOf("];", src.indexOf("const LANGS = ["))).matchAll(/\["([a-z]+)"/g)].map((m) => m[1]).filter((c) => c !== "auto");
    expect(menu.sort()).toEqual(LANGUAGES);
  });

  it("every tool the agent defines has a step line", () => {
    const dir = join(__dirname, "..", "..", "..", "kernel", "agent", "src");
    const names = new Set<string>();
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts"))) for (const m of readFileSync(join(dir, f), "utf8").matchAll(/defineTool\(\{\s*name:\s*"([a-z_]+)"/g)) names.add(m[1]!);
    expect(names.size).toBeGreaterThan(25);
    const labelled = new Set([...Object.keys(table("chat.js", "TOOL").en!), ...Object.keys(table("mine.js", "TOOLS").en!)]);
    expect([...names].filter((n) => !labelled.has(n))).toEqual([]);
  });
});

describe("the step lines in the panel's language", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
    localStorage.clear();
    document.body.innerHTML = "";
    delete (window as unknown as Record<string, unknown>).LenspackMine;
  });

  async function steps(locale: string) {
    document.body.innerHTML = "";
    const app = document.createElement("div");
    app.id = "app";
    app.dataset.bootstrap = JSON.stringify({ common: { locale } });
    document.body.append(app);
    const enc = new TextEncoder();
    const ev = (e: unknown) => `data: ${JSON.stringify(e)}\n\n`;
    const frames = [
      ev({ type: "tool-input-available", toolCallId: "c1", toolName: "query", input: {} }),
      ev({ type: "tool-output-available", toolCallId: "c1", output: { ok: true } }),
      ev({ type: "tool-input-available", toolCallId: "c2", toolName: "add_widget", input: { widget: { title: "Visits" } } }),
      ev({ type: "tool-input-available", toolCallId: "c3", toolName: "save_layout", input: {} }),
      ev({ type: "tool-input-available", toolCallId: "c4", toolName: "some_new_tool", input: {} }),
      ev({ type: "text-delta", id: "t", delta: "ok" }),
      ev({ type: "finish" }),
      "data: [DONE]\n\n",
    ];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: { method?: string }) => {
      if (init?.method !== "POST") return { ok: true, status: 200, json: async () => ({ board: { version: 1 } }) };
      let i = 0;
      return { ok: true, status: 200, headers: { get: () => null }, body: { getReader: () => ({ read: async () => (i < frames.length ? { value: enc.encode(frames[i++]), done: false } : { value: undefined, done: true }) }) } };
    }));
    delete (window as unknown as Record<string, unknown>).LenspackChat;
    delete (window as unknown as Record<string, unknown>).LenspackMine;
    new Function(web("mine.js"))();
    new Function(web("chat.js"))();
    const root = document.createElement("div");
    document.body.append(root);
    const chat = (window as unknown as { LenspackChat: { mount(r: HTMLElement, o: unknown): { send(t: string): Promise<void> } } }).LenspackChat.mount(root, { api: "http://x/lenspack", pack: "p", board: "superset-3", speech: { enabled: false } });
    await chat.send("q");
    return Array.from(root.querySelectorAll(".lpc-step")).map((s) => s.textContent);
  }

  it("French: the chat's own tools, mine.js's, and a neutral line for a tool with no words", async () => {
    expect(await steps("fr")).toEqual(["Requête exécutée", "Ajouter un graphique: “Visits”", "Disposition enregistrée", "Autre étape"]);
  });

  it.each([
    ["en", ["Ran a query", "Add chart: “Visits”", "Saved the layout", "Other step"]],
    ["pt_BR", ["Consulta executada", "Adicionar gráfico: “Visits”", "Disposição guardada", "Outro passo"]],
    ["hi", ["क्वेरी चलाई", "चार्ट जोड़ें: “Visits”", "लेआउट सहेजा", "अन्य चरण"]],
  ])("%s", async (locale, want) => {
    expect(await steps(locale)).toEqual(want);
  });
});

describe("limits said in the panel's language", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
    document.body.innerHTML = "";
  });

  async function refusal(locale: string, body: unknown) {
    document.body.innerHTML = "";
    const app = document.createElement("div");
    app.id = "app";
    app.dataset.bootstrap = JSON.stringify({ common: { locale } });
    document.body.append(app);
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: { method?: string }) => {
      if (init?.method !== "POST") return { ok: true, status: 200, json: async () => ({ board: { version: 1 } }) };
      return { ok: false, status: 429, headers: { get: () => null }, body: null, json: async () => { if (body === null) throw new Error("not json"); return body; } };
    }));
    delete (window as unknown as Record<string, unknown>).LenspackChat;
    new Function(web("chat.js"))();
    const root = document.createElement("div");
    document.body.append(root);
    const chat = (window as unknown as { LenspackChat: { mount(r: HTMLElement, o: unknown): { send(t: string): Promise<void> } } }).LenspackChat.mount(root, { api: "http://x/lenspack", pack: "p", board: "superset-4", speech: { enabled: false } });
    await chat.send("q");
    return root.querySelector(".lpc-note.bad")!.textContent;
  }

  it("a per-person limit keeps the server's words (it writes them in the panel's language)", async () => {
    expect(await refusal("fr", { error: "Limite atteinte.", code: "limit" })).toBe("Limite atteinte.");
  });
  it("the daily spend cap (English from the server) is said in French", async () => {
    expect(await refusal("fr", { error: "Chat has used today's budget for this server (US$1.00 of US$1.00). It resets at 00:00 UTC." })).toMatch(/^Le budget du jour/);
  });
  it("in English the server's words stay, amounts included", async () => {
    expect(await refusal("en", { error: "You have used today's chat budget (US$0.50 of US$0.50). It resets at 00:00 UTC." })).toMatch(/US\$0\.50/);
  });
  it("a bare 429 (a proxy's) gets the panel's own words, not the number", async () => {
    expect(await refusal("pt", null)).toMatch(/^Muitos pedidos/);
  });
});
