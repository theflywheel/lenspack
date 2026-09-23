import * as React from "react";

import type { Board as BoardT, Catalogue } from "@lenspack/core";
import { Board, BoardProvider, type BoardHost, type ChartAdapter } from "@lenspack/react";

// The home page, in the register of a component library's docs: short claims,
// a live preview beside the code that produced it, and steps you can follow.

const api = async (path: string) => (await fetch(`/api${path}`)).json();

export function Landing({ adapters }: { adapters: Record<string, ChartAdapter> }) {
  return (
    <div className="min-h-screen bg-background text-foreground font-sans antialiased">
      <Nav />
      <main className="mx-auto max-w-6xl px-6">
        <Hero />
        <Preview adapters={adapters} />
        <FirstBoard />
        <Packs />
        <Generic />
        <Security />
      </main>
      <Footer />
    </div>
  );
}

function Nav() {
  return (
    <header className="sticky top-0 z-30 border-b border-border/60 bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
        <a href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="inline-block h-5 w-5 rounded-sm bg-primary" aria-hidden />
          lenspack
        </a>
        <nav className="flex items-center gap-1 text-sm">
          <a className="rounded-md px-3 py-1.5 text-muted-foreground hover:text-foreground" href="https://github.com/theflywheel/lenspack/blob/main/docs/pack-spec.md">Docs</a>
          <a className="rounded-md px-3 py-1.5 text-muted-foreground hover:text-foreground" href="https://github.com/theflywheel/lenspack">GitHub</a>
          <a className="ml-2 rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground hover:opacity-90" href="/app">Open the demo</a>
        </nav>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="py-16 md:py-24">
      <p className="mb-3 text-sm font-medium text-muted-foreground">Open source · Apache-2.0 · Postgres and DuckDB</p>
      <h1 className="max-w-3xl text-4xl font-bold tracking-tight md:text-6xl">A dashboard is data, not code.</h1>
      <p className="mt-6 max-w-2xl text-lg text-muted-foreground">
        Describe your data once in a pack. Any model, any chat, any MCP client can then build and edit boards over it — without ever writing SQL, JSX or a colour value. What the model cannot express, it cannot break.
      </p>
      <div className="mt-8 flex flex-wrap items-center gap-3">
        <a href="/app" className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">Try the live demo</a>
        <a href="https://github.com/theflywheel/lenspack" className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-accent">Read the source</a>
      </div>
      <Install />
    </section>
  );
}

function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex h-9 items-center rounded-lg bg-muted p-1 text-muted-foreground" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={`rounded-md px-3 py-1 text-sm font-medium transition-colors ${value === t.id ? "bg-background text-foreground shadow-sm" : "hover:text-foreground"}`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function Code({ children, lang = "bash" }: { children: string; lang?: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg border border-border bg-muted/50 p-4 font-mono text-[13px] leading-6" data-lang={lang}>
      <code>{children}</code>
    </pre>
  );
}

function Install() {
  const [tab, setTab] = React.useState<"pnpm" | "npm" | "mcp">("pnpm");
  const cmd = {
    pnpm: "pnpm add @lenspack/core @lenspack/spec @lenspack/sql @lenspack/react",
    npm: "npm install @lenspack/core @lenspack/spec @lenspack/sql @lenspack/react",
    mcp: "npx lenspack-mcp --pack ./packs/commerce.yaml --db ./commerce.duckdb",
  }[tab];
  return (
    <div className="mt-10 max-w-2xl">
      <Tabs tabs={[{ id: "pnpm", label: "pnpm" }, { id: "npm", label: "npm" }, { id: "mcp", label: "MCP client" }]} value={tab} onChange={setTab} />
      <div className="mt-2">
        <Code>{cmd}</Code>
      </div>
    </div>
  );
}

// The component-preview pattern: the live thing on one tab, what produced it
// on the others. The board is real, read-only, and rendered through whichever
// charting library you pick — the config underneath never changes.
function Preview({ adapters }: { adapters: Record<string, ChartAdapter> }) {
  const [tab, setTab] = React.useState<"preview" | "pack" | "board">("preview");
  const [adapter, setAdapter] = React.useState("recharts");
  const [state, setState] = React.useState<{ board: BoardT; catalogue: Catalogue; yaml: string; data: Record<string, unknown> } | null>(null);
  React.useEffect(() => {
    void Promise.all([api("/commerce/overview/canonical"), api("/commerce/pack")]).then(([b, p]) =>
      setState({ board: { ...b.board, updatedAt: new Date(b.board.updatedAt) }, catalogue: b.catalogue, yaml: p.yaml, data: b.data }),
    );
  }, []);
  // The canonical board's data arrives with it; the preview never queries again.
  const host = React.useMemo<BoardHost>(() => ({ loadBoardData: async () => (state?.data ?? {}) as never }), [state]);

  return (
    <section className="py-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">One board, four charting libraries</h2>
          <p className="mt-1 text-sm text-muted-foreground">A real board from the <code className="font-mono">commerce</code> pack. Switch the library; the board config is untouched.</p>
        </div>
        <div className="flex items-center gap-3">
          <Tabs tabs={Object.keys(adapters).map((id) => ({ id, label: id }))} value={adapter} onChange={setAdapter} />
        </div>
      </div>
      <Tabs tabs={[{ id: "preview", label: "Preview" }, { id: "pack", label: "pack.yaml" }, { id: "board", label: "board.json" }]} value={tab} onChange={setTab} />
      <div className="mt-2 overflow-hidden rounded-xl border border-border bg-card">
        {tab === "preview" && (
          <div className="p-4 md:p-6" data-testid="landing-preview">
            {state ? (
              <BoardProvider key={adapter} board={state.board} catalogue={state.catalogue} host={host} editable={false} charts={adapters[adapter]!}>
                <Board />
              </BoardProvider>
            ) : (
              <p className="p-10 text-center text-sm text-muted-foreground">Loading the board…</p>
            )}
          </div>
        )}
        {tab === "pack" && <Code lang="yaml">{state?.yaml ?? "…"}</Code>}
        {tab === "board" && <Code lang="json">{state ? JSON.stringify(state.board.config, null, 2) : "…"}</Code>}
      </div>
      <p className="mt-3 text-sm text-muted-foreground">
        The model only ever names keys from the pack and emits one of eight ops. The compiler refuses what the pack cannot answer — a fan-out, a missing tenant, a typo — with the nearest real key.{" "}
        <a className="underline underline-offset-4" href="/app?example=commerce&board=overview">Edit this board with chat →</a>
      </p>
    </section>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="relative border-l border-border pl-8 pb-10 last:pb-0">
      <span className="absolute -left-4 top-0 flex h-8 w-8 items-center justify-center rounded-full border border-border bg-background font-mono text-sm">{n}</span>
      <h3 className="text-lg font-semibold tracking-tight">{title}</h3>
      <div className="mt-3 space-y-3 text-sm text-muted-foreground [&_pre]:text-foreground">{children}</div>
    </div>
  );
}

function FirstBoard() {
  return (
    <section className="py-16">
      <h2 className="text-2xl font-semibold tracking-tight">Your first board</h2>
      <p className="mt-1 mb-8 text-sm text-muted-foreground">Three steps. The pack is the only place a domain is described; everything after it is generic.</p>
      <div className="max-w-3xl">
        <Step n={1} title="Describe your data in a pack">
          <p>Entities, dimensions, measures and joins — with their direction, so a fan-out can be refused instead of computed. Humans write the SQL fragments and review them in git.</p>
          <Code lang="yaml">{`pack: commerce
version: 1
entities:
  orders:
    source: orders
    grain: one row per order
    time: placed_at
    joins:
      - { to: customers, on: orders.customer_id = customers.id, type: many_to_one }
dimensions:
  - { key: country, entity: customers, sql: country, synonyms: [market, region] }
measures:
  - { key: revenue,     entity: orders, agg: sum, sql: total_cents / 100.0, format: currency }
  - { key: refund_rate, entity: orders, agg: avg, sql: "(status = 'refunded')::int", format: percent }`}</Code>
        </Step>
        <Step n={2} title="Let a model build the board">
          <p>Point any MCP client at the pack, or drop the same tools into your own agent. Every edit is a validated op; every refusal names the nearest real key.</p>
          <Code lang="json">{`{ "mcpServers": { "commerce": { "command": "npx",
    "args": ["lenspack-mcp", "--pack", "packs/commerce.yaml", "--db", "./commerce.duckdb"] } } }`}</Code>
          <p className="italic">“Put revenue for the last 30 days as a KPI across the top, weekly revenue below it, and a pie of line revenue by category.”</p>
        </Step>
        <Step n={3} title="Render it">
          <p>The renderer is the only code. It never touches a database or a model — data arrives through host callbacks — and the charting library is an adapter.</p>
          <Code lang="tsx">{`import { BoardProvider, Board, FilterBar } from "@lenspack/react";
import { rechartsAdapter } from "@lenspack/react/adapters/recharts";

<BoardProvider board={board} catalogue={catalogue} host={host} charts={rechartsAdapter}>
  <FilterBar />
  <Board />
</BoardProvider>`}</Code>
        </Step>
      </div>
    </section>
  );
}

const PACKS = [
  { id: "commerce", title: "commerce", blurb: "A star schema with money, ratios, percentiles — and a fan-out trap the compiler refuses.", board: "overview" },
  { id: "events", title: "events", blurb: "One wide table, every time grain, distinct counts, a high-cardinality dimension, a per-dialect fragment.", board: "traffic" },
  { id: "consultation", title: "consultation", blurb: "Multilingual submissions with JSON metadata, multi-tenancy, and LLM-derived themes as ordinary joined dimensions.", board: "committee" },
  { id: "tickets", title: "tickets", blurb: "State history, durations, an SLA breach rate as a filtered rate, a resolution rate as a ratio, a funnel.", board: "desk" },
];

function Packs() {
  return (
    <section className="py-8">
      <h2 className="text-2xl font-semibold tracking-tight">Four packs, four shapes of data</h2>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">Synthetic, seeded in seconds, and each one stresses a different axis of the abstraction.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        {PACKS.map((p) => (
          <a key={p.id} href={`/app?example=${p.id}&board=${p.board}`} className="group rounded-xl border border-border bg-card p-5 transition-colors hover:bg-accent">
            <div className="flex items-center justify-between">
              <h3 className="font-mono text-sm font-semibold">{p.title}</h3>
              <span className="text-xs text-muted-foreground group-hover:text-foreground">open →</span>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">{p.blurb}</p>
          </a>
        ))}
      </div>
    </section>
  );
}

const CHECKS = [
  ["Two engines, same answer", "Every example board runs on Postgres and DuckDB in CI; the results must match."],
  ["One ops suite, four packs", "The core's tests run parametrised over every catalogue."],
  ["Zero-domain grep", "CI fails if the core or the compiler contains a word from any example domain."],
  ["Pack conformance", "Every dimension × measure × query shape compiles, or fails with a documented reason; every declared fan-out is refused; tenancy is present."],
  ["The fifth pack", "Writing a pack for a new dataset should take under an hour and change nothing under packages/."],
];

function Generic() {
  return (
    <section className="py-16">
      <h2 className="text-2xl font-semibold tracking-tight">What “generic” means here</h2>
      <p className="mt-1 mb-6 max-w-2xl text-sm text-muted-foreground">
        lenspack was extracted from a public-consultation tool whose dashboard logic was hard-wired to one schema. Five CI checks keep the abstraction honest.
      </p>
      <ol className="grid gap-3 md:grid-cols-2">
        {CHECKS.map(([t, d], i) => (
          <li key={t} className="rounded-lg border border-border p-4">
            <div className="flex items-baseline gap-3">
              <span className="font-mono text-xs text-muted-foreground">0{i + 1}</span>
              <h3 className="font-medium">{t}</h3>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{d}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Security() {
  return (
    <section className="pb-20">
      <div className="rounded-xl border border-border bg-muted/40 p-6">
        <h2 className="text-lg font-semibold tracking-tight">The model’s only outputs are ops and queries — closed unions, validated before anything touches a database.</h2>
        <ul className="mt-3 grid gap-2 text-sm text-muted-foreground md:grid-cols-2">
          <li>No URLs, markup or colours in any config; text renders as text.</li>
          <li>Tenancy is structural: an entity that declares a tenant cannot be queried without one.</li>
          <li>Every identifier comes from the pack; every value is a bound parameter; LIMIT is always emitted.</li>
          <li><code className="font-mono">run_sql</code> is off by default; on, it is read-only, timeboxed, and can never become a widget.</li>
        </ul>
        <a className="mt-4 inline-block text-sm underline underline-offset-4" href="https://github.com/theflywheel/lenspack/blob/main/docs/security.md">Security model →</a>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-8 text-sm text-muted-foreground">
        <span>lenspack · Apache-2.0 · built by <a className="underline underline-offset-4" href="https://theflywheel.in">The Flywheel</a></span>
        <span className="flex gap-4">
          <a className="hover:text-foreground" href="https://github.com/theflywheel/lenspack">GitHub</a>
          <a className="hover:text-foreground" href="https://github.com/theflywheel/lenspack/blob/main/docs/writing-a-pack.md">Writing a pack</a>
          <a className="hover:text-foreground" href="/app">Demo</a>
        </span>
      </div>
    </footer>
  );
}
