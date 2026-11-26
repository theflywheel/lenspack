// Who may make, copy and delete their own dashboards, and save and apply layouts: decided here, from what
// the host says, never from the rights of the account Lenspack acts through.
import { describe, expect, it } from "vitest";

import { type EditScope, EDIT_SCOPE_DEFAULT, boardRights, editScopeFacts, hiddenPersonalBoards, inEditScope, principalOf, NOBODY_EDITS_MESSAGE, NOT_OWN_MESSAGE, PERSONAL_DEFAULTS, editScopeFrom, editScopeWarning, layoutsShownTo, mayApplyLayout, mayCopyDashboard, mayCreateDashboard, mayDeleteDashboard, mayManageLayout, maySaveLayout, mayViewAllPersonal, personalLimitsFrom } from "../src";

const on = PERSONAL_DEFAULTS;
const off = { ...on, on: false };
const olu = { user: "olu", userId: 5, roles: [], writes: true };
const ada = { user: "ada", userId: 1, roles: ["admin"], writes: true };

describe("own dashboards", () => {
  it("anyone with a host id may make one, up to the limit", () => {
    expect(mayCreateDashboard(olu, on, 0)).toEqual({ ok: true });
    expect(mayCreateDashboard(olu, on, 20)).toMatchObject({ ok: false, code: "limit" });
    expect(mayCreateDashboard({ user: "olu", writes: true }, on, 0)).toMatchObject({ ok: false, code: "no-user-id" });
    expect(mayCreateDashboard(ada, off, 0)).toMatchObject({ ok: false, code: "off" });
  });

  it("a copy only of a dashboard they may view", () => {
    expect(mayCopyDashboard(olu, on, 0, { view: true })).toEqual({ ok: true });
    expect(mayCopyDashboard(olu, on, 0, { view: false })).toMatchObject({ ok: false, code: "no-view" });
    expect(mayCopyDashboard(ada, on, 0, { view: false })).toMatchObject({ ok: false, code: "no-view" });
  });

  it("deleted by an owner or an admin, never anyone else", () => {
    expect(mayDeleteDashboard(olu, on, { owners: [5, 9] })).toEqual({ ok: true });
    expect(mayDeleteDashboard(olu, on, { owners: [9] })).toMatchObject({ ok: false, code: "not-yours" });
    expect(mayDeleteDashboard(olu, on, { owners: [9], personal: true })).toMatchObject({ ok: false, code: "not-yours" });
    expect(mayDeleteDashboard({ user: "olu", writes: true }, on, { owners: [5] })).toMatchObject({ ok: false, code: "not-yours" });
    expect(mayDeleteDashboard(ada, on, { owners: [9], personal: true })).toEqual({ ok: true });
  });

  it("an admin deletes only personal dashboards: Lenspack's admin role reaches only what Lenspack made", () => {
    expect(mayDeleteDashboard(ada, on, { owners: [9] })).toMatchObject({ ok: false, code: "not-yours", why: expect.stringMatching(/Only its owners can delete it/) });
    expect(mayDeleteDashboard(ada, on, { owners: [9], personal: false })).toMatchObject({ ok: false, code: "not-yours" });
  });
});

describe("without the host's right to write dashboards", () => {
  const reader = { user: "rae", userId: 7, roles: [] };
  const readerAdmin = { user: "kemi", userId: 8, roles: ["admin"], writes: false };
  it("makes, copies, deletes and applies nothing, admin or not, and says why", () => {
    for (const who of [reader, readerAdmin]) {
      expect(mayCreateDashboard(who, on, 0)).toMatchObject({ ok: false, code: "no-write", why: expect.stringMatching(/view dashboards but not make or change them/) });
      expect(mayCopyDashboard(who, on, 0, { view: true })).toMatchObject({ ok: false, code: "no-write" });
      expect(mayDeleteDashboard(who, on, { owners: [who.userId], personal: true })).toMatchObject({ ok: false, code: "no-write" });
      expect(mayApplyLayout(who, on, { owner: who.user }, { edit: true })).toMatchObject({ ok: false, code: "no-write" });
    }
    // Saving a layout writes nothing to the host: still theirs to do.
    expect(maySaveLayout(reader, on, 0, { view: true })).toEqual({ ok: true });
  });
});

describe("saved layouts", () => {
  it("saved from a dashboard they may view, up to the limit; a save under an existing name replaces", () => {
    expect(maySaveLayout(olu, on, 0, { view: true })).toEqual({ ok: true });
    expect(maySaveLayout(olu, on, 0, { view: false })).toMatchObject({ code: "no-view" });
    expect(maySaveLayout(olu, on, 50, { view: true })).toMatchObject({ code: "limit" });
    expect(maySaveLayout(olu, on, 50, { view: true }, true)).toEqual({ ok: true });
  });

  it("applied only by their owner (or an admin), and only where they may edit", () => {
    expect(mayApplyLayout(olu, on, { owner: "olu" }, { edit: true })).toEqual({ ok: true });
    expect(mayApplyLayout(olu, on, { owner: "olu" }, { edit: false })).toMatchObject({ code: "no-edit" });
    expect(mayApplyLayout(olu, on, { owner: "kim" }, { edit: true })).toMatchObject({ code: "not-yours" });
    expect(mayApplyLayout(ada, on, { owner: "kim" }, { edit: true })).toEqual({ ok: true });
    expect(mayManageLayout(olu, on, { owner: "kim" })).toMatchObject({ code: "not-yours" });
    expect(layoutsShownTo(olu, [{ owner: "olu" }, { owner: "kim" }])).toEqual([{ owner: "olu" }]);
    expect(layoutsShownTo(ada, [{ owner: "olu" }, { owner: "kim" }])).toHaveLength(2);
    expect(mayViewAllPersonal(olu).ok).toBe(false);
    expect(mayViewAllPersonal(ada).ok).toBe(true);
  });
});

describe("limits", () => {
  it("come from the config, the environment winning, and are checked", () => {
    expect(personalLimitsFrom(undefined)).toEqual(PERSONAL_DEFAULTS);
    expect(personalLimitsFrom({ maxDashboardsPerUser: 3, maxSavedConfigsPerUser: 4 })).toMatchObject({ maxDashboardsPerUser: 3, maxSavedLayoutsPerUser: 4 });
    expect(personalLimitsFrom({ maxDashboardsPerUser: 3 }, { LENSPACK_MAX_DASHBOARDS_PER_USER: "7" }).maxDashboardsPerUser).toBe(7);
    expect(() => personalLimitsFrom({ maxDashboardsPerUser: -1 })).toThrow(/whole number/);
  });
});

describe("other people's own dashboards", () => {
  it("are hidden from everyone but their owner and admins, and boardRights keeps them shut", () => {
    const all = [
      { board: "superset-7", owner: "olu", ownerId: 5 },
      { board: "superset-8", owner: "vee", ownerId: 6 },
    ];
    expect(hiddenPersonalBoards(olu, all)).toEqual(["superset-8"]);
    // Matched by the host's user id too, so a renamed user keeps theirs.
    expect(hiddenPersonalBoards({ user: "olu-renamed", userId: 5 }, all)).toEqual(["superset-8"]);
    expect(hiddenPersonalBoards(ada, all)).toEqual([]);
    const who = principalOf({ user: "olu", edit: true, hiddenBoards: hiddenPersonalBoards(olu, all) });
    expect(boardRights(who, { id: "superset-8" })).toEqual({ view: false, edit: false });
    expect(boardRights(who, { id: "superset-7" })).toEqual({ view: true, edit: false });
  });
});

describe("where the chat may edit (boardRights with the edit scope)", () => {
  const own = { scope: "own" as const, adminsExempt: true };
  const strict = { scope: "own" as const, adminsExempt: false };
  // A Superset editor (or admin) on the shared board superset-1, whose own copy is superset-9.
  const editor = (roles: string[], scope: EditScope, personalOn = true) => {
    const facts = editScopeFacts(scope, { own: ["superset-9"], personalOn });
    return principalOf({ user: roles.length ? "ada" : "olu", roles, edit: true, maintain: true, ...(facts ? { editScope: facts } : {}) });
  };
  const shared = { id: "superset-1" };
  const mine = { id: "superset-9" };

  it("superset: wherever the host lets the person edit, never more", () => {
    expect(editScopeFacts(EDIT_SCOPE_DEFAULT, { own: [], personalOn: true })).toBeUndefined();
    expect(boardRights(editor([], EDIT_SCOPE_DEFAULT), shared)).toEqual({ view: true, edit: true });
    expect(boardRights(principalOf({ user: "olu", readOnly: "read only" }), mine).edit).toBe(false);
  });

  it("own: only their own dashboards, even where the host would let them edit; admins exempt unless told otherwise", () => {
    expect(boardRights(editor([], own), mine)).toEqual({ view: true, edit: true });
    expect(boardRights(editor([], own), shared)).toEqual({ view: true, edit: false, readOnly: NOT_OWN_MESSAGE });
    expect(boardRights(editor(["admin"], own), shared)).toEqual({ view: true, edit: true });
    expect(boardRights(editor(["admin"], strict), shared)).toMatchObject({ edit: false, readOnly: NOT_OWN_MESSAGE });
    // The scope narrows, never widens: a viewer stays read-only on their own board's neighbours and gains nothing.
    const viewer = principalOf({ user: "olu", editScope: editScopeFacts(own, { own: ["superset-9"], personalOn: true }) });
    expect(boardRights(viewer, shared)).toEqual({ view: true, edit: false });
    // A hidden board stays hidden, own or not.
    expect(boardRights({ ...editor([], own), hiddenBoards: ["superset-9"] }, mine)).toEqual({ view: false, edit: false });
  });

  it("own with personal dashboards off: nobody but exempt admins, and the admin is warned", () => {
    expect(boardRights(editor([], own, false), mine)).toEqual({ view: true, edit: false, readOnly: NOBODY_EDITS_MESSAGE });
    expect(boardRights(editor(["admin"], own, false), shared).edit).toBe(true);
    expect(boardRights(editor(["admin"], strict, false), shared)).toMatchObject({ edit: false, readOnly: NOBODY_EDITS_MESSAGE });
    expect(inEditScope({ roles: [] }, "superset-1")).toBe(true);
    expect(editScopeWarning(own, { personalOn: false, editsOn: true })).toMatch(/nobody but admins/);
    expect(editScopeWarning(strict, { personalOn: false, editsOn: true })).toMatch(/nobody can/);
    expect(editScopeWarning(own, { personalOn: true, editsOn: true })).toBeNull();
    expect(editScopeWarning(EDIT_SCOPE_DEFAULT, { personalOn: false, editsOn: true })).toBeNull();
    // Edits switched off already says nobody edits: no second warning.
    expect(editScopeWarning(own, { personalOn: false, editsOn: false })).toBeNull();
  });

  it("comes from the config and the environment, checked", () => {
    expect(editScopeFrom(undefined)).toEqual(EDIT_SCOPE_DEFAULT);
    expect(editScopeFrom("own")).toEqual({ scope: "own", adminsExempt: true });
    expect(editScopeFrom({ scope: "own", adminsExempt: false })).toEqual({ scope: "own", adminsExempt: false });
    expect(editScopeFrom("superset", { LENSPACK_EDIT_SCOPE: "own", LENSPACK_EDIT_SCOPE_ADMINS_EXEMPT: "false" })).toEqual({ scope: "own", adminsExempt: false });
    expect(() => editScopeFrom("mine")).toThrow(/"superset" or "own"/);
    expect(() => editScopeFrom({ adminsExempt: "perhaps" })).toThrow(/true or false/);
  });
});
