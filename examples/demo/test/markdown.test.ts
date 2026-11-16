import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Markdown, parseBlocks } from "../src/markdown";

const html = (text: string) => renderToStaticMarkup(React.createElement(Markdown, { text }));

describe("the chat's markdown", () => {
  it("renders a reply with bold labels and bullets as paragraphs and lists, not run together", () => {
    const reply = "A campaign has three kinds of record:\n\n**Deliveries (task):** one per visit\n- doses delivered\n- *status* of each visit\n\n**Stock:** `quantity` moved";
    expect(parseBlocks(reply).map((b) => b.kind)).toEqual(["p", "p", "list", "p"]);
    const out = html(reply);
    expect(out).toContain('<strong class="font-semibold text-foreground">Deliveries (task):</strong> one per visit');
    expect(out).toMatch(/<ul[^>]*><li[^>]*>doses delivered<\/li><li[^>]*><em>status<\/em> of each visit<\/li><\/ul>/);
    expect(out).toContain(">quantity</code> moved");
  });

  it("numbers an ordered list from where it starts, and nests one level", () => {
    const out = html("3. third\n4. fourth\n   - a detail");
    expect(out).toMatch(/<ol[^>]*start="3"/);
    expect(out).toMatch(/<li[^>]*>fourth<ul[^>]*><li[^>]*>a detail<\/li><\/ul><\/li>/);
  });

  it("never renders markup from the text, and links only http(s) and mailto, in a new tab", () => {
    const out = html('<img src=x onerror="alert(1)"> **<b>bold</b>** [ok](https://example.org/a) [bad](javascript:alert(1))');
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<b>");
    expect(out).toContain("&lt;img");
    expect(out).toContain('<a href="https://example.org/a" target="_blank" rel="noopener noreferrer"');
    expect(out).not.toContain("javascript:");
  });

  it("turns a heading into a bold line and keeps a code block verbatim", () => {
    expect(html("## Summary\n```\n**not bold**\n```")).toBe(
      '<div class="space-y-2 text-sm leading-6 " data-testid="markdown"><p class="font-semibold text-foreground">Summary</p><pre class="overflow-x-auto rounded bg-muted px-2 py-1.5 font-mono text-xs leading-5">**not bold**</pre></div>',
    );
  });
});
