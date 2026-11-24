import { describe, expect, it } from "vitest";

import { evaluate, formatExpr, operands, parseExpr } from "../src/expr";

describe("measure arithmetic", () => {
  it("parses with the usual precedence and round-trips", () => {
    const e = parseExpr("(a + b) / c * 100 - -d");
    expect(formatExpr(e)).toBe("(a + b) / c * 100 - -d");
    expect(operands(e)).toEqual(["a", "b", "c", "d"]);
    expect(evaluate(e, (k) => ({ a: 1, b: 3, c: 8, d: 2 })[k]!)).toBe(52);
  });
  it("keeps left associativity for - and /", () => {
    expect(evaluate(parseExpr("a - b - c"), (k) => ({ a: 10, b: 3, c: 2 })[k]!)).toBe(5);
    expect(evaluate(parseExpr("a / b / c"), (k) => ({ a: 12, b: 3, c: 2 })[k]!)).toBe(2);
    expect(formatExpr(parseExpr("a - (b - c)"))).toBe("a - (b - c)");
  });
  it("gives null for a missing operand or a zero divisor, never Infinity", () => {
    expect(evaluate(parseExpr("a / b"), (k) => ({ a: 1, b: 0 })[k]!)).toBeNull();
    expect(evaluate(parseExpr("a + b"), (k) => (k === "a" ? 1 : null))).toBeNull();
  });
  it("refuses anything but keys, numbers and arithmetic", () => {
    for (const bad of ["a / ", "a ; drop", "f(a)", "a ** 2", "A / b", "2 * 3", "(a"]) expect(() => parseExpr(bad), bad).toThrow();
  });
});
