// What the assistant is called where people see it: its name (the chat's header and notes, refusals and errors,
// the admin panel, browser tabs, and how the model introduces itself) and the dashboard button's label, in each
// of the four UI languages, with an optional icon. Lenspack and "Ask Lenspack" unless a deployment says otherwise.
// It is presentation only: URL paths, API routes, config keys, env variables, log lines and the audit log's source
// stay "lenspack". Resolved here once, from (lowest first) these defaults, the config's `brand:`, LENSPACK_BRAND_*
// variables, then an admin on the settings page (settings.json, section "brand"), and handed to the hosts (their
// /info, the admin panel) and to the prompt; no host words it again. Read on every call, so an admin's change
// applies to the next page load and the next question, with no restart.

import { z } from "zod";

import type { SettingsStore } from "./settings";

/** The languages the chat panel is written in; a name and a button label can be set for each. */
export const BRAND_LANGUAGES = ["en", "fr", "hi", "pt"] as const;
export type BrandLanguage = (typeof BRAND_LANGUAGES)[number];

export const DEFAULT_BRAND_NAME = "Lenspack";
/** The button's label in each language when the deployment sets none; {name} is the assistant's name. */
export const BUTTON_DEFAULTS: Record<BrandLanguage, string> = { en: "Ask {name}", fr: "Demander à {name}", hi: "{name} से पूछें", pt: "Perguntar ao {name}" };
/** The panel's attribution line, shown when the assistant has another name (brand.poweredBy turns it off). */
export const POWERED_BY: Record<BrandLanguage, string> = { en: "Powered by Lenspack", fr: "Propulsé par Lenspack", hi: "Lenspack द्वारा संचालित", pt: "Com tecnologia Lenspack" };
export const BRAND_LIMITS = { name: 40, buttonLabel: 40, iconBytes: 32 * 1024, iconUrl: 2048 };

// Plain text, shown as text everywhere: no markup, no control characters, and not blank.
const plain = (what: string, max: number) =>
  z
    .string()
    .trim()
    .min(1, `${what} can't be empty`)
    .max(max, `${what} is at most ${max} characters`)
    .refine((s) => !/[<>]/.test(s), `${what} is plain text: no < or >`)
    .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), `${what} can't contain control characters`);
const nameText = plain("name", BRAND_LIMITS.name).refine((s) => !/[{}]/.test(s), "name can't contain { or }");
const labelText = plain("buttonLabel", BRAND_LIMITS.buttonLabel).refine((s) => !/[{}]/.test(s.replace(/\{name\}/g, "")), "buttonLabel may hold {name}, and no other { or }");

const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,([A-Za-z0-9+/]+={0,2})$/;
/** A data URI's decoded size, in bytes. */
const dataBytes = (b64: string) => Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
const iconText = z
  .string()
  .trim()
  .refine(
    (s) => {
      const m = DATA_IMAGE.exec(s);
      if (m) return dataBytes(m[2]!) <= BRAND_LIMITS.iconBytes;
      return s.length <= BRAND_LIMITS.iconUrl && /^(https:\/\/|\/(?!\/))[^\s"'<>\\]+$/.test(s);
    },
    `icon is an https:// URL, a path on this site (/…), or a data:image/… base64 URI of at most ${BRAND_LIMITS.iconBytes / 1024} KB`,
  );

const words = z.object({ name: nameText.optional(), buttonLabel: labelText.optional() }).strict();

/** `brand:` in lenspack.yaml or superset.yaml, and the settings page's section. Every field is optional. */
export const brandSchema = z
  .object({
    /** The assistant's name wherever a user sees it, and how the model introduces itself. Default Lenspack. */
    name: nameText.optional(),
    /** The dashboard button, and the chat panel's header. {name} is the name. Default "Ask {name}", translated. */
    buttonLabel: labelText.optional(),
    /** A language's own name or label, over the two above: { fr: { buttonLabel: "Interroger les données" } }. */
    i18n: z.object({ en: words.optional(), fr: words.optional(), hi: words.optional(), pt: words.optional() }).strict().optional(),
    /** Replaces the button's and panel's "L" mark: an https URL, a path on this site, or a small data:image URI. */
    icon: iconText.optional(),
    /** A small "Powered by Lenspack" line in the panel when the assistant has another name. Default true. */
    poweredBy: z.boolean().optional(),
  })
  .strict();
export type BrandConfig = z.infer<typeof brandSchema>;

export type BrandWords = { name: string; buttonLabel: string; poweredBy?: string };
/** The brand as the hosts show it: every language's words worked out, nothing left to substitute. */
export type Brand = {
  name: string;
  buttonLabel: string;
  icon: string | null;
  /** Whether the panel shows the attribution line: brand.poweredBy, and only when a name other than Lenspack shows. */
  poweredBy: boolean;
  i18n: Record<BrandLanguage, BrandWords>;
};

/** A schema error as one line: "brand.i18n.fr.name: name is at most 40 characters". */
const firstIssue = (e: z.ZodError, where: string) => {
  const i = e.issues[0]!;
  return `${[where, ...i.path].join(".")}: ${i.message}`;
};

/** Checks a brand section; throws with the first problem, in words. */
export function parseBrand(input: unknown, where = "brand"): BrandConfig {
  if (input === undefined || input === null) return {};
  const r = brandSchema.safeParse(input);
  if (!r.success) throw new Error(firstIssue(r.error, where));
  return r.data;
}

const ON = ["on", "true", "1", "yes"];
const OFF = ["off", "false", "0", "no"];

/** LENSPACK_BRAND_NAME, LENSPACK_BRAND_BUTTON, LENSPACK_BRAND_ICON and LENSPACK_BRAND_POWERED_BY (on or off). */
export function brandFromEnv(env: NodeJS.ProcessEnv = process.env): BrandConfig {
  const out: Record<string, unknown> = {};
  const set = (key: string, name: string) => {
    const v = env[name];
    if (v !== undefined && v !== "") out[key] = v;
  };
  set("name", "LENSPACK_BRAND_NAME");
  set("buttonLabel", "LENSPACK_BRAND_BUTTON");
  set("icon", "LENSPACK_BRAND_ICON");
  const p = env.LENSPACK_BRAND_POWERED_BY?.trim().toLowerCase();
  if (p) {
    if (!ON.includes(p) && !OFF.includes(p)) throw new Error(`LENSPACK_BRAND_POWERED_BY: use on or off, not "${p}"`);
    out.poweredBy = ON.includes(p);
  }
  return parseBrand(out, "LENSPACK_BRAND");
}

/** A field from the highest layer that sets it. */
const picker =
  (layers: (BrandConfig | undefined)[]) =>
  <T>(f: (b: BrandConfig) => T | undefined): T | undefined => {
    let v: T | undefined;
    for (const b of layers) if (b && f(b) !== undefined) v = f(b);
    return v;
  };

/** Each language's button label before the name goes in: its own, else the general one, else the translated default. */
export function buttonTemplates(...layers: (BrandConfig | undefined)[]): Record<BrandLanguage, string> {
  const pick = picker(layers);
  return Object.fromEntries(BRAND_LANGUAGES.map((l) => [l, pick((b) => b.i18n?.[l]?.buttonLabel) ?? pick((b) => b.buttonLabel) ?? BUTTON_DEFAULTS[l]])) as Record<BrandLanguage, string>;
}

/** The brand from its layers, lowest first: each field (and each language's words) from the highest layer that sets it. */
export function resolveBrand(...layers: (BrandConfig | undefined)[]): Brand {
  const pick = picker(layers);
  const name = pick((b) => b.name) ?? DEFAULT_BRAND_NAME;
  const label = pick((b) => b.buttonLabel);
  const fill = (template: string, n: string) => template.replace(/\{name\}/g, () => n);
  const templates = buttonTemplates(...layers);
  const own = Object.fromEntries(
    BRAND_LANGUAGES.map((l) => {
      const n = pick((b) => b.i18n?.[l]?.name) ?? name;
      return [l, { name: n, buttonLabel: fill(templates[l], n) }];
    }),
  ) as Record<BrandLanguage, BrandWords>;
  const renamed = name !== DEFAULT_BRAND_NAME || BRAND_LANGUAGES.some((l) => own[l].name !== DEFAULT_BRAND_NAME);
  const poweredBy = (pick((b) => b.poweredBy) ?? true) && renamed;
  const i18n = Object.fromEntries(BRAND_LANGUAGES.map((l) => [l, poweredBy ? { ...own[l], poweredBy: POWERED_BY[l] } : own[l]])) as Record<BrandLanguage, BrandWords>;
  return { name, buttonLabel: fill(label ?? BUTTON_DEFAULTS.en, name), icon: pick((b) => b.icon) ?? null, poweredBy, i18n };
}

/** The default brand, Lenspack's own. */
export const DEFAULT_BRAND: Brand = resolveBrand();

type Field = "name" | "buttonLabel" | "icon" | "poweredBy" | "i18n";
const FIELDS: Field[] = ["name", "buttonLabel", "icon", "poweredBy", "i18n"];

/** A brand change for the audit log: the icon as its size, not its bytes. */
export function brandAuditDetail(body: Record<string, unknown>): string {
  const icon = body.icon;
  return JSON.stringify(typeof icon === "string" && icon.length > 120 ? { ...body, icon: `(${icon.slice(0, icon.indexOf(",") + 1 || 24)}… ${icon.length} characters)` } : body);
}

export type BrandSettings = {
  /** The brand now, as the hosts and the prompt use it. */
  get(): Brand;
  /** For the settings page: the brand now, without the admin's changes, the admin's own section, and where each field comes from. */
  view(writable: boolean): {
    values: Brand;
    defaults: Brand;
    saved: BrandConfig;
    source: Record<Field, "default" | "config" | "env" | "settings">;
    /** The attribution switch itself (brand.values.poweredBy is false while the name is Lenspack's), now and without the admin. */
    poweredBySwitch: { value: boolean; deployment: boolean };
    /** The deployment's button labels before the name goes in, for the page's preview. */
    templates: Record<BrandLanguage, string>;
    languages: readonly BrandLanguage[];
    limits: typeof BRAND_LIMITS;
    writable: boolean;
  };
  /**
   * PUT <prefix>/settings/brand: any of name, buttonLabel, icon, poweredBy, i18n; null puts a field back to the
   * deployment's value. i18n merges by language and field ({ fr: { name: null } } drops one), null drops it all.
   */
  update(body: Record<string, unknown>): { ok: true; brand: Brand } | { ok: false; error: string };
};

/** The brand over its layers. `settings` null: no settings page, the config and environment only. */
export function brandSettings(o: { config?: unknown; env?: NodeJS.ProcessEnv; settings: SettingsStore | null }): BrandSettings {
  const fromConfig = parseBrand(o.config);
  const fromEnv = brandFromEnv(o.env ?? process.env);
  const deployment = resolveBrand(fromConfig, fromEnv);
  // A section edited by hand into something the schema refuses is left out, not a crash.
  const saved = (): BrandConfig => {
    const r = brandSchema.safeParse(o.settings?.get("brand") ?? {});
    return r.success ? r.data : {};
  };
  const has = (b: BrandConfig, f: Field) => b[f] !== undefined;
  return {
    get: () => resolveBrand(fromConfig, fromEnv, saved()),
    view: (writable) => {
      const s = saved();
      const source = Object.fromEntries(FIELDS.map((f) => [f, has(s, f) ? "settings" : has(fromEnv, f) ? "env" : has(fromConfig, f) ? "config" : "default"])) as Record<Field, "default" | "config" | "env" | "settings">;
      const switchOf = (...ls: BrandConfig[]) => ls.reduce<boolean>((v, b) => b.poweredBy ?? v, true);
      return { values: resolveBrand(fromConfig, fromEnv, s), defaults: deployment, saved: s, source, poweredBySwitch: { value: switchOf(fromConfig, fromEnv, s), deployment: switchOf(fromConfig, fromEnv) }, templates: buttonTemplates(fromConfig, fromEnv), languages: BRAND_LANGUAGES, limits: BRAND_LIMITS, writable: writable && !!o.settings };
    },
    update: (body) => {
      if (!o.settings) return { ok: false, error: "this server keeps no settings (no state directory): set brand: in its config instead" };
      const next: Record<string, unknown> = { ...saved() };
      for (const [k, v] of Object.entries(body)) {
        if (!FIELDS.includes(k as Field)) return { ok: false, error: `unknown brand field "${k}" (one of ${FIELDS.join(", ")})` };
        if (v === null) {
          delete next[k];
          continue;
        }
        if (k !== "i18n") {
          next[k] = v;
          continue;
        }
        if (typeof v !== "object" || Array.isArray(v)) return { ok: false, error: "i18n is a map of language → { name, buttonLabel }" };
        const langs: Record<string, Record<string, unknown>> = { ...(next.i18n as Record<string, Record<string, unknown>> | undefined) };
        for (const [l, w] of Object.entries(v as Record<string, unknown>)) {
          if (w === null) {
            delete langs[l];
            continue;
          }
          if (!w || typeof w !== "object" || Array.isArray(w)) return { ok: false, error: `i18n.${l} is { name, buttonLabel }` };
          const merged: Record<string, unknown> = { ...langs[l] };
          for (const [f, x] of Object.entries(w as Record<string, unknown>)) {
            if (x === null) delete merged[f];
            else merged[f] = x;
          }
          if (Object.keys(merged).length) langs[l] = merged;
          else delete langs[l];
        }
        if (Object.keys(langs).length) next.i18n = langs;
        else delete next.i18n;
      }
      const r = brandSchema.safeParse(next);
      if (!r.success) return { ok: false, error: firstIssue(r.error, "brand") };
      o.settings.set("brand", Object.keys(r.data).length ? r.data : undefined);
      return { ok: true, brand: resolveBrand(fromConfig, fromEnv, r.data) };
    },
  };
}
