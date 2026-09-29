// Arithmetic between measures: `delivered / target`, `received - dispatched`,
// `(a + b) / c * 100`. A closed grammar — measure keys, numbers, + - * /,
// parentheses — parsed into a tree and evaluated by lenspack, never handed to
// a database or an interpreter as text.

export type MeasureExpr =
  | { t: "measure"; key: string }
  | { t: "number"; value: number }
  | { t: "neg"; arg: MeasureExpr }
  | { t: "op"; op: "+" | "-" | "*" | "/"; l: MeasureExpr; r: MeasureExpr };

export class ExprError extends Error {}

const MAX_LENGTH = 300;
const MAX_DEPTH = 12;

export function parseExpr(source: string): MeasureExpr {
  if (source.length > MAX_LENGTH) throw new ExprError(`an expression is at most ${MAX_LENGTH} characters`);
  const tokens = source.match(/\s*([a-z][a-z0-9_]*|\d+(?:\.\d+)?|\.\d+|[-+*/()]|\S)/g)?.map((t) => t.trim()) ?? [];
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  const fail = (what: string): never => {
    throw new ExprError(`${what} at "${tokens.slice(i).join(" ") || "end"}" in "${source.trim()}"`);
  };

  const expr = (depth: number): MeasureExpr => {
    if (depth > MAX_DEPTH) fail("too deeply nested");
    let left = term(depth);
    while (peek() === "+" || peek() === "-") left = { t: "op", op: next() as "+" | "-", l: left, r: term(depth) };
    return left;
  };
  const term = (depth: number): MeasureExpr => {
    let left = factor(depth);
    while (peek() === "*" || peek() === "/") left = { t: "op", op: next() as "*" | "/", l: left, r: factor(depth) };
    return left;
  };
  const factor = (depth: number): MeasureExpr => {
    const tok = next();
    if (tok === undefined) return fail("expected a measure, a number or (");
    if (tok === "-") return { t: "neg", arg: factor(depth + 1) };
    if (tok === "(") {
      const inner = expr(depth + 1);
      if (next() !== ")") fail("expected )");
      return inner;
    }
    if (/^(\d+(\.\d+)?|\.\d+)$/.test(tok)) return { t: "number", value: Number(tok) };
    if (/^[a-z][a-z0-9_]*$/.test(tok)) return { t: "measure", key: tok };
    return fail(`unexpected "${tok}"`);
  };

  const tree = expr(0);
  if (i < tokens.length) fail("unexpected");
  if (operands(tree).length === 0) throw new ExprError(`"${source.trim()}" names no measure`);
  return tree;
}

export function operands(e: MeasureExpr): string[] {
  const out = new Set<string>();
  const walk = (x: MeasureExpr) => {
    if (x.t === "measure") out.add(x.key);
    else if (x.t === "neg") walk(x.arg);
    else if (x.t === "op") {
      walk(x.l);
      walk(x.r);
    }
  };
  walk(e);
  return [...out];
}

/** Null in, null out; dividing by zero is null, never Infinity. */
export function evaluate(e: MeasureExpr, value: (key: string) => number | null): number | null {
  switch (e.t) {
    case "measure":
      return value(e.key);
    case "number":
      return e.value;
    case "neg": {
      const v = evaluate(e.arg, value);
      return v === null ? null : -v;
    }
    case "op": {
      const l = evaluate(e.l, value);
      const r = evaluate(e.r, value);
      if (l === null || r === null) return null;
      if (e.op === "/") return r === 0 ? null : l / r;
      return e.op === "+" ? l + r : e.op === "-" ? l - r : l * r;
    }
  }
}

export function formatExpr(e: MeasureExpr): string {
  const prec = (x: MeasureExpr) => (x.t === "op" ? (x.op === "+" || x.op === "-" ? 1 : 2) : 3);
  const wrap = (x: MeasureExpr, min: number) => (prec(x) < min ? `(${formatExpr(x)})` : formatExpr(x));
  switch (e.t) {
    case "measure":
      return e.key;
    case "number":
      return String(e.value);
    case "neg":
      return `-${wrap(e.arg, 3)}`;
    case "op": {
      const p = prec(e);
      return `${wrap(e.l, p)} ${e.op} ${wrap(e.r, p + (e.op === "-" || e.op === "/" ? 1 : 0))}`;
    }
  }
}
