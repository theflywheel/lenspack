// @vitest-environment jsdom
// The chat's markdown renderer (web/chat.js): what model text becomes in the DOM.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

type Chat = { markdown: (text: string) => DocumentFragment };
let md: (text: string) => HTMLElement;

beforeAll(() => {
  const src = readFileSync(join(__dirname, "..", "web", "chat.js"), "utf8");
  new Function(src)();
  const chat = (window as unknown as { LenspackChat: Chat }).LenspackChat;
  md = (text) => {
    const div = document.createElement("div");
    div.append(chat.markdown(text));
    return div;
  };
});

describe("chat markdown", () => {
  it("never turns model text into HTML", () => {
    const out = md('<img src=x onerror="alert(1)"> and <script>alert(2)</script> **<b>bold</b>**');
    expect(out.querySelector("img, script, b")).toBeNull();
    expect(out.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(out.querySelector("strong")?.textContent).toBe("<b>bold</b>");
  });

  it("links only to http(s), opening safely", () => {
    const out = md("[docs](https://example.org/a) and [bad](javascript:alert(1)) and [data](data:text/html,x)");
    const links = out.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute("href")).toBe("https://example.org/a");
    expect(links[0]!.rel).toBe("noopener noreferrer");
    expect(links[0]!.target).toBe("_blank");
    expect(out.textContent).toContain("bad");
    expect(out.innerHTML).not.toContain("javascript:");
  });

  it("bold, italic, code and nesting", () => {
    const out = md("**Ward A** has *very* low `children_coverage_pct`; **bold with *italic* inside**");
    expect(out.querySelectorAll("strong")).toHaveLength(2);
    expect(out.querySelector("strong em")?.textContent).toBe("italic");
    expect(out.querySelector("code")?.textContent).toBe("children_coverage_pct");
  });

  it("leaves snake_case names alone", () => {
    const out = md("Use doses_administered or children_reached_total here.");
    expect(out.querySelector("em")).toBeNull();
    expect(out.textContent).toBe("Use doses_administered or children_reached_total here.");
  });

  it("lists, with one level of nesting", () => {
    const out = md("Top wards:\n- **North**: 12\n- South: 9\n  - Ward 3: 4\n\n1. first\n2. second");
    expect(out.querySelector("p")?.textContent).toBe("Top wards:");
    expect(out.querySelectorAll("ul > li")).toHaveLength(3);
    expect(out.querySelector("ul li ul li")?.textContent).toBe("Ward 3: 4");
    expect(out.querySelectorAll("ol > li")).toHaveLength(2);
  });

  it("compact tables, numbers right-aligned", () => {
    const out = md("| Region | Doses | Coverage |\n|---|---:|---|\n| North | 1,240 | 93.8% |\n| South | 980 | 91.2% |");
    const t = out.querySelector("table")!;
    expect(t.querySelectorAll("th")).toHaveLength(3);
    expect(t.querySelectorAll("tbody tr")).toHaveLength(2);
    const [region, doses, cov] = Array.from(t.querySelectorAll("tbody tr:first-child td"));
    expect(region!.className).toBe("");
    expect(doses!.className).toBe("lpc-num");
    expect(cov!.className).toBe("lpc-num");
    expect(out.querySelector(".lpc-tw > table")).not.toBeNull();
  });

  it("a half-streamed table renders without breaking", () => {
    expect(md("| Region | Doses |").querySelector("table")).toBeNull();
    expect(md("| Region | Doses |\n|---|").querySelector("table")).toBeNull();
    const partial = md("| Region | Doses |\n|---|---|\n| North | 1,2");
    expect(partial.querySelectorAll("tbody td")).toHaveLength(2);
    const short = md("| Region | Doses |\n|---|---|\n| North");
    expect(short.querySelectorAll("tbody td")).toHaveLength(2);
  });

  it("headings become a bold line; unclosed markers stay as text", () => {
    const out = md("## Summary\nText with **unclosed and `open");
    expect(out.querySelector("h2")).toBeNull();
    expect(out.querySelector("p strong")?.textContent).toBe("Summary");
    expect(out.textContent).toContain("**unclosed and `open");
  });

  it("Hindi and French text pass through intact", () => {
    const hi = "**टीकाकरण** कवरेज 93.8% है — वार्ड में बच्चों की संख्या";
    const fr = "Couverture *élevée* à Birnin — enfants vaccinés, âge 3–59 mois";
    const out = md(`${hi}\n\n${fr}`);
    expect(out.querySelector("strong")?.textContent).toBe("टीकाकरण");
    expect(out.querySelector("em")?.textContent).toBe("élevée");
    expect(out.textContent).toContain("वार्ड में बच्चों की संख्या");
    expect(out.textContent).toContain("âge 3–59 mois");
  });
});
