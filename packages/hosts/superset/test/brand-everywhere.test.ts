// @vitest-environment jsdom
// Once a deployment names the assistant, the product's name appears nowhere people look. Two kinds of check:
//   - every surface drawn with a brand set, in all four languages: the dashboard button, the chat panel (with the
//     dashboards menus), and the telemetry checklist the admin panel's Telemetry tab shows;
//   - every string in the code people can see (the scripts of the overlay, the chat and the admin panel in every
//     language, and the server's messages), read from the source: none names the product, except the "Powered by"
//     credit (behind brand.poweredBy), the default name used when no brand is set, and names that are code
//     (variables, keys, routes, file names), log lines and messages to whoever starts the server.
// The Superset plugin's own pages are checked by its Python tests (test_lenspack_superset.py, NoProductName), and
// the prompt by brand.test.ts.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { fieldDefaults, telemetryChecklist } from "@lenspack/agent";
import { POWERED_BY, type Brand, resolveBrand } from "@lenspack/serve";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const root = join(__dirname, "..", "..", "..", "..");
const web = (f: string) => readFileSync(join(__dirname, "..", "web", f), "utf8");
const PRODUCT = /lenspack/i;
const BRAND = resolveBrand({ name: "Campaign desk", i18n: { fr: { name: "Campaign desk" } } });
const LANGS = [
  ["en", null],
  ["fr", "fr"],
  ["hi", "hi"],
  ["pt", "pt_BR"],
] as const;

/** Everything a person can read in an element: its text, and the attributes a screen reader or a tooltip shows. */
function visible(el: Element, except: (e: Element) => boolean = () => false): string[] {
  const out: string[] = [];
  const walk = (n: Node) => {
    if (n.nodeType === 3) {
      const t = n.textContent?.trim();
      if (t) out.push(t);
      return;
    }
    if (!(n instanceof Element) || except(n) || n.tagName === "STYLE" || n.tagName === "SCRIPT") return;
    for (const a of ["title", "aria-label", "placeholder", "alt", "value"]) {
      const v = n.getAttribute(a);
      if (v) out.push(v);
    }
    n.childNodes.forEach(walk);
  };
  walk(el);
  return out;
}
const named = (texts: string[]) => texts.filter((t) => PRODUCT.test(t));

function supersetLocale(locale: string | null) {
  document.body.innerHTML = "";
  if (locale) {
    const app = document.createElement("div");
    app.id = "app";
    app.dataset.bootstrap = JSON.stringify({ common: { locale } });
    document.body.append(app);
  }
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}), body: null, text: async () => "" })));
});
afterEach(() => vi.unstubAllGlobals());

describe("with a brand set, the product's name is on no surface", () => {
  function mountChat(brand: Brand) {
    for (const k of ["LenspackChat", "LenspackMine"]) delete (window as unknown as Record<string, unknown>)[k];
    new Function(web("mine.js"))();
    new Function(web("chat.js"))();
    const panel = document.createElement("div");
    document.body.append(panel);
    const chat = (window as unknown as { LenspackChat: { mount(r: HTMLElement, o: unknown): { setOffline(on: boolean): void } } }).LenspackChat.mount(panel, {
      api: "http://x/assistant",
      pack: "p",
      board: "superset-9",
      examples: { en: ["Visits by region"] },
      speech: { enabled: true, maxSeconds: 60 },
      brand,
    });
    return { panel, chat };
  }

  it.each(LANGS)("the chat panel and its dashboards menus (%s), with only the credit naming it", (lang, locale) => {
    supersetLocale(locale);
    const { panel, chat } = mountChat(BRAND);
    // While the server restarts the panel says so, by name.
    chat.setOffline(true);
    expect(named(visible(panel, (e) => e.classList.contains("lpc-by")))).toEqual([]);
    expect(panel.querySelector(".lpc-by")!.textContent).toBe(POWERED_BY[lang]);
    // Without the credit, nothing at all.
    supersetLocale(locale);
    const plain = mountChat(resolveBrand({ name: "Campaign desk", poweredBy: false }));
    expect(named(visible(plain.panel))).toEqual([]);
  });

  it.each(LANGS)("the dashboard button (%s)", async (_, locale) => {
    supersetLocale(locale);
    window.history.pushState({}, "", "/superset/dashboard/9/");
    delete (window as unknown as Record<string, unknown>).__lenspackOverlay;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        json: async () => (String(url).includes("/_superset/bind") ? { board: "superset-9", title: "Visits" } : String(url).includes("/_superset/info") ? { pack: "p", examples: [], panel: "float", brand: BRAND } : { ok: true }),
      })),
    );
    Object.defineProperty(document, "currentScript", { configurable: true, value: { src: "http://x/assistant/overlay.js" } });
    new Function(web("overlay.js"))();
    await vi.waitFor(() => expect((document.querySelector(".lpo-btn") as HTMLElement).style.display).toBe("inline-flex"));
    expect(named(visible(document.body))).toEqual([]);
  });

  it("the telemetry checklist the admin panel shows, inside Superset or not, its logs readable or not", () => {
    for (const supersetLogs of [null, { available: true, count: 3, lastSeen: "2026-11-19T00:00:00Z" }, { available: false, reason: "no access", count: 0, lastSeen: null }]) {
      const list = telemetryChecklist({
        now: new Date("2026-11-20T00:00:00Z"),
        switches: { telemetry: true, fields: fieldDefaults() },
        settings: { retentionDays: 90, audioRetentionDays: 30, consentNotice: null },
        features: { telemetry: true, voice: true, cache: true, clarify: true, "review.daily": false },
        context: {},
        lines: [],
        audioSaved: [],
        supersetLogs,
      });
      const texts: string[] = [];
      JSON.stringify(list, (k, v) => (typeof v === "string" && !["id", "key", "feature", "blockedBy"].includes(k) && texts.push(v), v));
      expect(texts.length).toBeGreaterThan(40);
      expect(named(texts)).toEqual([]);
    }
  });
});

// ---- The source: every string literal that names the product must be one of these. ----

/** Parts of a string that are code, not words: variables, keys, headers, routes, files, packages, the project's address. */
const CODE = [
  /\b[A-Z0-9_]*LENSPACK_[A-Z0-9_]+\b/g, // environment variables
  /@lenspack\/[\w./-]+/g, // packages
  /\bx-lenspack-[\w-]+/gi, // headers
  /\/api\/v1\/lenspack\/[\w-]*/g, // the plugin's API routes
  /\/_lenspack\b[\w/-]*/g, // the standalone server's routes
  /\blenspack[_-][\w-]*(\.py)?/g, // storage keys, the plugin file, CSS ids
  /[\w./-]*\blenspack\.(ya?ml|json)\b/g, // config files
  /\bLenspack(Chat|Mine|Board|Checklist|Config)\b/g, // globals the scripts expose
  /\b__lenspack\w*/g,
  /github\.com\/theflywheel\/lenspack/g, // the credit's link
  /lenspack\.proto\.theflywheel\.in/g, // a provider's attribution header, never shown
  /(?<![\w/])\/lenspack\b/g, // the default address of Superset's route (LENSPACK_PATH changes it)
];
/** Whole strings that are names in code: the default service account and a provider's title header, the state folder, a document kind. */
const CODE_NAMES = new Set(["lenspack", ".lenspack", "lenspack/definitions"]);
const credits = Object.values(POWERED_BY);
/** A string with its code and the credit's own words (an admin chooses whether to show it) taken out. */
const words = (s: string) => credits.reduce((t, c) => t.split(c).join(" "), CODE.reduce((t, re) => t.replace(re, " "), s));

/** Where the default name may stand: it is what the assistant is called when no brand is set. */
const DEFAULT_NAME = new Set(["Lenspack"]);
/** Messages to whoever installs, starts or runs the server (its command line and console, never a page), file → a piece of each. */
const OPERATOR: Record<string, string[]> = {
  "packages/hosts/superset/src/bootstrap.ts": ["No Superset account for Lenspack"],
  "packages/hosts/superset/src/server.ts": ["WARNING: "],
  "packages/hosts/serve/src/cli.ts": ["lenspack <command>"],
  "packages/hosts/serve/src/password.ts": ["lenspack hash-password", "lenspack's user", "user lenspack runs as"],
  "packages/hosts/serve/src/review/panel.ts": ["missing from this install"],
  "packages/hosts/serve/src/review/usage.ts": ["missing from this install"],
};

const SOURCES = [
  "packages/hosts/superset/web",
  "packages/hosts/serve/web/admin",
  "packages/hosts/superset/src",
  "packages/hosts/serve/src",
  "packages/kernel/agent/src",
  "packages/kernel/engine/src",
  "packages/kernel/policy/src",
  "packages/kernel/core/src",
  "packages/kernel/pack/src",
  "packages/hosts/react/src",
  "examples/demo/src",
];
const files = (dir: string): string[] =>
  readdirSync(join(root, dir)).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(join(root, p)).isDirectory()) return files(p);
    return /\.(tsx?|js|html)$/.test(f) && !f.endsWith(".d.ts") ? [p] : [];
  });

/** Each string in a file that a person could read, with where it is; log calls are left out. */
function strings(file: string): { text: string; line: number }[] {
  let src = readFileSync(join(root, file), "utf8");
  const out: { text: string; line: number }[] = [];
  if (file.endsWith(".html")) {
    // A page: its text and attributes, then its scripts as code.
    const scripts: string[] = [];
    src = src.replace(/<script[^>]*>([\s\S]*?)<\/script>/g, (_, js) => (scripts.push(js), " ")).replace(/<style[\s\S]*?<\/style>/g, " ");
    src.split("\n").forEach((l, i) => PRODUCT.test(l) && out.push({ text: l.replace(/<[^>]*\b(href|src|id|class)="[^"]*"[^>]*>/g, " "), line: i + 1 }));
    for (const js of scripts) out.push(...literals(js, file));
    return out;
  }
  return literals(src, file);
}
function literals(src: string, file: string): { text: string; line: number }[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith(".js") ? ts.ScriptKind.JS : file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: { text: string; line: number }[] = [];
  const logged = (n: ts.Node): boolean => {
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
      if (ts.isCallExpression(p)) {
        const callee = p.expression.getText(sf);
        if (/(^|\.)(log|warn|error|info|debug)$/.test(callee) || /^console\./.test(callee)) return true;
      }
    }
    return false;
  };
  const visit = (n: ts.Node) => {
    let text: string | null = null;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) text = n.text;
    else if (ts.isJsxText(n)) text = n.getText(sf).trim();
    else if (ts.isTemplateExpression(n)) text = [n.head.text, ...n.templateSpans.map((s) => s.literal.text)].join("…");
    if (text !== null && PRODUCT.test(text) && !logged(n) && !ts.isImportDeclaration(n.parent) && !ts.isExportDeclaration(n.parent)) out.push({ text, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 });
    if (!ts.isTemplateExpression(n)) ts.forEachChild(n, visit);
    else n.templateSpans.forEach((s) => visit(s.expression));
  };
  visit(sf);
  return out;
}

describe("no string people can see names the product", () => {
  const credit = new Set(Object.values(POWERED_BY));

  it.each(SOURCES)("%s", (dir) => {
    const found: string[] = [];
    for (const file of files(dir)) {
      const rel = relative(root, join(root, file));
      for (const { text, line } of strings(file)) {
        if (DEFAULT_NAME.has(text) || CODE_NAMES.has(text) || credit.has(text) || (OPERATOR[rel] ?? []).some((piece) => text.includes(piece))) continue;
        if (PRODUCT.test(words(text))) found.push(`${rel}:${line}: ${text.slice(0, 160)}`);
      }
    }
    expect(found).toEqual([]);
  });

  it("the usage pack the admin panel draws", () => {
    const yaml = readFileSync(join(root, "packages/hosts/serve/packs/usage/pack.yaml"), "utf8");
    const lines = yaml.split("\n").filter((l) => PRODUCT.test(words(l)) && !/^\s*#/.test(l));
    expect(lines).toEqual([]);
  });

  it("would catch one", () => {
    expect(literals('const a = "Ask Lenspack"; log("Lenspack started"); const k = "lenspack-voice";', "x.ts").map((s) => words(s.text)).filter((t) => PRODUCT.test(t))).toEqual(["Ask Lenspack"]);
  });
});
