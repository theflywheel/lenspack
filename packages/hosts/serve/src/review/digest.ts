import type { AuditEvent } from "../audit";

// The period's chat turns as the daily review reads them: one compact line per turn from the
// audit log's chat-turn lines (the question, its language, the tool calls and their arguments, what
// each returned, refusals, the reviewer's findings, the reply, the cost, who asked and any quick
// reply picked). Users are named u1, u2… so their names never leave the server; the mapping stays here.

export type DigestTurn = {
  /** The turn's number in this digest; findings and proposals cite it. */
  n: number;
  at: string;
  user: string;
  board?: string;
  language?: string;
  question: string;
  tools: string[];
  refused: string[];
  findings: string[];
  /** The reviewer said the reading was unstated or wrong. */
  reading?: string;
  clarify?: string;
  quickReply?: string;
  answer: string;
  outcome?: string;
  usd: number;
  /** Something went wrong on this turn: a refusal, an error, a finding, a clarification. */
  flagged: boolean;
};

type Call = { tool?: string; input?: Record<string, unknown>; ok?: boolean; rows?: number; error?: string; computed?: string };
type TurnDetail = {
  instruction?: string;
  answer?: string;
  calls?: Call[];
  refusals?: string[];
  reviews?: { findings?: { severity?: string; problem?: string }[]; reading?: { issue?: string; note?: string } }[];
  outcome?: string;
  costUsd?: number;
  cost?: { total?: { usd?: number } };
  language?: string;
  clarify?: { asked?: boolean; pattern?: string; options?: string[]; assumed?: string };
  quickReply?: { option?: string };
};

const cut = (s: unknown, n: number) => {
  const t = typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** A tool call in one line: its name, the arguments that were set, and what came back. */
export function callLine(c: Call): string {
  const args = Object.entries(c.input ?? {})
    .filter(([, v]) => v !== "" && v !== null && v !== undefined && v !== false && v !== 0 && !(typeof v === "object" && !Array.isArray(v) && !Object.keys(v as object).length))
    .map(([k, v]) => `${k}=${cut(typeof v === "string" ? v : JSON.stringify(v), 80)}`)
    .join(" ");
  const result = c.error ? ` → error: ${cut(c.error, 140)}` : c.ok === false ? " → refused" : c.rows !== undefined ? ` → ${c.rows} rows` : "";
  return cut(`${c.tool ?? "?"}(${args})${result}`, 320);
}

/** chat-turn audit events (any order) → digest turns, oldest first. `users` maps real names to u1, u2…; pass one to share it across calls. */
export function digestTurns(events: AuditEvent[], users = new Map<string, string>()): DigestTurn[] {
  const turns = events.filter((e) => e.action === "chat-turn" && e.detail).sort((a, b) => a.at.localeCompare(b.at));
  const out: DigestTurn[] = [];
  for (const e of turns) {
    let d: TurnDetail;
    try {
      d = JSON.parse(e.detail!) as TurnDetail;
    } catch {
      continue;
    }
    if (!users.has(e.user)) users.set(e.user, `u${users.size + 1}`);
    const calls = (d.calls ?? []).filter((c) => c.tool !== "get_board" && c.tool !== "list_metrics");
    const findings = (d.reviews ?? []).flatMap((r) => r.findings ?? []).map((f) => cut(`${f.severity ?? "minor"}: ${f.problem}`, 240)).slice(0, 4);
    const reading = (d.reviews ?? []).map((r) => r.reading).find((r) => r?.issue);
    const refused = (d.refusals ?? []).map((r) => cut(r, 200)).slice(0, 4);
    const errors = calls.some((c) => c.error || c.ok === false);
    const clarify = d.clarify?.pattern ? `${d.clarify.asked ? "asked" : `assumed "${d.clarify.assumed ?? ""}"`}: ${cut(d.clarify.pattern, 120)} [${(d.clarify.options ?? []).join(" | ")}]` : undefined;
    out.push({
      n: out.length + 1,
      at: e.at,
      user: users.get(e.user)!,
      ...(e.board ? { board: e.board } : {}),
      ...(d.language ? { language: d.language } : {}),
      question: cut(d.instruction, 400),
      tools: calls.slice(0, 8).map(callLine),
      refused,
      findings,
      ...(reading ? { reading: cut(`${reading.issue}: ${reading.note ?? ""}`, 240) } : {}),
      ...(clarify ? { clarify } : {}),
      ...(d.quickReply?.option ? { quickReply: cut(d.quickReply.option, 120) } : {}),
      answer: cut(d.answer, 600),
      ...(d.outcome ? { outcome: d.outcome } : {}),
      usd: Math.round((d.costUsd ?? d.cost?.total?.usd ?? 0) * 1e5) / 1e5,
      flagged: !!(refused.length || errors || findings.length || reading || clarify || !d.answer),
    });
  }
  return out;
}

/** A digest turn as the model reads it: shorter keys, empty fields left out. */
export function turnText(t: DigestTurn, short = false): string {
  const lines = [`#${t.n} ${t.at.slice(0, 16)} ${t.user}${t.language ? ` [${t.language}]` : ""}${t.outcome ? ` (${t.outcome})` : ""}: ${t.question}`];
  const tools = short ? t.tools.slice(0, 3) : t.tools;
  if (tools.length) lines.push(`  tools: ${tools.join("; ")}`);
  if (t.refused.length) lines.push(`  refused: ${t.refused.join("; ")}`);
  if (t.findings.length) lines.push(`  reviewer: ${t.findings.join("; ")}`);
  if (t.reading) lines.push(`  reading: ${t.reading}`);
  if (t.clarify) lines.push(`  clarify: ${t.clarify}`);
  if (t.quickReply) lines.push(`  picked: ${t.quickReply}`);
  lines.push(`  reply: ${short ? cut(t.answer, 200) : t.answer || "(none)"}`);
  return lines.join("\n");
}
