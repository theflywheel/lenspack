import * as React from "react";

import type { Board as BoardT, Catalogue, Query } from "@lenspack/core";
import { Board, BoardProvider, type BoardHost } from "@lenspack/react";
import { svgAdapter as svgFallback } from "@lenspack/react/adapters/svg";

import { ADAPTER_NAMES, type AdapterName, useChartAdapter } from "./adapters";

// The home page. One idea carries it: colour is provenance. A key that the
// pack declares is always mono and blue — in the YAML, in prose, in a board
// title. Something the compiler refuses is always mono and ochre. By the time
// you reach the demo you have learned the product's whole thesis without
// reading a feature list.

const api = async (path: string) => (await fetch(`/api${path}`)).json();

/** A key from the catalogue. The same treatment everywhere it appears. */
function K({ children }: { children: React.ReactNode }) {
  return <span className="key">{children}</span>;
}

/** Two-track page grid: a quiet rail of meta on the left, content on the right. */
function Row({ label, children, className = "", wide = false }: { label?: React.ReactNode; children: React.ReactNode; className?: string; wide?: boolean }) {
  if (wide)
    return (
      <div className={`mx-auto max-w-[1180px] px-6 ${className}`}>
        {label && <div className="mb-3 font-mono text-2xs text-muted-foreground">{label}</div>}
        {children}
      </div>
    );
  return (
    <div className={`mx-auto grid max-w-[1180px] grid-cols-1 gap-x-10 px-6 md:grid-cols-[132px_minmax(0,1fr)] ${className}`}>
      <div className="hidden pt-1 font-mono text-2xs leading-5 text-muted-foreground md:block">{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function Landing() {
  return (
    <div className="min-h-screen bg-background text-body">
      <Header />
      <main>
        <Hero />
        <Refusals />
        <FirstBoard />
        <Packs />
        <Conformance />
        <Guarantees />
      </main>
      <Footer />
    </div>
  );
}

function Header() {
  return (
    <header className="sticky top-0 z-30 border-b border-rule bg-background/95 backdrop-blur-sm">
      <div className="mx-auto flex h-14 max-w-[1180px] items-center justify-between px-6">
        <a href="/" className="font-mono text-base font-semibold tracking-tight text-foreground">
          lenspack
        </a>
        <nav className="flex items-center gap-6 text-sm">
          <a className="hover:text-foreground" href="https://github.com/theflywheel/lenspack/blob/main/docs/pack-spec.md">
            Pack spec
          </a>
          <a className="hover:text-foreground" href="https://github.com/theflywheel/lenspack">
            Source
          </a>
          <a className="border border-rule-strong bg-foreground px-3 py-1.5 font-medium text-background hover:opacity-90" href="/app">
            Open the demo
          </a>
        </nav>
      </div>
    </header>
  );
}

const PRESET_TABS = ["preview", "pack", "config"] as const;
type PresetTab = (typeof PRESET_TABS)[number];

function Hero() {
  const [tab, setTab] = React.useState<PresetTab>("preview");
  const [adapter, setAdapter] = React.useState<AdapterName>("recharts");
  const charts = useChartAdapter(adapter);
  const [state, setState] = React.useState<{ board: BoardT; catalogue: Catalogue; yaml: string; data: Record<string, unknown> } | null>(null);

  React.useEffect(() => {
    void Promise.all([api("/commerce/overview/canonical"), api("/commerce/pack")]).then(([b, p]) =>
      setState({ board: { ...b.board, updatedAt: new Date(b.board.updatedAt) }, catalogue: b.catalogue, yaml: p.yaml, data: b.data }),
    );
  }, []);
  const host = React.useMemo<BoardHost>(() => ({ loadBoardData: async () => (state?.data ?? {}) as never }), [state]);

  return (
    <section className="border-b border-rule pb-14 pt-16 md:pt-24">
      <Row label="lenspack">
        <h1 className="max-w-[18ch] font-mono text-2xl font-semibold leading-[1.05] tracking-[-0.035em] text-foreground md:text-3xl lg:text-4xl">
          A dashboard is data, not code.
        </h1>
        <p className="mt-7 max-w-[62ch] text-lg leading-[1.55]">
          Declare your data once in a pack. After that a language model can build and edit dashboards over it by naming keys —{" "}
          <K>revenue</K>, <K>country</K>, <K>refund_rate</K> — and nothing else. No SQL, no JSX, no colour values. What the pack does not declare,
          the compiler will not build.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <a className="border border-foreground bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90" href="/app">
            Open the demo
          </a>
          <a className="border border-rule-strong px-4 py-2 text-sm font-medium text-foreground hover:bg-accent" href="https://github.com/theflywheel/lenspack">
            Read the source
          </a>
          <span className="font-mono text-xs text-muted-foreground">Apache-2.0 · Postgres and DuckDB</span>
        </div>
      </Row>

      <Row label="the binding" wide className="mt-16">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <p className="max-w-[54ch] text-sm">
            On the left, everything a person writes. On the right, a board built only from it — rendered live, and by whichever charting library you
            pick. The board never changes; only the renderer does.
          </p>
          <div className="flex gap-1 font-mono text-xs">
            {ADAPTER_NAMES.map((n) => (
              <button
                key={n}
                onClick={() => setAdapter(n)}
                aria-pressed={adapter === n}
                className={`border px-2 py-1 ${adapter === n ? "border-declared text-declared" : "border-rule text-muted-foreground hover:text-foreground"}`}
              >
                {n}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 items-stretch gap-px border border-rule bg-rule lg:grid-cols-[380px_minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col bg-card">
            <div className="flex border-b border-rule">
              {PRESET_TABS.map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  aria-pressed={tab === t}
                  className={`border-r border-rule px-3 py-2 font-mono text-xs ${tab === t ? "bg-declared-soft text-declared" : "text-muted-foreground hover:text-foreground"}`}
                >
                  {t === "preview" ? "pack.yaml" : t === "pack" ? "board.json" : "the ops"}
                </button>
              ))}
            </div>
            <div className="max-h-[520px] min-h-[320px] overflow-auto p-4">
              {tab === "preview" && <Yaml text={state?.yaml ?? ""} />}
              {tab === "pack" && <Code>{state ? JSON.stringify(state.board.config, null, 2) : ""}</Code>}
              {tab === "config" && <Ops />}
            </div>
          </div>

          <div className="min-w-0 bg-card p-4" data-testid="landing-preview">
            {state ? (
              <BoardProvider key={adapter} board={state.board} catalogue={state.catalogue} host={host} editable={false} charts={charts ?? svgFallback}>
                <Board />
              </BoardProvider>
            ) : (
              <div className="grid h-[340px] place-items-center font-mono text-xs text-muted-foreground">building the board…</div>
            )}
          </div>
        </div>
      </Row>
    </section>
  );
}

// Long join clauses would dictate the panel's width; the pack's shape is what
// matters here, and the whole file is one click away in the demo.
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** The pack, with every declared key given the treatment it keeps everywhere. */
function Yaml({ text }: { text: string }) {
  if (!text) return <div className="font-mono text-xs text-muted-foreground">…</div>;
  const lines = text.split("\n").slice(0, 46);
  return (
    <pre className="overflow-x-auto font-mono text-xs leading-[1.7]">
      {lines.map((line, i) => {
        const m = /^(\s*-?\s*\{?\s*key:\s*)([a-z_][a-z0-9_]*)(.*)$/.exec(line);
        if (m)
          return (
            <div key={i}>
              <span className="text-muted-foreground">{m[1]}</span>
              <K>{m[2]}</K>
              <span className="text-muted-foreground">{clip(m[3]!, 30)}</span>
            </div>
          );
        const isComment = /^\s*#/.test(line);
        const head = /^([a-z_]+):/.exec(line);
        return (
          <div key={i} className={isComment ? "text-muted-foreground/70" : head ? "text-foreground" : "text-muted-foreground"}>
            {line.length > 72 ? `${line.slice(0, 72)}…` : line || " "}
          </div>
        );
      })}
      <div className="pt-2 text-muted-foreground/70">… the whole pack is 40 lines</div>
    </pre>
  );
}

function Code({ children }: { children: string }) {
  return <pre className="overflow-x-auto font-mono text-xs leading-[1.7] text-muted-foreground">{children || "…"}</pre>;
}

const SENT_OPS = `{ "op": "add_widget", "id": "revenue_30d",
  "widget": { "kind": "kpi", "title": "Revenue, last 30 days",
    "query": { "kind": "value", "measure": "revenue",
               "compare": "previous_period",
               "time": { "last": "30d" } } },
  "placement": { "place": "top", "width": "quarter" } }`;

function Ops() {
  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-muted-foreground">
        The model never emits SQL or markup. It emits one of eight operations, and every string in it must already be in the catalogue.
      </p>
      <pre className="overflow-x-auto font-mono text-xs leading-[1.7] text-muted-foreground">{SENT_OPS}</pre>
    </div>
  );
}

// ── the refusal, live ──────────────────────────────────────────────────────
// The most distinctive thing lenspack does is decline. This asks the real
// compiler and prints what it actually says.

type Probe = { ask: string; q: Query };
const PROBES: Probe[] = [
  { ask: "revenue by country", q: { kind: "breakdown", dimension: "country", measure: "revenue", limit: 10, sort: "desc" } },
  { ask: "revenue by product category", q: { kind: "breakdown", dimension: "category", measure: "revenue", limit: 10, sort: "desc" } },
  { ask: "revenue by contry", q: { kind: "breakdown", dimension: "contry", measure: "revenue", limit: 10, sort: "desc" } },
  { ask: "median order value", q: { kind: "value", measure: "median_order" } },
];

type Verdict = { ok: boolean; sql?: string; code?: string; error?: string; nearest?: string };

function Refusals() {
  const [i, setI] = React.useState(0);
  const [verdict, setVerdict] = React.useState<Verdict | null>(null);
  React.useEffect(() => {
    setVerdict(null);
    const probe = PROBES[i]!;
    void api(`/commerce/explain?q=${encodeURIComponent(JSON.stringify(probe.q))}`).then(setVerdict);
  }, [i]);

  return (
    <section className="border-b border-rule py-14">
      <Row label="the refusal">
        <h2 className="max-w-[30ch] font-mono text-lg font-semibold tracking-[-0.02em] text-foreground md:text-xl">
          A closed vocabulary is only useful if something enforces it.
        </h2>
        <p className="mt-4 max-w-[62ch] text-base">
          Ask for something the pack cannot answer and the compiler declines, names the reason, and points at the nearest key that exists. Every
          answer below comes from the running compiler, not from a screenshot.
        </p>

        <div className="mt-8 grid grid-cols-1 gap-px border border-rule bg-rule lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
          <div className="bg-card">
            {PROBES.map((p, n) => (
              <button
                key={p.ask}
                onClick={() => setI(n)}
                aria-pressed={i === n}
                className={`block w-full border-b border-rule px-4 py-3 text-left font-mono text-xs last:border-b-0 ${i === n ? "bg-declared-soft text-declared" : "text-muted-foreground hover:text-foreground"}`}
              >
                {p.ask}
              </button>
            ))}
          </div>
          <div className="min-h-[188px] bg-card p-5">
            {!verdict ? (
              <div className="font-mono text-xs text-muted-foreground">compiling…</div>
            ) : verdict.ok ? (
              <div>
                <p className="mb-3 font-mono text-xs text-declared">compiled</p>
                <pre className="whitespace-pre-wrap break-all font-mono text-2xs leading-[1.7] text-muted-foreground">{verdict.sql?.split("\n").slice(0, 7).join("\n")}</pre>
              </div>
            ) : (
              <div>
                <p className="mb-3 font-mono text-xs">
                  <span className="refusal">⊘ {verdict.code}</span>
                </p>
                <p className="max-w-[64ch] text-sm leading-relaxed text-foreground">{verdict.error}</p>
                {verdict.nearest && (
                  <p className="mt-3 text-sm">
                    nearest key that exists: <K>{verdict.nearest}</K>
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      </Row>
    </section>
  );
}

// ── three steps: a genuine sequence, so it is numbered ─────────────────────

function FirstBoard() {
  const steps = [
    {
      t: "Describe the data once",
      b: (
        <>
          Entities, dimensions, measures and the direction of every join. A human writes this and reviews it in git; the model never edits it. The{" "}
          <K>many_to_one</K> on a join is what lets the compiler refuse a fan-out later.
        </>
      ),
      code: `entities:
  orders:
    source: orders
    grain: one row per order
    time: placed_at
    joins:
      - to: customers
        on: orders.customer_id = customers.id
        type: many_to_one
measures:
  - { key: revenue, entity: orders,
      agg: sum, sql: total_cents / 100.0 }
  - { key: refund_rate, entity: orders,
      agg: avg, sql: "(status = 'refunded')::int" }`,
    },
    {
      t: "Point a model at it",
      b: (
        <>
          Any MCP client, or the same tools inside your own agent. A small model is enough: on the hardest example pack, five models under 30B
          parameters pass nine or ten of ten build tasks.
        </>
      ),
      code: `npx lenspack-mcp --pack packs/commerce.yaml --db ./commerce.duckdb`,
    },
    {
      t: "Render it",
      b: (
        <>
          The renderer is the only code. It never reaches a database or a model — data arrives through host callbacks — and the charting library is
          an adapter you choose.
        </>
      ),
      code: `<BoardProvider
  board={board}
  catalogue={catalogue}
  host={host}
  charts={rechartsAdapter}
>
  <FilterBar />
  <Board />
</BoardProvider>`,
    },
  ];
  return (
    <section className="border-b border-rule py-14">
      <Row label="how it goes">
        <h2 className="font-mono text-lg font-semibold tracking-[-0.02em] text-foreground md:text-xl">Three steps, and only the first is yours</h2>
        <div className="mt-10 space-y-12">
          {steps.map((s, i) => (
            <div key={s.t} className="grid grid-cols-1 gap-x-8 gap-y-4 lg:grid-cols-[minmax(0,44ch)_minmax(0,1fr)]">
              <div>
                <div className="flex items-baseline gap-3">
                  <span className="font-mono text-xs text-muted-foreground">{i + 1}</span>
                  <h3 className="text-lg font-medium tracking-[-0.01em] text-foreground">{s.t}</h3>
                </div>
                <p className="mt-3 pl-7 text-sm leading-relaxed">{s.b}</p>
              </div>
              <pre className="overflow-x-auto border border-rule bg-card p-4 font-mono text-2xs leading-[1.75] text-muted-foreground">{s.code}</pre>
            </div>
          ))}
        </div>
      </Row>
    </section>
  );
}

const PACKS = [
  { id: "commerce", board: "overview", line: "A star schema, money and ratios — and a fan-out trap the compiler refuses." },
  { id: "events", board: "traffic", line: "One wide table: every time grain, distinct counts, a high-cardinality dimension." },
  { id: "consultation", board: "committee", line: "Multilingual text with JSON metadata, multi-tenancy, LLM-derived themes as joined dimensions." },
  { id: "tickets", board: "desk", line: "State history, durations, an SLA breach rate, a funnel read from transitions." },
  { id: "hcm", board: "campaign", line: "A deliberately awkward registry: epoch-millisecond times, soft deletes, dotted hierarchies." },
];

function Packs() {
  return (
    <section className="border-b border-rule py-14">
      <Row label="five packs">
        <h2 className="font-mono text-lg font-semibold tracking-[-0.02em] text-foreground md:text-xl">Five shapes of data, one renderer</h2>
        <p className="mt-4 max-w-[62ch] text-base">
          Each one stresses a different axis of the abstraction, and each is synthetic and seeds in seconds. They are also the test suite: every board
          below runs on Postgres and DuckDB in CI and the results must match.
        </p>
        <ul className="mt-8 border-t border-rule">
          {PACKS.map((p) => (
            <li key={p.id}>
              <a
                href={`/app?example=${p.id}&board=${p.board}`}
                className="group grid grid-cols-1 items-baseline gap-x-6 gap-y-1 border-b border-rule py-4 sm:grid-cols-[140px_minmax(0,1fr)_auto] hover:bg-accent"
              >
                <span className="font-mono text-sm text-declared">{p.id}</span>
                <span className="text-sm">{p.line}</span>
                <span className="font-mono text-xs text-muted-foreground group-hover:text-foreground">open</span>
              </a>
            </li>
          ))}
        </ul>
      </Row>
    </section>
  );
}

const CHECKS: [string, string][] = [
  ["Two engines, one answer", "Every example board runs on Postgres and DuckDB; results must match after normalisation."],
  ["One ops suite, five packs", "The core's tests run parametrised over every catalogue, not just the one it was written for."],
  ["Zero-domain grep", "CI fails if the core or the compiler contains a word from any example domain."],
  ["Pack conformance", "Every dimension × measure × shape compiles or fails with a documented reason; declared fan-outs are refused; tenancy is present."],
  ["The next pack", "Writing a pack for a new dataset takes under an hour and changes nothing under packages/."],
];

function Conformance() {
  return (
    <section className="border-b border-rule py-14">
      <Row label="what holds">
        <h2 className="font-mono text-lg font-semibold tracking-[-0.02em] text-foreground md:text-xl">Claims that fail the build when they stop being true</h2>
        <p className="mt-4 max-w-[62ch] text-base">
          lenspack came out of a consultation tool whose dashboard logic was welded to one schema. These five checks are what keep the abstraction
          honest now that it is not.
        </p>
        <table className="mt-8 w-full border-collapse text-left">
          <tbody>
            {CHECKS.map(([t, d]) => (
              <tr key={t} className="border-b border-rule align-baseline first:border-t">
                <th scope="row" className="w-[240px] py-4 pr-6 text-sm font-medium text-foreground">
                  {t}
                </th>
                <td className="py-4 text-sm">{d}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Row>
    </section>
  );
}

function Guarantees() {
  const lines = [
    <>
      The model's only outputs are operations and queries — closed unions, validated before anything reaches a database.
    </>,
    <>
      Every identifier in the emitted SQL comes from the pack; every value is a bound parameter; a <K>LIMIT</K> is always present.
    </>,
    <>Tenancy is structural: an entity that declares a tenant cannot be queried without one, so there is no forgot-to-filter state.</>,
    <>
      Raw SQL is off by default. Switched on it is read-only, timeboxed, capped, and its results can never become a widget.
    </>,
    <>No URLs, no markup and no colour values in any board. Text renders as text; a scheme name maps to a CSS variable.</>,
  ];
  return (
    <section className="py-14">
      <Row label="the guarantees">
        <ul className="space-y-4 border-t border-rule pt-6">
          {lines.map((l, i) => (
            <li key={i} className="max-w-[72ch] text-base leading-relaxed">
              {l}
            </li>
          ))}
        </ul>
        <a className="mt-8 inline-block border-b border-declared pb-0.5 font-mono text-xs text-declared" href="https://github.com/theflywheel/lenspack/blob/main/docs/security.md">
          The security model in full
        </a>
      </Row>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-rule py-8">
      <Row>
        <div className="flex flex-wrap items-center justify-between gap-3 font-mono text-xs text-muted-foreground">
          <span>
            lenspack · Apache-2.0 · built by{" "}
            <a className="text-foreground hover:text-declared" href="https://theflywheel.in">
              The Flywheel
            </a>
          </span>
          <span className="flex gap-5">
            <a className="hover:text-foreground" href="https://github.com/theflywheel/lenspack">
              GitHub
            </a>
            <a className="hover:text-foreground" href="https://github.com/theflywheel/lenspack/blob/main/docs/writing-a-pack.md">
              Writing a pack
            </a>
            <a className="hover:text-foreground" href="/app">
              Demo
            </a>
          </span>
        </div>
      </Row>
    </footer>
  );
}
