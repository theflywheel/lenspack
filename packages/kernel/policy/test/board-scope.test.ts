// Which boards the assistant works on at all: every board the host allows ("any"), or only the deployment's listed
// boards and the copies of them people made ("listed"). Decided here; hosts only ask.
import { describe, expect, it } from "vitest";

import { BOARD_SCOPES, boardGrant, boardRights, boardScopeFrom, boardScopeLine, boardsInScope, decide, inBoardScope, principalOf } from "../src";
import type { Pack } from "@lenspack/pack";

describe("the board scope setting", () => {
  it('is "any" unless set, and "listed" needs a list', () => {
    expect(BOARD_SCOPES).toEqual(["any", "listed"]);
    expect(boardScopeFrom(undefined, [])).toEqual({ scope: "any" });
    expect(boardScopeFrom("", ["b1"])).toEqual({ scope: "any" });
    expect(boardScopeFrom(" Any ", ["b1"])).toEqual({ scope: "any" });
    expect(boardScopeFrom("listed", ["b2", "b1", "b2"])).toEqual({ scope: "listed", boards: ["b2", "b1"] });
  });

  it("refuses an unknown value, naming the allowed ones, and an empty list", () => {
    expect(() => boardScopeFrom("some", ["b1"], { scope: "dashboardScope", list: "dashboards" })).toThrow('dashboardScope must be "any" or "listed", not "some"');
    expect(() => boardScopeFrom("listed", [], { scope: "dashboardScope", list: "dashboards" })).toThrow(/dashboardScope is "listed" but dashboards lists none/);
  });

  it("says itself in one line", () => {
    expect(boardScopeLine({ scope: "any" })).toBe("any");
    expect(boardScopeLine({ scope: "listed", boards: ["s-25", "s-31"] }, (b) => b.slice(2))).toBe("listed (25, 31)");
  });
});

describe("boardsInScope", () => {
  const listed = { scope: "listed" as const, boards: ["d25", "d31"] };
  const made = [
    { board: "copy25", from: "d25" },
    { board: "copyOfCopy", from: "copy25" },
    { board: "blank", from: null },
    { board: "copy40", from: "d40" },
    { board: "copyOf40copy", from: "copy40" },
    // Records that loop should never exist; if they do, they count as out.
    { board: "loopA", from: "loopB" },
    { board: "loopB", from: "loopA" },
  ];

  it("is no limit under any", () => {
    expect(boardsInScope({ scope: "any" }, made, { personalOn: true })).toBeUndefined();
  });

  it("is the listed boards only while people's own dashboards are off", () => {
    expect(boardsInScope(listed, made)).toEqual(["d25", "d31"]);
    expect(boardsInScope(listed, made, { personalOn: false })).toEqual(["d25", "d31"]);
  });

  it("adds copies of listed boards (and copies of those) and blank ones, never copies of others", () => {
    expect(boardsInScope(listed, made, { personalOn: true })).toEqual(["blank", "copy25", "copyOfCopy", "d25", "d31"]);
  });

  it("is asked through the caller's onlyBoards", () => {
    expect(inBoardScope({}, "anything")).toBe(true);
    expect(inBoardScope({ onlyBoards: ["d25"] }, "d25")).toBe(true);
    expect(inBoardScope({ onlyBoards: ["d25"] }, "d40")).toBe(false);
  });
});

describe("a caller limited to some boards", () => {
  const who = principalOf({ user: "olu", roles: ["admin"], edit: true, maintain: true, onlyBoards: ["d25"] }, { editors: [], maintainers: [], admins: ["role:admin"] });

  it("keeps onlyBoards through principalOf", () => {
    expect(who.onlyBoards).toEqual(["d25"]);
    expect(principalOf(who)).toEqual(who);
  });

  it("may neither open nor change a board out of scope, admins included", () => {
    expect(boardRights(who, { id: "d25" })).toMatchObject({ view: true, edit: true });
    expect(boardRights(who, { id: "d40" })).toEqual({ view: false, edit: false });
    expect(boardRights(who, { id: "mine", owner: "olu" })).toEqual({ view: false, edit: false });
  });

  it("gets no board grant out of scope", () => {
    const grant = { hiddenEntities: ["orders"], boardEntities: { d25: { entities: ["orders"] }, d40: { entities: ["orders"] } } };
    expect(boardGrant({ ...grant, onlyBoards: ["d25"] }, "d25")).toEqual({ entities: ["orders"], scope: [] });
    expect(boardGrant({ ...grant, onlyBoards: ["d25"] }, "d40")).toBeNull();
    const pack = { pack: "p", entities: { orders: {} }, dimensions: [], measures: [{ key: "n", entity: "orders" }], examples: [] } as unknown as Pack;
    expect(decide(principalOf({ user: "olu", ...grant, onlyBoards: ["d25"] }), pack, { board: "d40" })!.ctx.hiddenEntities).toEqual(new Set(["orders"]));
  });
});
