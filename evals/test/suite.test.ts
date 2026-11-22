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
  };

  for (const q of suite.questions) {
    it(`${q.id}: ${expected[q.id]}`, async () => {
      const r = await runQuestion(rig, srv, srv.providers[0]!, q, truth.questions[q.id], { judge: null, rep: 1 });
      expect(r.outcome, r.detail).toBe(expected[q.id]);
    });
  }
});
