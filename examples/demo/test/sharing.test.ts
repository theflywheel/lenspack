import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SharePanel, boardGroups, reachedBy, sharedWith } from "../src/sharing";

// The board menu's groups and the share dialog, as the app draws them.

describe("the board menu", () => {
  const boards = [
    { id: "overview", title: "Overview" },
    { id: "b_1", title: "Mine", owner: "alice", shared: true },
    { id: "b_2", title: "Bob's", owner: "bob", shared: true },
    { id: "tmp_1", title: "Preview", owner: "alice" },
  ];

  it("keeps the pack's boards, yours and those shared with you apart, temporary ones out", () => {
    const groups = boardGroups(boards, { user: "alice" });
    expect(groups.map((g) => [g.label, g.boards.map((b) => b.id)])).toEqual([
      ["The pack's boards", ["overview"]],
      ["Yours", ["b_1"]],
      ["Shared with you", ["b_2"]],
    ]);
  });

  it("calls every board someone made yours on an open server, where there is no one to tell apart", () => {
    expect(boardGroups(boards, null).map((g) => g.boards.length)).toEqual([1, 2, 0]);
  });

  it("tells a viewer how someone else's board reached them", () => {
    expect(reachedBy({ everyone: true })).toBe("Shared with everyone");
    expect(reachedBy({ everyone: false })).toBe("Shared with you");
  });
});

describe("the share dialog", () => {
  const html = (sharing: { everyone: boolean; people: string[] }, suggestions: string[] = []) =>
    renderToStaticMarkup(React.createElement(SharePanel, { title: "Mine", owner: "alice", sharing, suggestions, onChange: () => undefined }));

  it("lists who has access, offers names not yet added, and leaves everyone off until asked", () => {
    const out = html({ everyone: false, people: ["bob"] }, ["alice", "bob", "carol"]);
    expect(out).toContain('data-testid="share-person-bob"');
    expect(out).toContain('data-testid="share-suggestion-carol"');
    expect(out).not.toContain('data-testid="share-suggestion-bob"');
    expect(out).not.toContain('data-testid="share-suggestion-alice"');
    const everyone = (markup: string) => /<input type="checkbox"[^>]*data-testid="share-everyone"[^>]*>/.exec(markup)?.[0];
    expect(everyone(out)).toBeDefined();
    expect(everyone(out)).not.toContain("checked");
    expect(everyone(html({ everyone: true, people: [] }))).toContain("checked");
  });

  it("treats a name in any case as the one already there", () => {
    const out = html({ everyone: false, people: ["bob"] }, ["Bob", "ALICE", "carol"]);
    expect(out).not.toContain('data-testid="share-suggestion-Bob"');
    expect(out).not.toContain('data-testid="share-suggestion-ALICE"');
    expect(out).toContain('data-testid="share-suggestion-carol"');
  });

  it("says on its button who the board is shared with", () => {
    expect(sharedWith({ everyone: false, people: [] })).toBe("Share");
    expect(sharedWith({ everyone: false, people: ["bob"] })).toBe("Shared with bob");
    expect(sharedWith({ everyone: false, people: ["bob", "carol"] })).toBe("Shared with 2 people");
    expect(sharedWith({ everyone: true, people: ["bob"] })).toBe("Shared with everyone");
  });
});
