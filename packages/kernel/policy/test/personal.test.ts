// Who may make, copy and delete their own dashboards, and save and apply layouts: decided here, from what
// the host says, never from the rights of the account Lenspack acts through.
import { describe, expect, it } from "vitest";

import { PERSONAL_DEFAULTS, layoutsShownTo, mayApplyLayout, mayCopyDashboard, mayCreateDashboard, mayDeleteDashboard, mayManageLayout, maySaveLayout, mayViewAllPersonal, personalLimitsFrom } from "../src";

const on = PERSONAL_DEFAULTS;
const off = { ...on, on: false };
const olu = { user: "olu", userId: 5, admin: false };
const ada = { user: "ada", userId: 1, admin: true };

describe("own dashboards", () => {
  it("anyone with a host id may make one, up to the limit", () => {
    expect(mayCreateDashboard(olu, on, 0)).toEqual({ ok: true });
    expect(mayCreateDashboard(olu, on, 20)).toMatchObject({ ok: false, code: "limit" });
    expect(mayCreateDashboard({ user: "olu", admin: false }, on, 0)).toMatchObject({ ok: false, code: "no-user-id" });
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
    expect(mayDeleteDashboard({ user: "olu", admin: false }, on, { owners: [5] })).toMatchObject({ ok: false, code: "not-yours" });
    expect(mayDeleteDashboard(ada, on, { owners: [9] })).toEqual({ ok: true });
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
