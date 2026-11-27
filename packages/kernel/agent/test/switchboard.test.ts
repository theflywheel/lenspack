// The telemetry switchboard without a host: the defaults, that each field group's switch and telemetry's own stop
// what they record (leaving switched-off fields out of the record), the category switches, and the older metric and
// section switches read as field switches.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CORE_FIELDS,
  EVENT_TYPES,
  FIELD_CATEGORIES,
  FIELD_GROUPS,
  LEGACY_ITEMS,
  LEGACY_SECTIONS,
  type SwitchValues,
  type TelemetryLine,
  type TelemetryStore,
  categoryChanges,
  categoryState,
  fieldDefaults,
  fieldLock,
  fieldsFromLegacy,
  fieldsOn,
  keptFields,
  legacyChanges,
  resolveFields,
  switchable,
  switchesYaml,
  turnTelemetry,
} from "../src";

function memoryStore(clock: () => number): TelemetryStore & { lines: TelemetryLine[] } {
  const lines: TelemetryLine[] = [];
  const state = new Map<string, { value: unknown; until: number }>();
  const live = (k: string) => {
    const e = state.get(k);
    return e && e.until > clock() ? e : undefined;
  };
  return {
    lines,
    append: async (l) => void lines.push(l),
    find: async (q) => lines.filter((l) => l.at >= q.from.toISOString() && (!q.type || l.type === q.type) && (!q.turnId || ("turnId" in l && l.turnId === q.turnId))).reverse(),
    state: {
      get: async <T>(k: string) => (live(k)?.value as T | undefined) ?? null,
      put: async (k, value, ttl) => void state.set(k, { value, until: clock() + ttl }),
      take: async <T>(k: string) => {
        const e = live(k);
        state.delete(k);
        return (e?.value as T | undefined) ?? null;
      },
      list: async <T>(p: string) => [...state.keys()].filter((k) => k.startsWith(p) && live(k)).map((key) => ({ key, value: state.get(key)!.value as T })),
    },
  };
}

const hash = (t: string) => createHash("sha256").update(`k:${t}`).digest("hex").slice(0, 24);
const ana = { user: "ana", roles: ["Gamma"] };
const ALL = new Set(FIELD_GROUPS.filter(switchable).map((f) => f.id));
const features = { voice: true, cache: true, clarify: true, personalDashboards: true, "review.daily": true };

/** Everything telemetry can record, once: a spoken question with a transcript, its turn, every client event, a transcript never sent. */
async function scenario(on: () => ReadonlySet<string>, master = () => true) {
  let t = Date.parse("2026-11-20T10:00:00Z");
  const store = memoryStore(() => t);
  const tel = turnTelemetry({ store, hash, on: master, fields: on, now: () => new Date(t), transcriptWaitMs: 60_000, context: () => ({ "*": { country: "A", campaign: "R1", campaignType: "x" } }) });
  const heard = (id: string, text: string) => tel.transcribed({ id, who: ana, pack: "p", model: "stt", languageRequested: null, languageDetected: "en", seconds: 2, usd: 0.001, ms: 200, retried: false, text, audio: { stored: true, bytes: 10, format: "webm" } });
  await heard("c1", "how many visit");
  await heard("c2", "never sent");
  const cap = await tel.begin({ turnId: "t1", who: ana, board: "b", pack: "p", question: "how many visits", transcriptIds: ["c1"], newConversation: true, languagePicked: "auto", client: { device: "mobile", network: "3g", viewport: "narrow", saveData: true }, selections: { Region: "North" }, builder: "m", effort: null, readOnly: false, datasetOf: () => undefined });
  cap?.mark({ queueMs: 120, reuse: "exact", reuseSavedUsd: 0.002 });
  cap?.ended({ cost: { total: { usd: 0.01, unpriced: 0, inputTokens: 10, outputTokens: 5 }, models: [{ role: "builder", model: "m", usd: 0.01 }] } });
  await cap?.record();
  const results = [];
  results.push(await tel.event(ana, { type: "feedback", turnId: "t1", rating: "down", reason: "other", comment: "off by one" }));
  results.push(await tel.event(ana, { type: "explain-opened", turnId: "t1" }));
  results.push(await tel.event(ana, { type: "chart-exported", turnId: "t1", choice: "png" }));
  results.push(await tel.event(ana, { type: "quick-reply", turnId: "t1", choice: "doses given" }));
  results.push(await tel.event(ana, { type: "abandoned", turnId: "t1", how: "closed", stage: "streaming" }));
  results.push(await tel.event(ana, { type: "transcript", turnId: "t1", transcript: "how many visit", sent: "how many visits" }));
  // Sent by the host itself (Superset's own dashboards), not about a turn.
  results.push(await tel.event({ ...ana, board: "b1", pack: "p" }, { type: "personal-dashboard", how: "copy", data: { dashboard: 9, from: 1 } }));
  t += 120_000;
  await tel.sweep();
  return { lines: store.lines, results };
}

const keysOf = (lines: TelemetryLine[], type: TelemetryLine["type"]) => new Set(lines.filter((l) => l.type === type).flatMap((l) => Object.keys(l)));
const eventsOf = (lines: TelemetryLine[]) => lines.flatMap((l) => (l.type === "event" ? [`${l.event}${l.stage === "after-transcription" ? ":after-transcription" : ""}`] : []));
const values = (fields: Record<string, boolean> = {}, telemetry = true): SwitchValues => ({ telemetry, fields: { ...fieldDefaults(), ...fields } });

describe("the switchboard's defaults", () => {
  it("are on, except the privacy-sensitive fields: question words, transcript words, recordings, device and network", () => {
    const d = fieldDefaults();
    expect(Object.entries(d).filter(([, on]) => !on).map(([id]) => id).sort()).toEqual(["device-class", "device-network", "question-text", "transcript-text", "voice-audio"]);
    for (const f of FIELD_GROUPS.filter((x) => !x.default && switchable(x))) expect(f.sensitive).toBeTruthy();
    // Fields a feature keeps outright have no switch of their own.
    expect(Object.keys(d)).not.toContain("daily-review");
    expect(Object.keys(d)).not.toContain("open-questions");
  });

  it("are listed, every key, in the config block the docs show", () => {
    const yaml = switchesYaml();
    for (const f of FIELD_GROUPS.filter(switchable)) expect(yaml).toContain(`    ${f.id}: ${f.default}`);
    // docs/features/telemetry.md shows this block as it is, so the docs and the catalogue cannot drift apart.
    expect(readFileSync(fileURLToPath(new URL("../../../../docs/features/telemetry.md", import.meta.url)), "utf8")).toContain("```yaml\n" + yaml + "\n```");
  });

  it("put every record field in exactly one field group, so each field has one switch", () => {
    for (const kind of ["turn", "transcript"] as const) {
      const seen = new Map<string, string>();
      for (const f of FIELD_GROUPS) for (const k of (f[kind] ?? []) as string[]) {
        if (kind === "turn" || !["user", "roles"].includes(k)) expect(seen.get(k), `${kind}.${k} in ${f.id} and ${seen.get(k)}`).toBeUndefined();
        seen.set(k, f.id);
      }
      for (const k of CORE_FIELDS[kind]) expect(seen.has(k), `${kind}.${k} is a core field`).toBe(false);
    }
  });

  it("give every older metric switch field groups that exist, so older settings translate to real fields", () => {
    const ids = new Set(FIELD_GROUPS.map((f) => f.id));
    for (const m of LEGACY_ITEMS) for (const n of [...m.needs, ...(m.by ?? [])]) expect(ids.has(n), `${m.id} reads ${n}`).toBe(true);
  });

  it("record no texts, recordings or device detail out of the box", async () => {
    const { lines } = await scenario(() => fieldsOn(values(), features));
    const text = JSON.stringify(lines);
    expect(text).not.toContain("how many visits");
    expect(text).not.toContain("off by one");
    expect(text).not.toContain("never sent");
    expect(text).not.toContain("North");
    expect(keysOf(lines, "turn")).not.toContain("device");
    expect(keysOf(lines, "turn")).not.toContain("network");
    expect(keysOf(lines, "transcript")).not.toContain("audio");
    // The hashes still count repeats and edits.
    expect(keysOf(lines, "turn")).toContain("questionHash");
    expect(keysOf(lines, "turn")).toContain("transcriptEditDistance");
  });
});

describe("each field group's switch", () => {
  it("records every field and event with everything on", async () => {
    const { lines } = await scenario(() => ALL);
    expect(eventsOf(lines).sort()).toEqual(["abandoned", "abandoned:after-transcription", "chart-exported", "explain-opened", "feedback", "personal-dashboard", "quick-reply", "transcript"]);
    expect(keysOf(lines, "turn")).toEqual(keptFields("turn", ALL));
  });

  for (const f of FIELD_GROUPS.filter(switchable)) {
    it(`stops ${f.id}: its own fields and events are left out`, async () => {
      const without = new Set([...ALL].filter((id) => id !== f.id));
      const { lines, results } = await scenario(() => without);
      for (const kind of ["turn", "transcript", "event"] as const) {
        // Fields no other group still needs.
        const own = ((f[kind] ?? []) as string[]).filter((k) => !keptFields(kind, without).has(k));
        const got = keysOf(lines, kind);
        for (const k of own) expect(got, `${kind}.${k}`).not.toContain(k);
      }
      for (const e of f.events ?? []) expect(eventsOf(lines)).not.toContain(e);
      // A switched-off event is accepted, and not written.
      if (f.events?.length && f.source === "client-event" && !f.events[0]!.includes(":")) expect(results).toContainEqual({ ok: true, recorded: false });
    });
  }
});

describe("telemetry's own switch and the features that own fields", () => {
  it("telemetry off turns off everything, and nothing is written", async () => {
    expect(fieldsOn(values({}, false), features).size).toBe(0);
    const { lines, results } = await scenario(() => ALL, () => false);
    expect(lines).toEqual([]);
    expect(results.every((r) => !r.ok && r.status === 404)).toBe(true);
  });

  it("the user name off leaves no names in the records", async () => {
    const { lines } = await scenario(() => fieldsOn(values({ user: false }), features));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => "user" in l)).toBe(false);
  });

  it("a feature that owns a field turns it off with it", () => {
    expect(fieldsOn(values(), { ...features, cache: false }).has("reuse")).toBe(false);
    expect(fieldsOn(values(), { ...features, voice: false }).has("input")).toBe(false);
    expect(fieldsOn(values(), features).has("reuse")).toBe(true);
  });

  it("are read on every record, so a change applies to the next one without a restart", async () => {
    let on: ReadonlySet<string> = ALL;
    let t = Date.parse("2026-11-20T10:00:00Z");
    const store = memoryStore(() => t);
    const tel = turnTelemetry({ store, hash, fields: () => on, now: () => new Date(t) });
    const ask = async (id: string) => {
      const cap = (await tel.begin({ turnId: id, who: ana, board: null, pack: "p", question: "q one", transcriptIds: [], newConversation: true, languagePicked: null, client: null, builder: "m", effort: null, readOnly: false, datasetOf: () => undefined }))!;
      cap.ended({});
      await cap.record();
    };
    await ask("a");
    on = new Set([...ALL].filter((id) => id !== "question-text"));
    t += 1000;
    await ask("b");
    const [a, b] = store.lines;
    expect(a).toHaveProperty("question", "q one");
    expect(b).not.toHaveProperty("question");
  });
});

describe("category switches", () => {
  const row = (on: boolean, sensitive = false, editable = true) => ({ on, sensitive, editable });

  it("show on, off or mixed from the switches inside, and hold no value of their own", () => {
    expect(categoryState([row(true), row(true)])).toEqual({ state: "on", next: false });
    expect(categoryState([row(false), row(false)])).toEqual({ state: "off", next: true });
    expect(categoryState([row(true), row(false)])).toEqual({ state: "mixed", next: true });
  });

  it("never turn a sensitive switch on: on means every switch that is not sensitive is on", () => {
    // The sensitive one stays off after switching on, and the category reads on, so the next switch turns all off.
    expect(categoryState([row(true), row(false, true)])).toEqual({ state: "on", next: false });
    expect(categoryState([row(false), row(true, true)])).toEqual({ state: "mixed", next: true });
    // A category of sensitive switches only: switching it can turn them off, never on.
    expect(categoryState([row(false, true), row(false, true)])).toEqual({ state: "off", next: null });
    expect(categoryState([row(true, true), row(false, true)])).toEqual({ state: "mixed", next: false });
    expect(categoryState([row(true, true), row(true, true)])).toEqual({ state: "on", next: false });
  });

  it("leave locked switches out, and do nothing when every switch is locked", () => {
    expect(categoryState([row(true), row(false, false, false)])).toEqual({ state: "on", next: false });
    expect(categoryState([row(true, false, false), row(false, false, false)])).toEqual({ state: "mixed", next: null });
  });

  it("change every editable switch, and on, only those that are not sensitive", () => {
    expect(categoryChanges("who", false, () => true)).toEqual(["user", "roles", "context", "conversation", "selections", "device-class", "device-network"]);
    expect(categoryChanges("who", true, () => true)).toEqual(["user", "roles", "context", "conversation", "selections"]);
    expect(categoryChanges("texts", true, () => true)).toEqual([]);
    expect(categoryChanges("happened", true, (f) => f.id !== "reuse")).toEqual(["outcome", "work", "review", "superset-actions"]);
    expect(FIELD_CATEGORIES.map((c) => c.id)).toEqual(["who", "asked", "happened", "cost-speed", "feedback", "voice", "texts"]);
  });

  it("lock a switch whose feature is off, which needs voice, configuration or Superset, or that a feature keeps", () => {
    const by = (id: string) => FIELD_GROUPS.find((f) => f.id === id)!;
    const i = { features, mapped: new Set(["country" as const]), superset: false };
    expect(fieldLock(by("user"), i)).toBe(null);
    expect(fieldLock(by("reuse"), { ...i, features: { ...features, cache: false } })).toEqual({ kind: "feature", feature: "cache", missing: false });
    expect(fieldLock(by("personal-dashboards"), { ...i, features: { voice: true } })).toEqual({ kind: "feature", feature: "personalDashboards", missing: true });
    expect(fieldLock(by("input"), { ...i, features: { ...features, voice: false } })).toEqual({ kind: "voice", feature: "voice" });
    expect(fieldLock(by("context"), { ...i, mapped: new Set() })).toEqual({ kind: "needs-config", context: ["campaign", "campaignType", "country"] });
    expect(fieldLock(by("context"), i)).toBe(null);
    expect(fieldLock(by("superset-actions"), i)).toEqual({ kind: "superset" });
    expect(fieldLock(by("daily-review"), i)).toEqual({ kind: "owned", feature: "review.daily" });
  });
});

describe("the older metric and section switches", () => {
  it("at their defaults stand for the field defaults", () => {
    expect(fieldsFromLegacy({})).toEqual(fieldDefaults());
    expect(legacyChanges({}, {})).toEqual({});
  });

  it("keep their meaning: a field is on while some metric that is on needs it", () => {
    // The privacy-sensitive items kept their ids.
    expect(legacyChanges({}, { items: { "question-text": true, "voice-audio": true } })).toEqual({ "question-text": true, "voice-audio": true });
    expect(legacyChanges({}, { items: { "device-class": true } })).toEqual({ "device-class": true });
    // One metric off changes nothing while others still need its fields.
    expect(legacyChanges({}, { items: { "users-active": false } })).toEqual({});
    // Every metric that needs the user name off: names are no longer recorded.
    const userItems = LEGACY_SECTIONS.flatMap((s) => s.items).filter((i) => LEGACY_ITEMS.find((m) => m.id === i)?.needs.includes("user"));
    expect(legacyChanges({}, { items: Object.fromEntries(userItems.map((i) => [i, false])) })).toEqual({ user: false });
    // A section off: the fields only its metrics needed go off.
    expect(legacyChanges({}, { groups: { speed: false } })).toEqual({ timing: false, queue: false, abandoned: false });
    expect(legacyChanges({}, { groups: { "device-network": false } })).toEqual({});
  });

  it("are a layer under the field switches: the deployment's, then an admin's saved changes", () => {
    const r = resolveFields({ items: { "question-text": true }, fields: { cost: false } }, { groups: { speed: false }, fields: { "question-text": false } });
    expect(r.deployment).toMatchObject({ "question-text": true, cost: false, queue: true });
    expect(r.values).toMatchObject({ "question-text": false, cost: false, timing: false, queue: false, abandoned: false, user: true });
    // A saved older change counts against the deployment's older values, not the catalogue's.
    expect(resolveFields({ groups: { speed: false } }, { groups: { speed: true } }).values).toMatchObject({ queue: true });
  });
});

describe("client events", () => {
  it("are only the kinds some field group keeps", async () => {
    const tel = turnTelemetry({ store: memoryStore(() => 0), hash, fields: () => ALL });
    expect(EVENT_TYPES.sort()).toEqual(["abandoned", "board-shared", "chart-exported", "explain-opened", "feedback", "personal-dashboard", "quick-reply", "saved-layout", "transcript"]);
    expect(await tel.event(ana, { type: "made-up" })).toMatchObject({ ok: false, status: 400, error: expect.stringMatching(/not an event/) });
  });

  it("keep only the fields that place them while every other group is off", async () => {
    const only = new Set(["explain"]);
    const { lines } = await scenario(() => only);
    const ev = lines.filter((l) => l.type === "event");
    expect(ev).toHaveLength(1);
    expect(Object.keys(ev[0]!).every((k) => (CORE_FIELDS.event as readonly string[]).includes(k))).toBe(true);
  });
});
