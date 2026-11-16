import { expect, it } from "vitest";

import { stopOnRepeatedRefusals } from "../src/llm";

it("stops a turn that only reads beside a failed call, three steps running", () => {
  const stuck = { toolResults: [{ toolName: "get_board", output: { board: "" } }], content: [{ type: "tool-error" }] };
  const edited = { toolResults: [{ toolName: "add_widget", output: { applied: true } }], content: [] };
  const stop = stopOnRepeatedRefusals(3);
  expect(stop({ steps: [stuck, stuck, stuck] })).toBe(true);
  expect(stop({ steps: [stuck, edited, stuck] })).toBe(false);
  expect(stop({ steps: [edited, edited, edited] })).toBe(false);
});
