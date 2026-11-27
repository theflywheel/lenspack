// Changing the pack while the server runs (docs/hosts/superset/pack-runtime.md). The deploy config's overlay is the
// base; an admin's changes are a layer over it (@lenspack/policy pack-layer.ts decides what the layer may hold), kept
// as versions in the state directory (@lenspack/serve pack-layer.ts). Every change is checked as at start-up, against
// Superset's datasets as they are now: the pack is built again from them, with the example questions checked against
// it, and a change that adds a problem is refused with nothing changed. A change that passes is saved as a version,
// then the new pack is handed to the server (swap), which uses it from the next request on; turns already running
// finish on the pack they began with.

import { type Capabilities, check } from "@lenspack/engine";
import { type Pack, PackError } from "@lenspack/pack";
import { type AdminAccess, PACK_CONFIG_FIELDS, PACK_DATA_BOUNDARY, PACK_RUNTIME_FIELDS, type PackLayer, type Principal, applyPackLayer, packChangeRefusals, packEditRights, packFieldsChanged, packLayerFrom, packLayerWith, packRuntimeView, sameValue } from "@lenspack/policy";
import { type AuditEvent, NO_STORE, type PackLayerStore, type PackVersion, type PackVersionAction, SettingsConflictError, SettingsSaveError, conflictAnswer, ifMatchRevision, json, readJson, revisionTag } from "@lenspack/serve";
import type { IncomingMessage, ServerResponse } from "node:http";
import YAML from "yaml";

import { type Binding, type Overlay, type SupersetDataset, packFromDatasets, packScope } from "./catalogue";
import { timeZoneWarnings } from "./connector";

/** The pack in force, with what it was built from. */
export type LivePack = {
  pack: Pack;
  packYaml: string;
  binding: Binding;
  datasets: SupersetDataset[];
  /** The overlay it was built from: the deploy config's, with the layer over it. */
  overlay: Overlay;
  /** What the pack left out or renamed, and why: said at start, in the settings API, and after each change. */
  warnings: string[];
  /** The deploy config's scope clauses this pack can't apply (packScope), said apart. */
  scopeWarnings: string[];
  /** The layer's version in force (0: the deploy config alone), and the layer. */
  version: number;
  layer: PackLayer;
  /** Set when the saved layer could not be built at start, so the deploy config alone is in force. */
  notApplied?: { version: number; why: string };
};

export type BuiltPack = Pick<LivePack, "pack" | "packYaml" | "binding" | "warnings" | "scopeWarnings"> & {
  /** Problems a change may not add: mistakes in the overlay, hierarchies and scope clauses it leaves without their dimensions, example questions the pack would refuse. */
  findings: string[];
};

/**
 * The pack from datasets and an overlay, as at start-up (packFromDatasets), with what a change is checked against: the
 * overlay's mistakes, the warnings that name the overlay, hierarchies left out because a level is not a dimension, the
 * deploy config's scope clauses on dimensions the pack lacks, and example questions the pack would refuse. Throws when
 * the pack can't be built at all (an example naming a key the pack doesn't have, a hierarchy over a time dimension).
 */
export function buildPack(datasets: SupersetDataset[], overlay: Overlay, o: { scope?: unknown; capabilities?: Capabilities; mapStyle?: string } = {}): BuiltPack {
  let built: ReturnType<typeof packFromDatasets>;
  try {
    built = packFromDatasets(datasets, overlay);
  } catch (e) {
    if (!(e instanceof PackError)) throw e;
    // Said part by part, each example by its question, with what the rest of the change would find first (often the
    // cause: a measure left out, or a column made no dimension, that an example names).
    const question = (path: string) => {
      const i = /^examples\[(\d+)\]/.exec(path)?.[1];
      const q = i === undefined ? undefined : (overlay.examples?.[Number(i)] as { question?: unknown } | undefined)?.question;
      const text = typeof q === "string" ? q : q && typeof q === "object" ? Object.values(q).find((v) => typeof v === "string") : undefined;
      return i === undefined ? path : `examples[${i}]${text ? ` ("${String(text)}")` : ""}`;
    };
    let first: string[] = [];
    try {
      first = buildPack(datasets, { ...overlay, examples: [] }, o).findings;
    } catch {
      /* the examples are not the only trouble: their problems are said below */
    }
    throw new PackBuildError([...first, ...e.problems.map((p) => `${question(p.path)}: ${p.message}`)]);
  }
  const { pack, packYaml, binding } = built;
  if (o.mapStyle) binding.mapStyle ??= o.mapStyle;
  const scope = packScope(o.scope, pack);
  const findings = [...built.problems, ...built.warnings.filter((w) => w.startsWith("overlay."))];
  for (const [name, levels] of Object.entries(overlay.hierarchies ?? {})) {
    const missing = (Array.isArray(levels) ? levels : []).filter((l) => !pack.dimensions.some((d) => d.key === l));
    if (missing.length) findings.push(`hierarchies.${name}: ${missing.map((l) => `"${l}"`).join(", ")} ${missing.length === 1 ? "is not a dimension" : "are not dimensions"} of the pack, so the hierarchy is left out`);
  }
  findings.push(...scope.warnings.map((w) => `the deploy config's ${w}`));
  for (const [i, ex] of pack.examples.entries()) {
    try {
      check(ex.query, pack, { ctx: scope.clauses.length ? { scope: scope.clauses } : {}, ...(o.capabilities ? { capabilities: o.capabilities } : {}) });
    } catch (e) {
      findings.push(`examples[${i}] ("${ex.question}"): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { pack, packYaml, binding, warnings: [...built.problems, ...built.warnings, ...timeZoneWarnings(pack, binding)], scopeWarnings: scope.warnings, findings };
}

/** Why a pack can't be built at all, part by part. */
export class PackBuildError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join("; "));
  }
}

const words = (v: unknown) => typeof v === "string" || (!!v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string"));
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** What is wrong with the runtime fields' shapes, before anything is built. */
export function shapeProblems(given: Record<string, unknown>): string[] {
  const p: string[] = [];
  const set = (k: string) => given[k] !== undefined && given[k] !== null;
  for (const k of ["description", "instructions"]) if (set(k) && typeof given[k] !== "string") p.push(`${k} is text`);
  for (const k of ["labels", "hints"])
    if (set(k)) {
      if (!isMap(given[k])) p.push(`${k} is a map from a key to its text, like { region: Region }`);
      else for (const [key, v] of Object.entries(given[k])) if (!words(v)) p.push(`${k}.${key} is text, or text per language ({ en: …, fr: … })`);
    }
  if (set("notDimensions") && (!Array.isArray(given.notDimensions) || given.notDimensions.some((c) => typeof c !== "string"))) p.push("notDimensions is a list of column names");
  if (set("hierarchies")) {
    if (!isMap(given.hierarchies)) p.push("hierarchies is a map from a name to its levels, like { place: [country, city] }");
    else for (const [name, levels] of Object.entries(given.hierarchies)) if (!Array.isArray(levels) || levels.length < 2 || levels.some((l) => typeof l !== "string")) p.push(`hierarchies.${name} is a list of two or more dimension keys, coarse to fine`);
  }
  if (set("measures") && (!Array.isArray(given.measures) || given.measures.some((m) => !isMap(m)))) p.push("measures is a list, each like { dataset: orders, name: items_sold, agg: sum, column: quantity }");
  if (set("examples")) {
    if (!Array.isArray(given.examples)) p.push("examples is a list, each like { question: Orders by region, query: { kind: breakdown, … } }");
    else {
      if (given.examples.length > 12) p.push(`examples holds at most 12 questions, not ${given.examples.length}`);
      given.examples.forEach((e, i) => {
        if (!isMap(e) || !words(e.question) || !isMap(e.query)) p.push(`examples[${i}] is { question, query }: the question as text (or text per language) and the query that answers it`);
      });
    }
  }
  return p;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const fieldList = (fields: readonly string[]) => (fields.length ? fields.join(", ") : "nothing");

export type PackRuntimeOptions = {
  /** The deploy config's overlay, secrets resolved: the base every layer is laid over. */
  base: Overlay;
  /** The same overlay as the file writes it (env: references kept), for the export. Else the base. */
  raw?: Overlay;
  /** The deploy config's scope (config only): the pack is checked against it. */
  scope?: unknown;
  store: PackLayerStore;
  /** Superset's datasets as they are now, fetched as at start (each one retried). */
  fetch: () => Promise<SupersetDataset[]>;
  capabilities?: () => Capabilities;
  /** The basemap when the overlay names none (Superset's default for its version). */
  mapStyle?: string;
  /** The new pack is in force: the host hands it to everything that uses the pack. */
  swap: (live: LivePack) => void | Promise<void>;
  log: (line: string) => void;
};

/** What the routes need from the server at request time. */
export type PackRouteOptions = {
  /** Who is an admin under the deployment's access mode (adminAccess.state()). */
  access?: () => AdminAccess;
  /** Marks an admin seen (the admins roster). */
  seen?: (who: Principal) => void;
  audit?: (e: AuditEvent) => void;
  /** Who may do this, in the host's words ("Superset admin"). */
  adminName?: string;
};

type Checked = { ok: true; built: BuiltPack; datasets: SupersetDataset[]; changed: string[]; warnings: string[] } | { ok: false; status: number; problems: string[]; changed?: string[] };

export function packRuntime(o: PackRuntimeOptions) {
  const base = o.base;
  let live: LivePack | null = null;
  // One change at a time: each is checked against the pack in force when its turn comes.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const next = queue.catch(() => {}).then(f);
    queue = next;
    return next;
  };
  const opts = () => ({ scope: o.scope, capabilities: o.capabilities?.(), mapStyle: o.mapStyle });
  const now = (): LivePack => {
    if (!live) throw new Error("the pack is not built yet");
    return live;
  };

  /** At start: the saved layer over the deploy config, as start-up builds any overlay; the config alone if it can't be built. */
  function start(datasets: SupersetDataset[]): LivePack {
    const saved = o.store.current();
    if (saved.version) {
      try {
        const overlay = applyPackLayer(base, saved.layer as PackLayer);
        live = { ...buildPack(datasets, overlay, opts()), datasets, overlay, version: saved.version, layer: saved.layer as PackLayer };
        const v = o.store.get(saved.version);
        o.log(`pack: runtime changes in force, version ${saved.version}${v ? ` (${fieldList(Object.keys(saved.layer))}; by ${v.by} at ${v.at})` : ""}; the deploy config's overlay is the base`);
        return live;
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        o.log(`warning: the pack's runtime changes (version ${saved.version}) no longer build against Superset's datasets (${why}); the deploy config's pack alone is in force until they are fixed, or reset, on the settings page`);
        live = { ...buildPack(datasets, base, opts()), datasets, overlay: base, version: 0, layer: {}, notApplied: { version: saved.version, why } };
        return live;
      }
    }
    live = { ...buildPack(datasets, base, opts()), datasets, overlay: base, version: 0, layer: {} };
    return live;
  }

  /** A layer checked against Superset's datasets now: the pack it gives, or why it can't be. Nothing changes. */
  async function checkLayer(layer: PackLayer): Promise<Checked> {
    const current = now();
    let datasets: SupersetDataset[];
    try {
      datasets = await o.fetch();
    } catch (e) {
      return { ok: false, status: 502, problems: [`Superset's datasets could not be read to check the change: ${e instanceof Error ? e.message : String(e)}`] };
    }
    const changed = packFieldsChanged(base, current.layer, layer);
    let built: BuiltPack;
    try {
      built = buildPack(datasets, applyPackLayer(base, layer), opts());
    } catch (e) {
      return { ok: false, status: 400, problems: e instanceof PackBuildError ? e.problems : [e instanceof Error ? e.message : String(e)], changed };
    }
    // A change may not add a problem. Ones the pack in force already has (on the same datasets) are left to the
    // deploy config, or to a change that fixes them.
    let before: string[] = [];
    try {
      before = buildPack(datasets, applyPackLayer(base, current.layer), opts()).findings;
    } catch {
      /* the pack in force no longer builds on today's datasets: every finding is the change's to answer for */
    }
    const added = built.findings.filter((f) => !before.includes(f));
    if (added.length) return { ok: false, status: 400, problems: added, changed };
    return { ok: true, built, datasets, changed, warnings: [...built.warnings, ...built.scopeWarnings] };
  }

  /** Checks, saves as a version and swaps; or refuses with nothing changed. */
  function change(layer: PackLayer, meta: { by: string; action: PackVersionAction; why?: string; reverts?: number; ifVersion?: number | null }) {
    return serial(async (): Promise<{ ok: true; version: PackVersion; warnings: string[] } | { ok: false; status: number; problems: string[] }> => {
      const current = now();
      // Changed since the writer read it: refused before the pack is built again (the store refuses it too).
      const conflict = o.store.stale(meta.ifVersion);
      if (conflict) throw conflict;
      const c = await checkLayer(layer);
      if (!c.ok) return c;
      if (!c.changed.length && sameValue(layer, current.layer) && !current.notApplied) return { ok: false, status: 409, problems: ["nothing would change: the pack already reads this way"] };
      const summary =
        meta.action === "revert" ? `back to version ${meta.reverts}${c.changed.length ? ` (${fieldList(c.changed)})` : ""}` : meta.action === "reset" ? (Object.keys(layer).length ? `${fieldList(c.changed)} back to the deploy config` : "everything back to the deploy config") : fieldList(c.changed);
      const version = o.store.append({ by: meta.by, action: meta.action, summary, changed: c.changed, layer: layer as Record<string, unknown>, ...(meta.why ? { why: meta.why } : {}), ...(meta.reverts !== undefined ? { reverts: meta.reverts } : {}) }, { ifVersion: meta.ifVersion });
      const overlay = applyPackLayer(base, layer);
      live = { ...c.built, datasets: c.datasets, overlay, version: version.version, layer };
      await o.swap(live);
      o.log(`pack: version ${version.version} by ${meta.by}: ${summary}; ${plural(Object.keys(live.pack.entities).length, "dataset")}, ${plural(live.pack.dimensions.length, "dimension")}, ${plural(live.pack.measures.length, "measure")}`);
      return { ok: true, version, warnings: c.warnings };
    });
  }

  /** Each runtime field's source under a layer: the deploy config, a change made here, both (exclusions), or neither. */
  const sources = (layer: PackLayer) =>
    Object.fromEntries(
      PACK_RUNTIME_FIELDS.map((f) => {
        const inBase = base[f as keyof Overlay] !== undefined && base[f as keyof Overlay] !== null;
        const inLayer = f in layer;
        return [f, inLayer ? (f === "exclude" && inBase ? "config and settings" : "settings") : inBase ? "config" : "none"];
      }),
    );
  const yamlOf = (layer: PackLayer) => {
    const v = packRuntimeView(base, layer);
    return Object.keys(v).length ? YAML.stringify(v, { lineWidth: 0 }) : "";
  };
  const versionView = (v: PackVersion) => ({ version: v.version, at: v.at, by: v.by, action: v.action, summary: v.summary, changed: v.changed, ...(v.why ? { why: v.why } : {}), ...(v.reverts !== undefined ? { reverts: v.reverts } : {}) });

  /** The whole overlay as it runs (or ran at a version), to paste under overlay: in the deploy config. */
  function exportYaml(version?: number) {
    const current = now();
    const layer = (version === undefined ? current.layer : (o.store.get(version)?.layer ?? null)) as PackLayer | null;
    if (!layer) return null;
    const v = version ?? current.version;
    const meta = v ? o.store.get(v) : undefined;
    const out = applyPackLayer((o.raw ?? base) as Record<string, unknown>, layer);
    const head = [
      `# The pack's overlay as it ${version === undefined ? "runs now" : "ran"} (version ${v}${meta?.by ? `, by ${meta.by} at ${meta.at}` : ": the deploy config alone"}).`,
      "# Paste it as overlay: in the deploy config (superset.yaml); once it is there, reset the changes on the settings page.",
    ];
    return `${head.join("\n")}\n${YAML.stringify({ overlay: out }, { lineWidth: 0 })}`;
  }

  /**
   * What a request body asks for, as a layer: { yaml } is the runtime fields as the pack should use them (a field left
   * out follows the deploy config); { fields } changes only the fields named (null hands one back to the config).
   */
  function layerFromBody(b: Record<string, unknown>): { layer: PackLayer } | { problems: string[] } {
    const current = now();
    if (typeof b.yaml === "string") {
      let parsed: unknown;
      try {
        parsed = b.yaml.trim() ? YAML.parse(b.yaml) : {};
      } catch (e) {
        return { problems: [`the YAML can't be read: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`] };
      }
      if (parsed === null || parsed === undefined) parsed = {};
      // Pasted with its heading from the deploy config, or from the export.
      if (isMap(parsed) && Object.keys(parsed).length === 1 && isMap(parsed.overlay)) parsed = parsed.overlay;
      if (!isMap(parsed)) return { problems: ["the YAML is a map of the pack's parts, like description: …, labels: { … }"] };
      // Config-only parts written as the deploy config has them (an export pasted back) change nothing, so they pass.
      const given = Object.fromEntries(Object.entries(parsed).filter(([k, v]) => !(PACK_CONFIG_FIELDS[k] && (sameValue(v, base[k as keyof Overlay]) || sameValue(v, o.raw?.[k as keyof Overlay])))));
      const problems = [...packChangeRefusals(given, base as Record<string, unknown>), ...shapeProblems(given)];
      return problems.length ? { problems } : { layer: packLayerFrom(base as Record<string, unknown>, given) };
    }
    if (isMap(b.fields)) {
      const problems = [...packChangeRefusals(b.fields, base as Record<string, unknown>), ...shapeProblems(b.fields)];
      return problems.length ? { problems } : { layer: packLayerWith(base as Record<string, unknown>, current.layer, b.fields) };
    }
    return { problems: ['send { "yaml": "<the pack\'s parts as YAML>" } or { "fields": { "<part>": <value, or null for the deploy config\'s> } }'] };
  }

  /** The routes under <prefix>/settings/pack, for admins. Answers by responding; false for any other path. */
  function routes(prefix: string, r: PackRouteOptions = {}) {
    const adminName = r.adminName ?? "admin";
    return async (req: IncomingMessage, res: ServerResponse, url: URL, who: Principal): Promise<boolean> => {
      const root = `${prefix}/settings/pack`;
      if (url.pathname !== root && !url.pathname.startsWith(`${root}/`)) return false;
      const path = url.pathname.slice(root.length) || "/";
      // Every answer carries the version in force as its ETag ("pack-3"): send it back as If-Match on a change.
      const send = (status: number, body: unknown) => (json(res, status, body, { ...NO_STORE, ETag: revisionTag(now().version, "pack") }), true);
      const audit = (action: string, detail: string, outcome: AuditEvent["outcome"] = "ok") => {
        try {
          r.audit?.({ at: new Date().toISOString(), user: who.user, pack: now().pack.pack, action, outcome, detail: detail.slice(0, 1000) });
        } catch {
          /* the audit log never takes a change down with it */
        }
      };
      const rights = packEditRights(who, r.access?.());
      if (!rights.read) {
        audit(`${req.method} ${url.pathname}`, `not an ${adminName}`, "denied");
        return send(403, { error: `only ${adminName}s can do this` });
      }
      r.seen?.(who);
      const current = now();
      const body = async (): Promise<Record<string, unknown> | { error: string }> => {
        try {
          const b = await readJson(req, 512_000);
          if (b === null || b === undefined) return {};
          if (!isMap(b)) return { error: "the body is a JSON object" };
          return b;
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
      };
      const why = (b: Record<string, unknown>) => (typeof b.why === "string" && b.why.trim() ? b.why.trim().slice(0, 500) : undefined);
      const refused = (action: string, x: { status: number; problems: string[] }) => {
        if (x.status !== 409) audit(`pack ${action}`, `refused: ${x.problems.join("; ")}`, "refused");
        return send(x.status, { error: x.problems[0], problems: x.problems });
      };
      const done = (x: { version: PackVersion; warnings: string[] }) => send(200, { ok: true, version: versionView(x.version), warnings: x.warnings, pack: { dimensions: now().pack.dimensions.length, measures: now().pack.measures.length } });
      const saveError = (e: unknown) => {
        if (e instanceof SettingsSaveError) return send(503, { error: e.message });
        // Changed since the writer read it: who changed it, and the pack as it is now, to make the change on.
        if (e instanceof SettingsConflictError) return send(409, conflictAnswer(e, view()));
        throw e;
      };
      // The version the writer read: If-Match ("pack-3"), else the body's `version`; neither, no check (the last write wins).
      const header = ifMatchRevision(req.headers["if-match"], "pack");
      if (header instanceof Error) return send(400, { error: header.message });
      const ifVersion = (b: Record<string, unknown>) => header ?? (Number.isInteger(b.version) ? (b.version as number) : null);

      // The pack as it runs: its runtime parts as YAML (what the page edits), where each comes from, and what stays in the config.
      if (path === "/" && req.method === "GET") return send(200, view());
      function view() {
        const current = now();
        return {
          version: current.version,
          ...(current.version ? { changedBy: o.store.get(current.version)?.by, changedAt: o.store.get(current.version)?.at } : {}),
          ...(current.notApplied ? { notApplied: current.notApplied } : {}),
          yaml: yamlOf(current.layer),
          overlay: packRuntimeView(base, current.layer),
          layer: current.layer,
          sources: sources(current.layer),
          runtimeFields: PACK_RUNTIME_FIELDS,
          configOnly: Object.entries(PACK_CONFIG_FIELDS).map(([field, reason]) => ({ field, reason, value: base[field as keyof Overlay] ?? null })),
          dataBoundary: PACK_DATA_BOUNDARY,
          pack: { name: current.pack.pack, datasets: Object.keys(current.pack.entities).length, dimensions: current.pack.dimensions.length, measures: current.pack.measures.length },
          warnings: [...current.warnings, ...current.scopeWarnings],
          versions: o.store.versions().length,
        };
      }
      // Checks a change as Save would, changing nothing.
      if (path === "/validate" && req.method === "POST") {
        const b = await body();
        if ("error" in b) return send(400, { error: b.error });
        const asked = layerFromBody(b);
        if ("problems" in asked) return send(200, { ok: false, problems: asked.problems, warnings: [] });
        const c = await checkLayer(asked.layer);
        if (!c.ok) return send(200, { ok: false, problems: c.problems, changed: c.changed ?? [], warnings: [] });
        return send(200, { ok: true, problems: [], changed: c.changed, warnings: c.warnings, pack: { dimensions: c.built.pack.dimensions.length, measures: c.built.pack.measures.length, examples: c.built.pack.examples.length } });
      }
      if (path === "/" && req.method === "PUT") {
        const b = await body();
        if ("error" in b) return send(400, { error: b.error });
        const asked = layerFromBody(b);
        if ("problems" in asked) return refused("edit", { status: 400, problems: asked.problems });
        try {
          const result = await change(asked.layer, { by: who.user, action: "edit", why: why(b), ifVersion: ifVersion(b) });
          if (!result.ok) return refused("edit", result);
          audit("pack edit", `version ${result.version.version}: ${result.version.summary}${result.version.why ? ` (${result.version.why})` : ""}`);
          return done(result);
        } catch (e) {
          return saveError(e);
        }
      }
      // Every version, newest first (?limit=, default 50); version 0 is the deploy config alone.
      if (path === "/versions" && req.method === "GET") {
        const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit")) || 50, 200));
        const all = o.store.versions().reverse();
        return send(200, { current: current.version, total: all.length, versions: all.slice(0, limit).map(versionView) });
      }
      const one = /^\/versions\/(\d+)$/.exec(path);
      if (one && req.method === "GET") {
        const v = o.store.get(Number(one[1]));
        if (!v) return send(404, { error: `no version ${one[1]}` });
        return send(200, { ...versionView(v), layer: v.layer, yaml: yamlOf(v.layer as PackLayer), current: v.version === current.version });
      }
      // What differs between two versions, part by part (default: the version before `to`, and the one in force).
      if (path === "/diff" && req.method === "GET") {
        const to = url.searchParams.has("to") ? Number(url.searchParams.get("to")) : current.version;
        const from = url.searchParams.has("from") ? Number(url.searchParams.get("from")) : Math.max(0, to - 1);
        const a = Number.isInteger(from) ? o.store.get(from) : undefined;
        const z = Number.isInteger(to) ? o.store.get(to) : undefined;
        if (!a || !z) return send(404, { error: `no version ${!a ? from : to}` });
        const x = packRuntimeView(base, a.layer as PackLayer);
        const y = packRuntimeView(base, z.layer as PackLayer);
        const fields = PACK_RUNTIME_FIELDS.filter((f) => !sameValue(x[f], y[f])).map((f) => ({ field: f, from: x[f] ?? null, to: y[f] ?? null }));
        return send(200, { from, to, fields });
      }
      // Goes back to a version: a new version with that one's layer, checked like any change.
      if (path === "/revert" && req.method === "POST") {
        const b = await body();
        if ("error" in b) return send(400, { error: b.error });
        const target = Number.isInteger(b.version) ? o.store.get(b.version as number) : undefined;
        if (!target) return send(Number.isInteger(b.version) ? 404 : 400, { error: Number.isInteger(b.version) ? `no version ${String(b.version)}` : 'send { "version": <n> } (0: the deploy config alone)' });
        try {
          const result = await change(target.layer as PackLayer, { by: who.user, action: "revert", why: why(b), reverts: target.version, ifVersion: header });
          if (!result.ok) return refused("revert", result);
          audit("pack revert", `version ${result.version.version}: ${result.version.summary}${result.version.why ? ` (${result.version.why})` : ""}`);
          return done(result);
        } catch (e) {
          return saveError(e);
        }
      }
      // Hands parts (or all) back to the deploy config.
      if (path === "/reset" && req.method === "POST") {
        const b = await body();
        if ("error" in b) return send(400, { error: b.error });
        const fields = b.fields === undefined || b.fields === null ? null : Array.isArray(b.fields) ? b.fields.map(String) : undefined;
        if (fields === undefined) return send(400, { error: 'send { "fields": ["labels", …] }, or {} for every part' });
        const unknown = (fields ?? []).filter((f) => !(PACK_RUNTIME_FIELDS as readonly string[]).includes(f));
        if (unknown.length) return refused("reset", { status: 400, problems: unknown.map((f) => (PACK_CONFIG_FIELDS[f] ? `${f} is set in the deploy config only (${PACK_CONFIG_FIELDS[f]})` : `${f} is not a part of the pack that can be changed here (${PACK_RUNTIME_FIELDS.join(", ")})`)) });
        const layer = fields ? (Object.fromEntries(Object.entries(current.layer).filter(([k]) => !fields.includes(k))) as PackLayer) : {};
        try {
          const result = await change(layer, { by: who.user, action: "reset", why: why(b), ifVersion: header });
          if (!result.ok) return refused("reset", result);
          audit("pack reset", `version ${result.version.version}: ${result.version.summary}${result.version.why ? ` (${result.version.why})` : ""}`);
          return done(result);
        } catch (e) {
          return saveError(e);
        }
      }
      // The whole overlay as YAML, to write back into the deploy config (?version=<n> for an earlier one).
      if (path === "/export" && req.method === "GET") {
        const v = url.searchParams.has("version") ? Number(url.searchParams.get("version")) : undefined;
        const text = v === undefined || Number.isInteger(v) ? exportYaml(v) : null;
        if (text === null) return send(404, { error: `no version ${url.searchParams.get("version")}` });
        const name = `overlay-v${v ?? current.version}.yaml`;
        res.writeHead(200, { "content-type": "text/yaml; charset=utf-8", "content-disposition": `${url.searchParams.get("download") ? "attachment" : "inline"}; filename="${name}"`, ...NO_STORE });
        res.end(text);
        return true;
      }
      return send(405, { error: "not a method this route takes" });
    };
  }

  return { start, live: now, check: checkLayer, change, routes, exportYaml };
}

export type PackRuntime = ReturnType<typeof packRuntime>;
