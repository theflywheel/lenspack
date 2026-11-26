// The telemetry switchboard without a host: the defaults, and that each item's switch, each section's and
// telemetry's own stop what they record, leaving switched-off fields out of the record.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CORE_FIELDS, EVENT_TYPES, TELEMETRY_ITEMS, TELEMETRY_GROUPS, type SwitchValues, type TelemetryLine, type TelemetryStore, keptFields, switchDefaults, itemsOn, switchable, switchesYaml, turnTelemetry } from "../src";

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
const ALL = new Set(TELEMETRY_ITEMS.filter(switchable).map((s) => s.id));
const features = { voice: true, cache: true, clarify: true, "review.daily": true };

/** Everything telemetry can record, once: a spoken question with a transcript, its turn, every client event, a transcript never sent. */
async function scenario(on: () => ReadonlySet<string>, master = () => true) {
  let t = Date.parse("2026-11-20T10:00:00Z");
  const store = memoryStore(() => t);
  const tel = turnTelemetry({ store, hash, on: master, items: on, now: () => new Date(t), transcriptWaitMs: 60_000, context: () => ({ "*": { country: "A", campaign: "R1", campaignType: "x" } }) });
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
  t += 120_000;
  await tel.sweep();
  return { lines: store.lines, results };
}

const keysOf = (lines: TelemetryLine[], type: TelemetryLine["type"]) => new Set(lines.filter((l) => l.type === type).flatMap((l) => Object.keys(l)));
const eventsOf = (lines: TelemetryLine[]) => lines.flatMap((l) => (l.type === "event" ? [`${l.event}${l.stage === "after-transcription" ? ":after-transcription" : ""}`] : []));

describe("the switchboard's defaults", () => {
  it("are on, except the privacy-sensitive items: question text, transcript text, kept recordings, device and network detail", () => {
    const d = switchDefaults();
    expect(Object.values(d.groups).every(Boolean)).toBe(true);
    expect(Object.entries(d.items).filter(([, on]) => !on).map(([id]) => id).sort()).toEqual(["device-class", "device-network", "question-text", "transcript-text", "voice-audio"]);
    for (const s of TELEMETRY_ITEMS.filter((x) => !x.default && switchable(x))) expect(s.sensitive).toBeTruthy();
    // Items that cannot be telemetry, and those a feature keeps, have no switch of their own.
    expect(Object.keys(d.items)).not.toContain("speed-time-saved");
    expect(Object.keys(d.items)).not.toContain("review-runs");
  });

  it("are listed, every key, in the config block the docs show", () => {
    const yaml = switchesYaml();
    for (const g of TELEMETRY_GROUPS) expect(yaml).toContain(`    ${g.id}: true`);
    for (const s of TELEMETRY_ITEMS.filter(switchable)) expect(yaml).toContain(`    ${s.id}: ${s.default}`);
    // docs/features/telemetry.md shows this block as it is, so the docs and the catalogue cannot drift apart.
    expect(readFileSync(fileURLToPath(new URL("../../../../docs/features/telemetry.md", import.meta.url)), "utf8")).toContain("```yaml\n" + yaml + "\n```");
  });

  it("record no texts, recordings or device detail out of the box", async () => {
    const { lines } = await scenario(() => itemsOn({ telemetry: true, ...switchDefaults() }, features));
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

describe("each item's switch", () => {
  it("records every field and event with everything on", async () => {
    const { lines } = await scenario(() => ALL);
    expect(eventsOf(lines).sort()).toEqual(["abandoned", "abandoned:after-transcription", "chart-exported", "explain-opened", "feedback", "quick-reply", "transcript"]);
    expect(keysOf(lines, "turn")).toEqual(keptFields("turn", ALL));
  });

  for (const s of TELEMETRY_ITEMS.filter(switchable)) {
    it(`stops ${s.id}: its own fields and events are left out`, async () => {
      const without = new Set([...ALL].filter((id) => id !== s.id));
      const { lines, results } = await scenario(() => without);
      for (const kind of ["turn", "transcript", "event"] as const) {
        // Fields no other item still needs.
        const own = ((s[kind] ?? []) as string[]).filter((f) => !keptFields(kind, without).has(f));
        const got = keysOf(lines, kind);
        for (const f of own) expect(got, `${kind}.${f}`).not.toContain(f);
      }
      for (const e of s.events ?? []) expect(eventsOf(lines)).not.toContain(e);
      // A switched-off event is accepted, and not written.
      if (s.events?.length && s.source === "client-event" && !s.events[0]!.includes(":")) expect(results).toContainEqual({ ok: true, recorded: false });
    });
  }
});

describe("section and telemetry switches", () => {
  const values = (o: Partial<SwitchValues> = {}): SwitchValues => ({ telemetry: true, ...switchDefaults(), ...o });

  it("a section off turns off every item in it, whatever their own switches say", () => {
    const on = itemsOn(values({ groups: { ...switchDefaults().groups, voice: false }, items: Object.fromEntries([...ALL].map((id) => [id, true])) }), features);
    for (const s of TELEMETRY_GROUPS.find((g) => g.id === "voice")!.items) expect(on.has(s.id)).toBe(false);
    expect(on.has("users-active")).toBe(true);
  });

  it("telemetry off turns off everything, and nothing is written", async () => {
    expect(itemsOn(values({ telemetry: false }), features).size).toBe(0);
    const { lines, results } = await scenario(() => ALL, () => false);
    expect(lines).toEqual([]);
    expect(results.every((r) => !r.ok && r.status === 404)).toBe(true);
  });

  it("a section's items with every user item off leave no user names in the records", async () => {
    const on = itemsOn(values({ groups: { ...switchDefaults().groups, users: false } }), features);
    const noNames = new Set([...on].filter((id) => id !== "volume-per-user" && id !== "cost-per-user"));
    const { lines } = await scenario(() => noNames);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => "user" in l)).toBe(false);
  });

  it("a feature that owns an item turns it off with it", () => {
    expect(itemsOn(values(), { ...features, cache: false }).has("reuse-hit-rate")).toBe(false);
    expect(itemsOn(values(), { ...features, voice: false }).has("voice-share")).toBe(false);
    expect(itemsOn(values(), features).has("reuse-hit-rate")).toBe(true);
  });

  it("are read on every record, so a change applies to the next one without a restart", async () => {
    let on: ReadonlySet<string> = ALL;
    let t = Date.parse("2026-11-20T10:00:00Z");
    const store = memoryStore(() => t);
    const tel = turnTelemetry({ store, hash, items: () => on, now: () => new Date(t) });
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

describe("client events", () => {
  it("are only the kinds some item keeps", async () => {
    const tel = turnTelemetry({ store: memoryStore(() => 0), hash, items: () => ALL });
    expect(EVENT_TYPES.sort()).toEqual(["abandoned", "board-shared", "chart-exported", "explain-opened", "feedback", "quick-reply", "transcript"]);
    expect(await tel.event(ana, { type: "made-up" })).toMatchObject({ ok: false, status: 400, error: expect.stringMatching(/not an event/) });
  });

  it("keep only the fields that place them while every other item is off", async () => {
    const only = new Set(["trust-explain"]);
    const { lines } = await scenario(() => only);
    const ev = lines.filter((l) => l.type === "event");
    expect(ev).toHaveLength(1);
    expect(Object.keys(ev[0]!).every((k) => (CORE_FIELDS.event as readonly string[]).includes(k))).toBe(true);
  });
});
