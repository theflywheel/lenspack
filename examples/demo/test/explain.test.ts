import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ExplainBlock } from "../src/explain";

// The serve UI's "How this was worked out": a button with aria-expanded over one collapsed level.
describe("the serve UI's explanation", () => {
  const html = renderToStaticMarkup(
    React.createElement(ExplainBlock, {
      x: {
        sql: true,
        calls: [
          {
            description: "Orders (the pack's approved measure “orders”), over all dates, grouped by channel, top 3 by value.",
            statements: [{ language: "sql", text: "SELECT channel, count(*) FROM t GROUP BY 1 LIMIT 3" }],
            columns: [{ key: "group", label: "Channel" }, { key: "value", label: "Orders" }],
            rows: [["web", 40], ["app", 30]],
            total: 3,
          },
        ],
      },
    }),
  );

  it("starts collapsed, with the words, the SQL and the rows inside", () => {
    expect(html).toMatch(/<button type="button" aria-expanded="false" aria-controls="[^"]+"/);
    expect(html).toContain("How this was worked out");
    expect(html).toMatch(/<div id="[^"]+" hidden=""/);
    expect(html).toContain("grouped by channel, top 3 by value");
    expect(html).toContain("SQL that ran");
    expect(html).toContain("SELECT channel, count(*) FROM t GROUP BY 1 LIMIT 3");
    expect(html).toContain("Showing 2 of 3 rows");
    // Long SQL scrolls inside its own block.
    expect(html).toMatch(/<pre[^>]*class="[^"]*overflow-auto[^"]*whitespace-pre/);
  });
});
