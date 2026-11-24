import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { catalogueFrom, parsePackText, type Pack } from "@lenspack/pack";
import { describe, expect, it } from "vitest";

import { type Identity, type PackRule, boardRights, decide, hiddenKeys, holds, principalOf } from "../src";

// The policy kernel alone: no server, no source. Who a caller is in, what of
// a pack they may use out. The server tests (serve/test/auth, access) prove
// the same rules end to end.

const campaign = parsePackText(readFileSync(fileURLToPath(new URL("../../../../examples/campaign/pack.yaml", import.meta.url)), "utf8"));
const pack: Pack = {
  ...campaign,
  examples: [
    { question: "Visits by distributor", query: { kind: "breakdown", measure: "visits", dimension: "delivered_by", limit: 10, sort: "desc" } },
    { question: "Visits", query: { kind: "value", measure: "visits" } },
  ] as Pack["examples"],
};
const north = { dimension: "province", op: "eq" as const, value: "North" };
const village = { dimension: "village", op: "eq" as const, value: "V1" };
const reason = { dimension: "not_delivered_reason", op: "eq" as const, value: "away" };
const RULES: PackRule[] = [
  { roles: ["staff"] },
  { roles: ["partner"], hide: ["delivered_by"], scope: [north] },
  { roles: ["auditor"], only: ["province", "visits"] },
];

describe("principalOf", () => {
  it("settles rights: maintain implies edit, usage follows maintain unless set, rights by role only add", () => {
    expect(principalOf({ user: "a" })).toEqual({ user: "a", roles: [], edit: false, usage: false });
    expect(principalOf({ user: "m", maintain: true })).toEqual({ user: "m", roles: [], edit: true, maintain: true, usage: true });
    expect(principalOf({ user: "m", maintain: true, usage: false }).usage).toBe(false);
    const rights = { editors: ["*"], maintainers: ["role:leads"], usage: ["finance"] };
    expect(principalOf({ user: "kofi", roles: ["leads"] }, rights)).toMatchObject({ edit: true, maintain: true, usage: false });
    expect(principalOf({ user: "finance" }, rights)).toMatchObject({ edit: true, usage: true });
    // A role: entry is for roles: a user named like one gets nothing from it.
    expect(principalOf({ user: "role:leads" }, rights).maintain).toBeUndefined();
  });

  it("is idempotent, and keeps the host's limits", () => {
    const once = principalOf({ user: "p", roles: ["x"], tenant: "t", scope: [north], hidden: ["village"], packs: ["campaign"], grants: ["/a"], readOnly: "no" }, { editors: ["*"], maintainers: [] });
    expect(principalOf(once)).toEqual(once);
    expect(once).toMatchObject({ tenant: "t", scope: [north], hidden: ["village"], packs: ["campaign"], grants: ["/a"], readOnly: "no" });
  });
});

describe("decide", () => {
  const as = (roles: string[], extra: Partial<Identity> = {}) => principalOf({ user: "u", roles, ...extra });

  it("is null (404) for a pack the caller may not open: not in their packs, or no rule matches", () => {
    expect(decide(as([], { packs: ["other"] }), pack)).toBeNull();
    expect(decide(as([], { packs: ["other"] }), pack, { name: "other" })).not.toBeNull();
    expect(decide(as(["nobody"]), pack, { rules: RULES })).toBeNull();
    expect(decide(as(["nobody"]), pack)).not.toBeNull();
    expect(decide(as(["nobody"]), pack, { rules: [{ roles: ["*"] }] })).not.toBeNull();
  });

  it("takes the first rule, in the rules' order, that the caller's roles match", () => {
    expect(decide(as(["partner", "staff"]), pack, { rules: RULES })!.hidden.size).toBe(0);
    expect([...decide(as(["partner"]), pack, { rules: RULES })!.hidden]).toEqual(["delivered_by"]);
    const auditor = decide(as(["auditor"]), pack, { rules: RULES })!;
    expect(auditor.hidden.has("province") || auditor.hidden.has("visits")).toBe(false);
    expect(auditor.hidden.has("district")).toBe(true);
  });

  it("only narrows: the pack's scope, then the caller's, then the rule's; the host's hidden keys and the rule's together", () => {
    const d = decide(as(["partner"], { scope: [village], hidden: ["not_delivered_reason"], tenant: "t1" }), pack, { rules: RULES, host: { scope: [reason], now: new Date(0) } })!;
    expect(d.scope).toEqual([reason, village, north]);
    expect([...d.hidden].sort()).toEqual(["delivered_by", "not_delivered_reason"]);
    expect(d.ctx).toEqual({ scope: [reason, village, north], now: new Date(0), tenant: "t1", hidden: d.hidden });
    // A host-hidden measure takes what is computed from it along.
    expect(decide(as([], { hidden: ["households_delivered"] }), pack)!.hidden.has("delivery_rate")).toBe(true);
  });

  it("keeps an entity the host hides: its measures, what is computed from them, and the dimensions only it has", () => {
    const d = decide(as([], { hiddenEntities: ["project"], scope: [{ entity: "task", ...village }] }), pack)!;
    for (const k of ["target_type", "household_target", "household_coverage", "coverage_points"]) expect(d.hidden.has(k)).toBe(true);
    // A conformed dimension the caller can still read elsewhere stays.
    for (const k of ["province", "district", "visits", "delivered_by"]) expect(d.hidden.has(k)).toBe(false);
    expect(d.ctx).toMatchObject({ hiddenEntities: new Set(["project"]), scope: [{ entity: "task", ...village }] });
  });

  it("leaves the context as it was for a caller with no limits", () => {
    const host = { tenant: "t1" };
    const d = decide(as([]), pack, { host })!;
    expect(d.ctx).toEqual(host);
    expect(d.otherTenant).toBe(false);
    expect(d.pack()).toBe(pack);
    expect(d.catalogue(catalogueFrom(pack))).toEqual(catalogueFrom(pack));
  });

  it("refuses a caller of another tenant on a pinned pack, and lets a tenant narrow an unpinned one", () => {
    expect(decide(as([], { tenant: "t2" }), pack, { host: { tenant: "t1" } })!.otherTenant).toBe(true);
    expect(decide(as([], { tenant: "t1" }), pack, { host: { tenant: "t1" } })!.otherTenant).toBe(false);
    expect(decide(as([], { tenant: "t2" }), pack)!.ctx.tenant).toBe("t2");
  });

  it("shows the caller the pack, catalogue and boards without what is hidden", () => {
    const d = decide(as(["partner"]), pack, { rules: RULES })!;
    expect(d.pack().examples.map((e) => e.question)).toEqual(["Visits"]);
    const c = d.catalogue(catalogueFrom(pack));
    expect(c.dimensions.map((x) => x.key)).not.toContain("delivered_by");
    const board = { id: "b", config: { widgets: { w: { query: { kind: "value", measure: "visits", filters: [{ dimension: "delivered_by", op: "in", value: ["Ann"] }] } } } } };
    expect(d.board(board).config.widgets.w.query.filters).toEqual([{ dimension: "delivered_by", op: "in", value: ["(hidden)"] }]);
    expect(d.board(null)).toBeNull();
    // A board filter's default selection on a hidden key is that key's data too.
    const filtered = { config: { widgets: {}, filters: [{ field: "delivered_by", default: { values: ["Ann"] } }, { field: "visit_type", default: { values: ["home"] } }] } };
    expect(d.board(filtered).config.filters).toEqual([{ field: "delivered_by", default: { values: ["(hidden)"] } }, { field: "visit_type", default: { values: ["home"] } }]);
  });

  it("stops at an unknown key, so a typo cannot leave a key showing", () => {
    expect(() => hiddenKeys(pack, { hide: ["deliverd_by"] })).toThrow(/deliverd_by/);
  });
});

describe("boardRights", () => {
  const editor = principalOf({ user: "ann", edit: true, tenant: "t1" });
  const maintainer = principalOf({ user: "mo", maintain: true });

  it("pack boards: everyone reads, maintainers change", () => {
    expect(boardRights(editor, {})).toEqual({ view: true, edit: false });
    expect(boardRights(maintainer, {})).toEqual({ view: true, edit: true });
  });

  it("people's boards: the owner changes; others read them once shared, in the owner's tenant", () => {
    expect(boardRights(editor, { owner: "ann", tenant: "t1" })).toEqual({ view: true, edit: true });
    expect(boardRights(editor, { owner: "ann", tenant: "t2" })).toEqual({ view: false, edit: false });
    expect(boardRights(maintainer, { owner: "ann" })).toEqual({ view: false, edit: false });
    expect(boardRights(maintainer, { owner: "ann", shared: true })).toEqual({ view: true, edit: false });
    expect(boardRights(principalOf({ user: "ann", tenant: "t1" }), { owner: "ann", tenant: "t1" })).toEqual({ view: true, edit: false });
  });
});

describe("holds", () => {
  it("trusts a caller with no grants listed with every one; else only what is listed", () => {
    expect(holds({}, "/x")).toBe(true);
    expect(holds({})).toBe(true);
    expect(holds({ grants: ["/x"] }, "/x")).toBe(true);
    expect(holds({ grants: ["/x"] }, "/y")).toBe(false);
    expect(holds({ grants: [] })).toBe(false);
  });
});
