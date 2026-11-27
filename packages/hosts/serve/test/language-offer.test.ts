// The languages a deployment offers in the chat menu: how language.offer and LENSPACK_LANGUAGES are read, and the
// rule that the default and board languages must be among them.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { adminSettings, parseOffer } from "../src/admin.js";

const dir = () => mkdtempSync(join(tmpdir(), "lp-offer-"));
const offer = (config: Record<string, unknown> = {}, env: Record<string, string> = {}) => adminSettings(dir(), config as never, env).languageView(true);

describe("the offered languages", () => {
  it("are all four by default", () => {
    expect(offer()).toMatchObject({ offer: ["en", "fr", "hi", "pt"], options: ["auto", "en", "fr", "hi", "pt"] });
  });

  it("come from language.offer, and LENSPACK_LANGUAGES wins over it", () => {
    expect(offer({ language: { offer: ["pt", "en"] } })).toMatchObject({ offer: ["en", "pt"], options: ["auto", "en", "pt"] });
    expect(offer({ language: { offer: ["en"] } }, { LENSPACK_LANGUAGES: "en, fr,pt" }).offer).toEqual(["en", "fr", "pt"]);
  });

  it("refuse an unknown or empty list", () => {
    expect(parseOffer("en,xx", "LENSPACK_LANGUAGES")).toEqual({ error: "LENSPACK_LANGUAGES: xx is not one of en, fr, hi, pt" });
    expect(parseOffer([], "language.offer")).toMatchObject({ error: expect.stringContaining("at least one") });
    expect(() => offer({ language: { offer: ["en", "de"] } })).toThrow(/language.offer: de is not one of/);
  });

  it("refuse a default or board language that is not offered, at start", () => {
    expect(() => offer({ language: { default: "hi" } }, { LENSPACK_LANGUAGES: "en,fr,pt" })).toThrow(/language.default \(hi\) must be one of the offered languages/);
    expect(() => offer({ language: { board: "hi" } }, { LENSPACK_LANGUAGES: "en,fr,pt" })).toThrow(/language.board \(hi\)/);
    expect(offer({ language: { default: "auto", board: "fr" } }, { LENSPACK_LANGUAGES: "fr" })).toMatchObject({ default: "auto", offer: ["fr"] });
  });
});
