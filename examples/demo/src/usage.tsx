import * as React from "react";

import { ArrowLeft, RefreshCw } from "lucide-react";

import { Button } from "./components/ui/button";
import { cn } from "./lib/utils";

// What the chat's model calls have cost, as GET /api/_usage reports it. Only
// maintainers can read that (and everyone on an open server), so the profile
// menu offers this page to them alone.

type Usage = { calls: number; failed: number; inputTokens: number; cachedInputTokens: number; cacheWriteTokens: number; outputTokens: number; reasoningTokens: number; usd: number; unpriced: number };
type Queries = { queries: number; failed: number; ms: number; rows: number };
type Row = {
  day: string;
  user: string;
  pack: string;
  turns: number;
  llm: Usage;
  byProvider: Record<string, Usage>;
  byRole: Record<string, Usage>;
  /** Absent from a server older than effort metering. */
  byEffort?: Record<string, Record<string, Usage>>;
  queries: Queries;
};
type Report = {
  since: string;
  total: Usage & { turns: number };
  packs: Record<string, Queries>;
  turns: Row[];
  budget?: { usdPerDay?: number; usdPerUserPerDay?: number; day: string; spent: number; users: Record<string, number> };
};

const empty = (): Usage => ({ calls: 0, failed: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, usd: 0, unpriced: 0 });
const add = (into: Usage, u: Usage) => {
  for (const k of Object.keys(into) as (keyof Usage)[]) into[k] += u[k] ?? 0;
  return into;
};
const usd = (n: number) => `$${n === 0 ? "0.00" : n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
const cost = (u: Usage) => (u.unpriced > 0 && u.usd === 0 ? "unpriced" : `${usd(u.usd)}${u.unpriced > 0 ? " +" : ""}`);
const count = (n: number) => n.toLocaleString();
const compact = (n: number) => (n < 10_000 ? n.toLocaleString() : new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n));
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
/** Probes and other calls made for no one are filed under "-". */
const who = (user: string) => (user === "-" ? "no one (startup probes)" : user === "anonymous" ? "guest" : user);

/** Everything the rows in scope add up to. */
function summarise(rows: Row[]) {
  const llm = empty();
  const byModel: Record<string, Usage> = {};
  const byRole: Record<string, Usage> = {};
  const byEffort: Record<string, Usage> = {};
  let turns = 0;
  for (const r of rows) {
    add(llm, r.llm);
    turns += r.turns;
    for (const [k, u] of Object.entries(r.byProvider)) add((byModel[k] ??= empty()), u);
    for (const [k, u] of Object.entries(r.byRole)) add((byRole[k] ??= empty()), u);
    for (const [model, levels] of Object.entries(r.byEffort ?? {})) for (const [level, u] of Object.entries(levels)) add((byEffort[`${model}\u0000${level}`] ??= empty()), u);
  }
  return { llm, turns, byModel, byRole, byEffort };
}

export function UsagePage({ load, onClose }: { load: (path: string) => Promise<any>; onClose: () => void }) {
  const [report, setReport] = React.useState<Report | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [scope, setScope] = React.useState<"today" | "all">("today");
  const [loading, setLoading] = React.useState(false);
  const refresh = React.useCallback(() => {
    setLoading(true);
    void load("/_usage").then((r) => {
      setLoading(false);
      if (r.total) {
        setReport(r);
        setProblem(null);
      } else setProblem(r.error ?? "Usage did not load");
    });
  }, [load]);
  React.useEffect(refresh, [refresh]);

  const head = (
    <div className="space-y-2">
      <Button variant="ghost" size="sm" className="-ml-2" onClick={onClose}>
        <ArrowLeft /> Back to the board
      </Button>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-mono text-lg font-semibold tracking-[-0.02em] text-foreground">AI usage</h1>
          <p className="mt-1 max-w-[72ch] text-sm text-muted-foreground">
            What the chat's model calls have cost on this server, metered at every call and priced at each provider's published rates.
            {report && <> Counted since {when(report.since)}.</>}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh} disabled={loading} data-testid="usage-refresh">
          <RefreshCw className={cn(loading && "animate-spin")} /> Refresh
        </Button>
      </div>
    </div>
  );

  if (problem)
    return (
      <div className="max-w-5xl space-y-6" data-testid="usage-page">
        {head}
        <p className="text-sm text-destructive">{problem}</p>
      </div>
    );
  if (!report)
    return (
      <div className="max-w-5xl space-y-6" data-testid="usage-page">
        {head}
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );

  const today = report.budget?.day ?? new Date().toISOString().slice(0, 10);
  const todays = summarise(report.turns.filter((r) => r.day === today));
  const all = summarise(report.turns);
  const shown = scope === "today" ? todays : all;
  const packs = Object.entries(report.packs);

  return (
    <div className="max-w-5xl space-y-8" data-testid="usage-page">
      {head}

      <div className="grid gap-4 md:grid-cols-2">
        <Totals title="Today" note={`${today}, UTC`} u={todays.llm} turns={todays.turns} testid="usage-today" />
        <Totals title="Since the count began" note={when(report.since)} u={all.llm} turns={all.turns} testid="usage-all" />
      </div>

      {report.budget && <Budget b={report.budget} />}

      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-foreground">Breakdown</h2>
          <div role="radiogroup" aria-label="Period" className="grid grid-cols-2 gap-1 rounded-md border border-rule p-0.5 text-xs">
            {(
              [
                ["today", "Today"],
                ["all", "Since the count began"],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={scope === v}
                onClick={() => setScope(v)}
                className={cn("rounded-sm px-2.5 py-1 text-muted-foreground hover:text-foreground", scope === v && "bg-accent font-medium text-foreground")}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <UsageTable title="By model" first="Model" rows={Object.entries(shown.byModel)} testid="usage-by-model" />
          <UsageTable title="By role" first="Role" rows={Object.entries(shown.byRole)} note="build writes the board, review checks it, escalate retries with a stronger model, probe is the startup check." testid="usage-by-role" />
        </div>
        <EffortTable rows={Object.entries(shown.byEffort)} />
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold text-foreground">Backend queries</h2>
        <p className="text-xs text-muted-foreground">Every query a pack ran since the server started, board loads and chat tools alike.</p>
        {packs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No queries yet.</p>
        ) : (
          <Table head={["Pack", "Queries", "Failed", "Rows", "Total time", "Average"]} testid="usage-queries">
            {packs.map(([pack, q]) => (
              <tr key={pack}>
                <Td mono>{pack}</Td>
                <Td num>{count(q.queries)}</Td>
                <Td num>{count(q.failed)}</Td>
                <Td num>{count(q.rows)}</Td>
                <Td num>{seconds(q.ms)}</Td>
                <Td num>{q.queries ? `${Math.round(q.ms / q.queries).toLocaleString()} ms` : "–"}</Td>
              </tr>
            ))}
          </Table>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold text-foreground">By day, person and pack</h2>
        <Table head={["Day", "Who", "Pack", "Turns", "Calls", "Queries", "Cost"]} testid="usage-ledger">
          {report.turns.map((r) => (
            <tr key={`${r.day}/${r.user}/${r.pack}`}>
              <Td mono>{r.day}</Td>
              <Td>{who(r.user)}</Td>
              <Td mono>{r.pack}</Td>
              <Td num>{count(r.turns)}</Td>
              <Td num>{count(r.llm.calls)}</Td>
              <Td num>{count(r.queries.queries)}</Td>
              <Td num>{cost(r.llm)}</Td>
            </tr>
          ))}
        </Table>
      </section>
    </div>
  );
}

const seconds = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

function Totals({ title, note, u, turns, testid }: { title: string; note: string; u: Usage; turns: number; testid: string }) {
  const stats: [string, string][] = [
    ["Turns", count(turns)],
    ["Model calls", count(u.calls)],
    ["Tokens in", compact(u.inputTokens)],
    ["of which cached", compact(u.cachedInputTokens)],
    ["Tokens out", compact(u.outputTokens)],
    ["Failed calls", count(u.failed)],
  ];
  return (
    <section className="rounded-md border border-rule bg-card p-4" data-testid={testid}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium text-foreground">{title}</h2>
        <span className="truncate text-2xs text-muted-foreground">{note}</span>
      </div>
      <p className="mt-2 font-mono text-2xl font-semibold tracking-[-0.03em] text-foreground tabular-nums">{usd(u.usd)}</p>
      {u.unpriced > 0 && <p className="text-2xs text-muted-foreground">plus {count(u.unpriced)} calls to a provider with no price, counted in tokens only</p>}
      <dl className="mt-3 grid grid-cols-3 gap-x-4 gap-y-2 border-t border-rule pt-3">
        {stats.map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className="truncate text-2xs text-muted-foreground">{k}</dt>
            <dd className="font-mono text-sm text-foreground tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** Spend against a cap: a bar, the figures, and in words how near it is. */
function Meter({ label, spent, cap, testid }: { label: string; spent: number; cap: number; testid?: string }) {
  const share = cap > 0 ? spent / cap : 0;
  const state = share >= 1 ? "cap reached: chat waits until 00:00 UTC" : share >= 0.8 ? "near the cap" : null;
  return (
    <div className="space-y-1" data-testid={testid}>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="min-w-0 truncate text-foreground">{label}</span>
        <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
          {usd(spent)} of {usd(cap)} · {share > 0 && share < 0.01 ? "<1" : Math.min(999, Math.round(share * 100))}%
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted" role="meter" aria-valuemin={0} aria-valuemax={cap} aria-valuenow={spent} aria-label={label}>
        <div className={cn("h-full rounded-full", share >= 0.8 ? "bg-refused" : "bg-declared")} style={{ width: `${Math.max(spent > 0 ? 1.5 : 0, Math.min(100, share * 100))}%` }} />
      </div>
      {state && <p className="text-2xs text-refused">{state}</p>}
    </div>
  );
}

function Budget({ b }: { b: NonNullable<Report["budget"]> }) {
  const users = Object.entries(b.users).sort((x, y) => y[1] - x[1]);
  return (
    <section className="space-y-4 rounded-md border border-rule bg-card p-4" data-testid="usage-budget">
      <div>
        <h2 className="text-sm font-medium text-foreground">Budget, today</h2>
        <p className="text-2xs text-muted-foreground">Once a cap is reached, chat answers that it has to wait; the count starts again at 00:00 UTC. Only priced calls count.</p>
      </div>
      {b.usdPerDay !== undefined && <Meter label="This server" spent={b.spent} cap={b.usdPerDay} testid="budget-server" />}
      {b.usdPerUserPerDay !== undefined &&
        (users.length === 0 ? (
          <p className="text-sm text-muted-foreground">No one has used chat today. Each person may spend up to {usd(b.usdPerUserPerDay)}.</p>
        ) : (
          users.map(([u, spent]) => <Meter key={u} label={`Per person: ${who(u)}`} spent={spent} cap={b.usdPerUserPerDay!} />)
        ))}
    </section>
  );
}

function UsageTable({ title, first, rows, note, testid }: { title: string; first: string; rows: [string, Usage][]; note?: string; testid: string }) {
  return (
    <div className="min-w-0 space-y-1.5">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No model calls in this period.</p>
      ) : (
        <Table head={[first, "Calls", "In", "Cached", "Out", "Cost"]} testid={testid}>
          {rows
            .sort((x, y) => y[1].usd - x[1].usd || y[1].calls - x[1].calls)
            .map(([k, u]) => (
              <tr key={k}>
                <Td mono>{k}</Td>
                <Td num>{count(u.calls)}</Td>
                <Td num>{compact(u.inputTokens)}</Td>
                <Td num>{compact(u.cachedInputTokens)}</Td>
                <Td num>{compact(u.outputTokens)}</Td>
                <Td num>{cost(u)}</Td>
              </tr>
            ))}
        </Table>
      )}
      {note && <p className="text-2xs text-muted-foreground">{note}</p>}
    </div>
  );
}

function EffortTable({ rows }: { rows: [string, Usage][] }) {
  return (
    <div className="space-y-1.5">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">By effort</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No call in this period recorded an effort.</p>
      ) : (
        <Table head={["Model", "Effort", "Calls", "Out", "Cost"]} testid="usage-by-effort">
          {rows
            .sort((x, y) => y[1].usd - x[1].usd)
            .map(([k, u]) => {
              const [model, level] = k.split("\u0000");
              return (
                <tr key={k}>
                  <Td mono>{model}</Td>
                  <Td>{level}</Td>
                  <Td num>{count(u.calls)}</Td>
                  <Td num>{compact(u.outputTokens)}</Td>
                  <Td num>{cost(u)}</Td>
                </tr>
              );
            })}
        </Table>
      )}
    </div>
  );
}

/** Columns of words, set left; the rest are figures, set right. */
const TEXT_COLUMNS = new Set(["Who", "Pack", "Effort"]);

function Table({ head, children, testid }: { head: string[]; children: React.ReactNode; testid?: string }) {
  return (
    <div className="overflow-x-auto rounded-md border border-rule bg-card">
      <table className="w-full text-sm" data-testid={testid}>
        <thead>
          <tr className="border-b border-rule text-2xs text-muted-foreground">
            {head.map((h, i) => (
              <th key={h} className={cn("px-3 py-2 font-medium whitespace-nowrap", i === 0 || TEXT_COLUMNS.has(h) ? "text-left" : "text-right")}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-rule">{children}</tbody>
      </table>
    </div>
  );
}

function Td({ children, num, mono }: { children: React.ReactNode; num?: boolean; mono?: boolean }) {
  return <td className={cn("px-3 py-1.5 whitespace-nowrap", num ? "text-right font-mono text-xs tabular-nums" : "text-foreground", mono && "font-mono text-xs")}>{children}</td>;
}
