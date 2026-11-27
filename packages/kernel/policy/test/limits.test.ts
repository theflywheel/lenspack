// Per-person question limits: a daily quota and sliding minute and hour windows, decided from the counts a host keeps.
import { describe, expect, it } from "vitest";

import { decideQuestion, limitLanguage, limitMessage, questionLimitsFor, limitsOn, perUserLimitsFrom } from "../src";

const now = Date.parse("2026-11-27T10:00:00Z");
const facts = (o: Partial<Parameters<typeof decideQuestion>[1]> = {}) => ({ user: "olu", admin: false, today: 0, recent: [], now, ...o });

describe("per-person limits", () => {
  it("off by default: nothing set lets everything through", () => {
    expect(limitsOn({})).toBe(false);
    expect(decideQuestion({}, facts({ today: 10_000, recent: Array(500).fill(now) }))).toEqual({ ok: true });
    expect(limitsOn({ perMinute: 0, questionsPerDay: 0 })).toBe(false);
    expect(limitsOn({ users: { ada: { perHour: 5 } } })).toBe(true);
  });

  it("the daily quota frees up at midnight UTC", () => {
    expect(decideQuestion({ questionsPerDay: 3 }, facts({ today: 2 }))).toEqual({ ok: true });
    const r = decideQuestion({ questionsPerDay: 3 }, facts({ today: 3 }));
    expect(r).toMatchObject({ ok: false, limit: "questionsPerDay", max: 3, retryAfterSeconds: 14 * 3600, freeAt: "2026-11-28T00:00:00.000Z" });
  });

  it("a sliding minute: a burst is allowed, the next waits until the oldest in the window is a minute old", () => {
    const l = { perMinute: 3 };
    expect(decideQuestion(l, facts({ recent: [now - 2000, now - 1000] }))).toEqual({ ok: true });
    const r = decideQuestion(l, facts({ recent: [now - 50_000, now - 2000, now - 1000] }));
    expect(r).toMatchObject({ ok: false, limit: "perMinute", max: 3, retryAfterSeconds: 10 });
    // Older than a minute: out of the window.
    expect(decideQuestion(l, facts({ recent: [now - 61_000, now - 2000, now - 1000] }))).toEqual({ ok: true });
  });

  it("the hour window, and when several are reached, the one that frees up last", () => {
    const recent = Array.from({ length: 10 }, (_, i) => now - 30 * 60_000 + i * 1000);
    expect(decideQuestion({ perHour: 10 }, facts({ recent }))).toMatchObject({ limit: "perHour", retryAfterSeconds: 30 * 60 });
    const burst = [now - 3000, now - 2000, now - 1000];
    expect(decideQuestion({ perMinute: 3, perHour: 3 }, facts({ recent: burst }))).toMatchObject({ limit: "perHour" });
    expect(decideQuestion({ perMinute: 3, questionsPerDay: 1 }, facts({ recent: burst, today: 1 }))).toMatchObject({ limit: "questionsPerDay" });
  });

  it("admins are held to the limits unless exempt", () => {
    expect(decideQuestion({ questionsPerDay: 1 }, facts({ admin: true, today: 1 }))).toMatchObject({ ok: false });
    expect(decideQuestion({ questionsPerDay: 1, adminsExempt: true }, facts({ admin: true, today: 1 }))).toEqual({ ok: true });
    expect(decideQuestion({ questionsPerDay: 1, adminsExempt: true }, facts({ today: 1 }))).toMatchObject({ ok: false });
  });

  it("a named person's own limits replace everyone's, field by field", () => {
    const l = { questionsPerDay: 10, perMinute: 2, users: { ada: { questionsPerDay: 100 } } };
    expect(questionLimitsFor(l, "ada")).toEqual({ questionsPerDay: 100, perMinute: 2, perHour: 0 });
    expect(questionLimitsFor(l, "olu")).toEqual({ questionsPerDay: 10, perMinute: 2, perHour: 0 });
    expect(questionLimitsFor(l, "constructor")).toEqual({ questionsPerDay: 10, perMinute: 2, perHour: 0 });
    expect(decideQuestion(l, facts({ user: "ada", today: 50 }))).toEqual({ ok: true });
  });

  it("values are checked: whole numbers from 0, known keys", () => {
    expect(perUserLimitsFrom({ questionsPerDay: 200, perMinute: 5, adminsExempt: true })).toEqual({ questionsPerDay: 200, perMinute: 5, adminsExempt: true });
    expect(() => perUserLimitsFrom({ perMinute: -1 })).toThrow(/whole number from 0/);
    expect(() => perUserLimitsFrom({ perMinute: 2.5 })).toThrow(/whole number/);
    expect(() => perUserLimitsFrom({ perSecond: 1 })).toThrow(/unknown setting "perSecond"/);
    expect(() => perUserLimitsFrom({ adminsExempt: "yes" })).toThrow(/true or false/);
    expect(() => perUserLimitsFrom({ users: { ada: { perDay: 1 } } })).toThrow(/users\.ada: unknown setting/);
  });

  it("the message says which limit and when, in the reader's language", () => {
    expect(limitMessage({ limit: "perMinute", max: 5, retryAfterSeconds: 40 })).toBe("You have asked 5 questions in the last minute, the most allowed per person. You can ask again in 40 seconds.");
    expect(limitMessage({ limit: "perHour", max: 1, retryAfterSeconds: 600 }, "en")).toMatch(/asked 1 question in the last hour.*in 10 minutes\.$/);
    expect(limitMessage({ limit: "questionsPerDay", max: 50, retryAfterSeconds: 5 * 3600 }, "fr")).toBe("Vous avez posé 50 questions aujourd'hui, le maximum autorisé par personne et par jour. Vous pourrez en poser de nouveau après minuit UTC, dans 5 heures.");
    expect(limitMessage({ limit: "perMinute", max: 5, retryAfterSeconds: 40 }, "pt")).toMatch(/^Fez 5 perguntas no último minuto.*40 segundos\.$/);
    expect(limitMessage({ limit: "perMinute", max: 5, retryAfterSeconds: 40 }, "hi")).toMatch(/5 सवाल.*40 सेकंड/);
    expect(limitLanguage("auto", "fr", "en")).toBe("fr");
    expect(limitLanguage(undefined, undefined, "pt-PT,pt;q=0.9")).toBe("pt");
    expect(limitLanguage("de", "zz")).toBe("en");
  });
});
