import * as React from "react";

// "How this was worked out" under an answer (docs/features/explain.md): the turn's data-answer-card part (the answer card), one
// expander, collapsed. Each data call in the order made: the query in plain words, the statement
// the source ran, and the first rows behind the answer.

type Cell = string | number | boolean | null;
type Statement = { language: "sql" | "json"; text: string; params?: string[]; cachedAt?: string; note?: string };
type Call = { description: string; statements?: Statement[]; after?: string; columns: { key: string; label: string; format?: string }[]; rows: Cell[][]; total: number; saved?: { asOf: string } };
type Selection = { field: string; label: string; value: string; applied: boolean };
export type AnswerCardData = { calls: Call[]; more?: number; sql: boolean; selections?: Selection[] };

const shown = (v: Cell, format?: string) => {
  if (typeof v !== "number") return v === null ? "—" : String(v);
  if (format === "percent") return `${(v * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
  return v.toLocaleString(undefined, { maximumFractionDigits: Math.abs(v) >= 100 ? 0 : 2 });
};
const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};

function StatementBlock({ s }: { s: Statement }) {
  const [copied, setCopied] = React.useState(false);
  const values = s.params?.length ? `Values: ${s.params.map((p, i) => `${i + 1} = ${p}`).join(", ")}` : "";
  const copy = () =>
    void navigator.clipboard?.writeText(values ? `${s.text}\n-- ${values}` : s.text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  return (
    <div className="min-w-0 overflow-hidden rounded border">
      <div className="flex items-center justify-between gap-2 bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
        <span>{s.language === "sql" ? "SQL that ran" : "Request that ran"}</span>
        <button type="button" onClick={copy} className="rounded border bg-background px-2 py-px text-foreground hover:border-foreground/40" data-testid="explain-copy">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {/* Long statements scroll inside their block, never the page. */}
      <pre tabIndex={0} className="max-h-60 overflow-auto px-2 py-1.5 font-mono text-[11px] leading-5 whitespace-pre">
        <code>{s.text}</code>
      </pre>
      {values && <p className="overflow-x-auto whitespace-nowrap px-2 pb-1 font-mono text-[11px] text-muted-foreground">{values}</p>}
      {s.note && <p className="px-2 pb-1 text-[11px] text-muted-foreground">{s.note}</p>}
    </div>
  );
}

function Rows({ c }: { c: Call }) {
  if (!c.rows.length) return <p className="text-[11px] text-muted-foreground">No rows came back.</p>;
  const numeric = c.columns.map((_, k) => c.rows.every((r) => r[k] === null || typeof r[k] === "number"));
  return (
    <div tabIndex={0} className="max-w-full overflow-x-auto rounded border">
      <table className="w-max min-w-full border-collapse text-xs tabular-nums">
        <caption className="caption-bottom px-2 py-1 text-left text-[11px] text-muted-foreground">
          {c.total > c.rows.length ? `Showing ${c.rows.length} of ${c.total} rows` : `${c.rows.length} ${c.rows.length === 1 ? "row" : "rows"}`}
        </caption>
        <thead>
          <tr>
            {c.columns.map((col, k) => (
              <th key={col.key} className={`whitespace-nowrap border-b bg-muted px-2 py-1 font-medium text-muted-foreground ${numeric[k] ? "text-right" : "text-left"}`}>
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {c.rows.map((r, i) => (
            <tr key={i} className="border-b last:border-0">
              {c.columns.map((col, k) => (
                <td key={col.key} className={`whitespace-nowrap px-2 py-0.5 ${numeric[k] ? "text-right" : ""}`}>
                  {shown(r[k] ?? null, col.format)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ExplainBlock({ x }: { x: AnswerCardData }) {
  const [open, setOpen] = React.useState(false);
  const id = React.useId();
  if (!x.calls?.length) return null;
  return (
    <div className="min-w-0 max-w-full text-xs" data-testid="explain">
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)} className="inline-flex items-center gap-1 rounded px-1 py-0.5 font-medium text-[var(--declared)] hover:bg-muted">
        <span aria-hidden="true" className={`inline-block transition-transform ${open ? "rotate-90" : ""}`}>▸</span>
        How this was worked out
      </button>
      <div id={id} hidden={!open} className="mt-1 space-y-3 rounded-md border bg-card p-2">
        {x.selections?.length ? (
          <p className="text-[11px] text-muted-foreground" data-testid="explain-filters">
            Dashboard filters when you asked: {x.selections.map((f) => `${f.label} = ${f.value} (${f.applied ? "applied" : "not applied to these numbers"})`).join("; ")}
          </p>
        ) : null}
        {x.calls.map((c, i) => (
          <section key={i} aria-label={`Data call ${i + 1}`} className="min-w-0 space-y-1.5 border-t pt-2 first:border-0 first:pt-0">
            <p className="leading-5 text-foreground">
              <span className="mr-1.5 inline-grid size-4 place-items-center rounded-full bg-muted font-mono text-[10px] text-muted-foreground">{i + 1}</span>
              {c.description}
            </p>
            {c.saved && <p className="text-[11px] text-muted-foreground">Saved answer, data as of {when(c.saved.asOf)}</p>}
            {!c.saved && c.statements?.find((s) => s.cachedAt) && <p className="text-[11px] text-muted-foreground">Answered from the source's cache, data as of {when(c.statements.find((s) => s.cachedAt)!.cachedAt!)}</p>}
            {c.statements?.map((s, k) => <StatementBlock key={k} s={s} />)}
            {c.after && <p className="text-[11px] text-muted-foreground">{c.after}</p>}
            <Rows c={c} />
          </section>
        ))}
        {x.more ? <p className="text-[11px] text-muted-foreground">{x.more} more data calls are not shown.</p> : null}
      </div>
    </div>
  );
}
