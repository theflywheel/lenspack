import { describe, expect, it } from "vitest";

import { examplesByLanguage, examplesFor, examplesForPack, questionIn } from "../src/examples";

const config = [
  { question: { en: "Visits by site", fr: "Visites par site", hi: "साइट के अनुसार विज़िट" }, query: { kind: "breakdown" } },
  { question: "Visits per day", query: { kind: "series" } },
  { question: { en: "Top site", fr: "Meilleur site" }, query: { kind: "breakdown" } },
];

describe("suggested questions by language", () => {
  it("lists each language the config wrote, a missing wording falling back to English", () => {
    expect(examplesByLanguage(config)).toEqual({
      en: ["Visits by site", "Visits per day", "Top site"],
      fr: ["Visites par site", "Visits per day", "Meilleur site"],
      hi: ["साइट के अनुसार विज़िट", "Visits per day", "Top site"],
    });
  });

  it("keeps a plain list as English only, and drops empty questions", () => {
    expect(examplesByLanguage([{ question: "A" }, { question: "" }, {}])).toEqual({ en: ["A"] });
    expect(examplesByLanguage(undefined)).toEqual({ en: [] });
  });

  it("answers one language for a client that asks, English when it isn't written", () => {
    const by = examplesByLanguage(config);
    expect(examplesFor(by, "fr-FR")[0]).toBe("Visites par site");
    expect(examplesFor(by, "de")).toEqual(by.en);
    expect(examplesFor(by, null)).toEqual(by.en);
  });

  it("gives the pack one string per question (English, else the first written)", () => {
    expect(examplesForPack(config).map((e) => e.question)).toEqual(["Visits by site", "Visits per day", "Top site"]);
    expect(questionIn({ fr: "Seulement en français" })).toBe("Seulement en français");
    expect(examplesForPack(config)[0]!.query).toEqual({ kind: "breakdown" });
  });

  it("gives the pack every other language's words as wordings of the same checked query", () => {
    const pack = examplesForPack(config);
    expect(pack[0]!.wordings).toEqual(["Visites par site", "साइट के अनुसार विज़िट"]);
    expect(pack[1]).not.toHaveProperty("wordings");
    expect(pack[2]!.wordings).toEqual(["Meilleur site"]);
  });
});
