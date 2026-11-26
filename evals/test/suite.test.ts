import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type Rig, exampleRig, serve } from "../harness";
import { stubProvider } from "../stub";
import { type Suite, type TruthFile, loadSuite, shapeRows } from "../suite";
import { runQuestion } from "../suite-run";

// The synthetic suite end to end with the scripted stub: every outcome the
// runner can give, through the real chat endpoint, with no model spend.
const suite: Suite = loadSuite(fileURLToPath(new URL("../suites/commerce.yaml", import.meta.url)));

describe("the commerce suite, played by the stub", () => {
  let rig: Rig;
  let srv: Awaited<ReturnType<typeof serve>>;
  const truth: TruthFile = { suite: suite.suite, computed: "test", questions: {} };

  beforeAll(async () => {
    rig = await exampleRig("commerce", { board: "overview" });
    for (const q of suite.questions) {
      if (!q.truth) continue;
      truth.questions[q.id] = { shape: q.truth.shape, unit: q.truth.unit, value: shapeRows(await rig.sql!(q.truth.sql), q.truth.shape), ...(q.truth.k ? { k: q.truth.k } : {}) };
      if (q.truth.universe_sql) truth.questions[q.id]!.universe = (await rig.sql!(q.truth.universe_sql)).map((r) => String(Object.values(r)[0]));
      if (q.truth.alternatives) truth.questions[q.id]!.alternatives = await Promise.all(q.truth.alternatives.map(async (a) => ({ label: a.label, value: shapeRows(await rig.sql!(a.sql), q.truth!.shape) })));
    }
    srv = await serve(rig, [stubProvider(suite)]);
  });
  afterAll(async () => {
    await srv.close();
    await rig.close();
  });

  const expected: Record<string, string> = {
    C1: "correct",
    C2: "correct",
    C3: "correct",
    C4: "correct",
    C5: "partial",
    C6: "partial",
    C7: "confidently_wrong",
    C8: "correct",
    C9: "correct",
    C10: "correct",
    C11: "correct",
    C12: "correct",
    C13: "declined_ok",
    C14: "confidently_wrong",
    C15: "declined_ok",
    C16: "correct",
    C17: "confidently_wrong",
    C18: "declined_ok",
  };

  // Known product bugs: the test fails until the fix lands, then this list must shrink.
  // (C16, move_widget to "after:<id>" leaving the widget on its old row, was fixed in 062bcb1/158da81.)
  const knownBugs = new Set<string>([]);

  for (const q of suite.questions) {
    (knownBugs.has(q.id) ? it.fails : it)(`${q.id}: ${expected[q.id]}`, async () => {
      const r = await runQuestion(rig, srv, srv.providers[0]!, q, truth.questions[q.id], { judge: null, rep: 1 });
      expect(r.outcome, r.detail).toBe(expected[q.id]);
    });
  }
});

// The rig's user (hostPolicy: superset, --as-user) narrows every turn the way the Superset host does.
function asViewer(base: Rig, hiddenEntities: string[]): Rig {
  return { ...base, user: { name: "viewer", identity: async () => ({ user: "viewer", edit: true, maintain: true, hiddenEntities }) } };
}

describe("a run as a user whose access hides the data a question needs", () => {
  let rig: Rig;
  let srv: Awaited<ReturnType<typeof serve>>;
  beforeAll(async () => {
    rig = asViewer(await exampleRig("commerce", { board: "overview" }), ["orders"]);
    srv = await serve(rig, [stubProvider(suite)]);
  });
  afterAll(async () => {
    await srv.close();
    await rig.close();
  });

  it("can't answer what the service account answers", async () => {
    const q = suite.questions.find((x) => x.id === "C1")!;
    const r = await runQuestion(rig, srv, srv.providers[0]!, q, undefined, { judge: null, rep: 1 });
    expect(r.outcome).not.toBe("correct");
    // The stub asks for the same figure; the engine refuses the hidden measure, and the stub's scripted
    // reply has nothing to fill in.
    expect(r.toolErrors).toBeGreaterThan(0);
    expect(r.calls.find((c) => c.tool === "query")?.ok).toBe(false);
  });
});

describe("a run as a user who may read none of the datasets", () => {
  let rig: Rig;
  let srv: Awaited<ReturnType<typeof serve>>;
  beforeAll(async () => {
    const base = await exampleRig("commerce", { board: "overview" });
    rig = asViewer(base, Object.keys(base.host.pack.entities));
    srv = await serve(rig, [stubProvider(suite)]);
  });
  afterAll(async () => {
    await srv.close();
    await rig.close();
  });

  it("is refused before any model call, and told it is their access", async () => {
    const q = suite.questions.find((x) => x.id === "C1")!;
    const r = await runQuestion(rig, srv, srv.providers[0]!, q, undefined, { judge: null, rep: 1 });
    expect(r.outcome).not.toBe("correct");
    expect(r.calls).toEqual([]);
    expect(r.usd).toBe(0);
    expect(r.error).toContain("None of this assistant's data is available to you");
  });
});
