import * as React from "react";

import { ArrowUp, ChevronDown, History, LayoutGrid, RotateCcw, SendHorizontal, X } from "lucide-react";

import type { Board as BoardT, BoardOp, Catalogue } from "@lenspack/core";
import { opSchema } from "@lenspack/core";
import { Board, BoardProvider, DrillPath, useBoard, useBoardOps, type BoardHost, type BoardVersion, type ChartAdapter, type FilterOption, type WidgetData } from "@lenspack/react";

import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { Input } from "./components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover";
import { ScrollArea } from "./components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { Separator } from "./components/ui/separator";

// The board app, built from shadcn components. The board itself is rendered
// by @lenspack/react; everything around it — chat, ops, filters, history —
// is host UI, and the provider's hooks give it all it needs.

import { ADAPTER_NAMES, type AdapterName, isAdapter, useChartAdapter } from "./adapters";
import type { ModelInfo } from "./chat";

const ChatPanel = React.lazy(() => import("./chat").then((m) => ({ default: m.ChatPanel })));

const api = async (path: string, init?: RequestInit) => {
  const r = await fetch(`/api${path}`, { headers: { "content-type": "application/json" }, ...init });
  return r.json();
};

// The same eight ops a model emits, typed as JSON: anything can drive a board.
function OpsBox() {
  const { apply } = useBoardOps();
  const [text, setText] = React.useState('{"op":"set_title","title":"Renamed from the ops box"}');
  const [err, setErr] = React.useState<string | null>(null);
  return (
    <div className="space-y-1">
      <form
        className="flex items-center gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const parsed = opSchema.parse(JSON.parse(text)) as BoardOp;
            const r = await apply([parsed]);
            setErr(r.ok ? null : `${r.error}${r.hint ? ` — did you mean ${r.hint}?` : ""}`);
          } catch (ex) {
            setErr(ex instanceof Error ? ex.message : String(ex));
          }
        }}
      >
        <Input value={text} onChange={(e) => setText(e.target.value)} className="h-8 font-mono text-xs" aria-label="Board op as JSON" />
        <Button type="submit" variant="secondary" size="sm" className="h-8">
          <ArrowUp /> Apply op
        </Button>
      </form>
      {err && <p className="text-xs text-destructive">{err}</p>}
    </div>
  );
}

// Filter bar on shadcn Select. What a board filters by is configuration;
// what you have selected is not, and lives in the provider.
function FilterBar() {
  const { board, selections, setSelection, clearSelections, host, catalogue } = useBoard();
  const filters = board.config.filters;
  const [options, setOptions] = React.useState<Record<string, FilterOption[]>>({});
  React.useEffect(() => {
    if (!host.loadFilterOptions) return;
    let cancelled = false;
    for (const f of filters) void host.loadFilterOptions(f.field).then((o) => !cancelled && setOptions((prev) => ({ ...prev, [f.field]: o })));
    return () => {
      cancelled = true;
    };
  }, [host, filters]);
  const drilling = Object.values(catalogue.hierarchies ?? {}).some((ls) => ls.some((l) => selections[l]));
  if (filters.length === 0 && !drilling) return null;
  const active = filters.some((f) => selections[f.field]);
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2" data-testid="lp-filter-bar">
      <DrillPath />
      {filters.map((f) => (
        <div key={f.id} className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">{f.label}</span>
          <Select value={selections[f.field] ?? "__all__"} onValueChange={(v) => setSelection(f.field, v === "__all__" ? "" : v)}>
            <SelectTrigger size="sm" className="min-w-32" data-testid={`filter-${f.field}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All</SelectItem>
              {(options[f.field] ?? []).map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.value} <span className="text-muted-foreground">({o.count.toLocaleString()})</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ))}
      {active && (
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={clearSelections}>
          <X /> Clear
        </Button>
      )}
    </div>
  );
}

// Density and packing: the same set_layout_mode op the chat uses.
function LayoutMode() {
  const { board, apply } = useBoard();
  const mode = board.config.grid.fill ? "packed" : board.config.grid.density;
  return (
    <Select
      value={mode}
      onValueChange={(v) => void apply([{ op: "set_layout_mode", density: v === "comfortable" ? "comfortable" : "compact", fill: v === "packed" }])}
    >
      <SelectTrigger size="sm" aria-label="Layout density" data-testid="density-select">
        <LayoutGrid className="text-muted-foreground" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="comfortable">Comfortable</SelectItem>
        <SelectItem value="compact">Compact</SelectItem>
        <SelectItem value="packed">Packed</SelectItem>
      </SelectContent>
    </Select>
  );
}

// Version history in a popover. Rolling back appends rather than rewinds,
// so a rollback can itself be undone.
function VersionHistory({ onReverted }: { onReverted: () => void }) {
  const { board, host, previewing, preview } = useBoard();
  const [versions, setVersions] = React.useState<BoardVersion[]>([]);
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState<number | null>(null);
  const latest = versions[0]?.version;
  React.useEffect(() => {
    if (open && host.loadVersions) void host.loadVersions().then(setVersions);
  }, [open, host, board.version]);
  if (!host.loadVersions) return null;
  const restore = async (version: number) => {
    setBusy(version);
    await host.revertTo!(version);
    setBusy(null);
    setOpen(false);
    preview(null);
    onReverted();
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" data-testid="history-toggle">
          <History /> v{board.version}
          {previewing && <span className="text-muted-foreground">(viewing)</span>}
          <ChevronDown className="opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        {/* A plain scrolling box: the list must stay inside the popover. */}
        <div className="max-h-96 overflow-y-auto overscroll-contain p-2" data-testid="version-history">
          {versions.map((v) => {
            const shown = v.version === board.version;
            const isLatest = v.version === latest;
            return (
              <button
                type="button"
                key={v.version}
                data-testid={`version-${v.version}`}
                aria-current={shown ? "true" : undefined}
                // Clicking a version shows it; nothing changes until Restore.
                onClick={() => preview(isLatest ? null : v)}
                className={`flex w-full items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-accent ${shown ? "bg-accent" : ""}`}
              >
                <div className="min-w-0 flex-1 text-sm">
                  <p>
                    <span className="font-mono text-xs">v{v.version}</span> {v.summary || "no change recorded"}
                    {isLatest && <span className="ml-1 text-xs text-muted-foreground">(current)</span>}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {v.source === "chat" ? "by chat" : v.source === "revert" ? "rollback" : v.source === "layout" ? "by hand" : v.source} · {v.createdAt.toLocaleString()}
                  </p>
                </div>
                {!isLatest && host.revertTo && (
                  <span
                    role="button"
                    tabIndex={0}
                    className="inline-flex h-7 items-center gap-1 rounded px-2 text-xs hover:bg-background"
                    data-testid={`restore-${v.version}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (busy === null) void restore(v.version);
                    }}
                  >
                    <RotateCcw className="size-3" /> {busy === v.version ? "…" : "restore"}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** While an older version is shown: say so, and offer the two ways out. */
function PreviewBanner({ onReverted }: { onReverted: () => void }) {
  const { previewing, preview, host } = useBoard();
  const [busy, setBusy] = React.useState(false);
  if (!previewing) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed px-3 py-2 text-sm" data-testid="preview-banner">
      <span>
        Viewing <span className="font-mono">v{previewing.version}</span> — read-only. {previewing.summary}
      </span>
      <span className="flex-1" />
      <Button variant="ghost" size="sm" onClick={() => preview(null)}>
        Back to current
      </Button>
      {host.revertTo && (
        <Button
          size="sm"
          disabled={busy}
          data-testid="preview-restore"
          onClick={async () => {
            setBusy(true);
            await host.revertTo!(previewing.version);
            setBusy(false);
            preview(null);
            onReverted();
          }}
        >
          <RotateCcw /> Restore this version
        </Button>
      )}
    </div>
  );
}

type Catalog = { example: string; description?: string; boards: { id: string; title: string }[] }[];

export function App() {
  const params = new URLSearchParams(location.search);
  const [catalog, setCatalog] = React.useState<Catalog>([]);
  const [chatEnabled, setChatEnabled] = React.useState(false);
  const [models, setModels] = React.useState<ModelInfo[]>([]);
  const [model, setModel] = React.useState<string>(params.get("model") ?? "");
  const [example, setExample] = React.useState<string>(params.get("example") ?? "");
  const [boardId, setBoardId] = React.useState<string>(params.get("board") ?? "");
  const [adapterName, setAdapterName] = React.useState<AdapterName>(isAdapter(params.get("charts")) ? (params.get("charts") as AdapterName) : "recharts");
  const charts = useChartAdapter(adapterName);
  const [state, setState] = React.useState<{ board: BoardT; catalogue: Catalogue } | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);

  React.useEffect(() => {
    void api("/").then((r) => {
      setCatalog(r.examples);
      setChatEnabled(!!r.chat);
      const ms: ModelInfo[] = r.models ?? [];
      setModels(ms);
      // First available provider is the default; a URL choice wins if it exists.
      if (!ms.some((m) => m.name === model)) setModel(ms.find((m) => m.available !== false)?.name ?? ms[0]?.name ?? "");
      // A URL naming an example this server has not seeded falls back to the
      // first one it has, rather than loading forever.
      const known = r.examples.find((e: { example: string }) => e.example === example) ?? r.examples[0];
      if (!known) return setProblem("No examples are seeded on this server. Run: pnpm seed commerce ./commerce.duckdb");
      if (known.example !== example || !known.boards.some((b: { id: string }) => b.id === boardId)) {
        setExample(known.example);
        setBoardId(known.boards[0]?.id ?? "");
      }
    });
  }, []);

  const base = `/${example}/${boardId}`;
  // The first paint needs the board, its data and its filter options: one
  // request brings all three, and the host serves them from this primer.
  const primer = React.useRef<{ config: string; data: Record<string, WidgetData>; options: Record<string, FilterOption[]> } | null>(null);
  const reloadBoard = React.useCallback(
    (withData = false) => {
      void api(`${base}${withData ? "?include=data,options" : ""}`).then((r) => {
        if (!r.board) return setProblem(r.error ?? "This board does not exist");
        setProblem(null);
        if (withData && r.data) primer.current = { config: JSON.stringify(r.board.config), data: r.data, options: r.options ?? {} };
        setState({ board: { ...r.board, updatedAt: new Date(r.board.updatedAt) }, catalogue: r.catalogue });
      });
    },
    [base],
  );
  // The board loads when the board changes, and only then: the chart library
  // and the model are view choices, not a reason to fetch it again.
  React.useEffect(() => {
    if (!example || !boardId) return;
    reloadBoard(true);
  }, [example, boardId, reloadBoard]);
  React.useEffect(() => {
    if (!example || !boardId) return;
    history.replaceState(null, "", `/app?example=${example}&board=${boardId}&charts=${adapterName}${model ? `&model=${encodeURIComponent(model)}` : ""}`);
  }, [example, boardId, adapterName, model]);

  const host = React.useMemo<BoardHost>(
    () => ({
      loadBoardData: (config, selections) => {
        const p = primer.current;
        if (p && Object.keys(selections).length === 0 && JSON.stringify(config) === p.config) {
          // Used once: a refresh or a new selection asks the server.
          primer.current = { ...p, config: "" };
          return Promise.resolve(p.data);
        }
        return api(`${base}/data?${new URLSearchParams(Object.fromEntries(Object.entries(selections).map(([k, v]) => [`f_${k}`, v])))}`);
      },
      applyOps: async (ops) => {
        const r = await api(`${base}/ops`, { method: "POST", body: JSON.stringify({ ops }) });
        if (r.ok) r.board.updatedAt = new Date(r.board.updatedAt);
        return r;
      },
      saveLayout: async (layout) => {
        const b = await api(`${base}/layout`, { method: "POST", body: JSON.stringify({ layout }) });
        return { ...b, updatedAt: new Date(b.updatedAt) };
      },
      loadFilterOptions: (field) => {
        const hit = primer.current?.options[field];
        return hit ? Promise.resolve(hit) : api(`${base}/options?field=${encodeURIComponent(field)}`);
      },
      loadVersions: async () => (await api(`${base}/versions`)).map((v: { createdAt: string }) => ({ ...v, createdAt: new Date(v.createdAt) })),
      revertTo: async (version) => {
        const b = await api(`${base}/revert`, { method: "POST", body: JSON.stringify({ version }) });
        return b ? { ...b, updatedAt: new Date(b.updatedAt) } : null;
      },
    }),
    [base],
  );

  const current = catalog.find((c) => c.example === example);
  const suggestions = React.useMemo(() => {
    if (!state) return [];
    const m = state.catalogue.measures;
    const d = state.catalogue.dimensions.filter((x) => x.type !== "time");
    const timed = m.find((x) => state.catalogue.entities.find((e) => e.key === x.entity)?.hasTime) ?? m[0];
    return [
      `Add a KPI for ${m[0]?.label.toLowerCase()} across the top`,
      d[0] && m[1] ? `Show ${m[1].label.toLowerCase()} by ${d[0].label.toLowerCase()} as a bar chart` : "",
      timed ? `Plot ${timed.label.toLowerCase()} per week for the last 12 weeks` : "",
      "Make the first chart full width",
    ].filter(Boolean);
  }, [state]);

  if (problem) return <div className="mx-auto max-w-6xl p-6 text-sm text-destructive">{problem}</div>;
  if (!state || !charts) return <div className="mx-auto max-w-6xl p-6 text-sm text-muted-foreground">Loading…</div>;

  // Board only, for screenshots and embeds.
  if (params.get("chrome") === "0")
    return (
      <div className="min-h-screen bg-background p-4 text-foreground font-sans antialiased">
        <BoardProvider key={`${base}:${state.board.version}`} board={state.board} catalogue={state.catalogue} host={host} editable={false} charts={charts}>
          <h1 className="mb-3 text-lg font-semibold tracking-tight">{state.board.config.title}</h1>
          <Board />
        </BoardProvider>
      </div>
    );

  return (
    <div className="min-h-screen bg-background text-foreground font-sans antialiased">
      <header className="sticky top-0 z-30 border-b border-rule bg-background/95 backdrop-blur-sm">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <a href="/" className="font-mono text-base font-semibold tracking-tight text-foreground">
              lenspack
            </a>
            <span className="font-mono text-xs text-muted-foreground">/ demo</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={example}
              onValueChange={(v) => {
                const next = catalog.find((c) => c.example === v);
                setExample(v);
                setBoardId(next?.boards[0]?.id ?? "");
              }}
            >
              <SelectTrigger size="sm" className="w-36 font-mono text-xs" aria-label="Example pack"><SelectValue /></SelectTrigger>
              <SelectContent>{catalog.map((c) => <SelectItem key={c.example} value={c.example}>{c.example}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={boardId} onValueChange={setBoardId}>
              <SelectTrigger size="sm" className="w-52 text-xs" aria-label="Board"><SelectValue /></SelectTrigger>
              <SelectContent>{(current?.boards ?? []).map((b) => <SelectItem key={b.id} value={b.id}>{b.title}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={adapterName} onValueChange={(v) => setAdapterName(v as AdapterName)}>
              <SelectTrigger size="sm" className="w-40 font-mono text-xs" aria-label="Charting library" data-testid="charts-select"><SelectValue /></SelectTrigger>
              <SelectContent>{ADAPTER_NAMES.map((n) => <SelectItem key={n} value={n}>charts: {n}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6">
        <div className={chatEnabled ? "grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]" : ""}>
          <div className={chatEnabled ? "order-1 min-w-0" : "min-w-0"}>
            <BoardProvider key={`${base}:${state.board.version}`} board={state.board} catalogue={state.catalogue} host={host} charts={charts}>
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h1 className="font-mono text-lg font-semibold tracking-[-0.02em] text-foreground">{state.board.config.title}</h1>
                  {current?.description && <p className="mt-1 max-w-[70ch] text-sm text-muted-foreground">{current.description}</p>}
                </div>
                <div className="flex items-center gap-2">
                  <LayoutMode />
                  <VersionHistory onReverted={() => reloadBoard()} />
                </div>
              </div>
              <div className="space-y-3">
                <PreviewBanner onReverted={() => reloadBoard()} />
                <FilterBar />
                <details className="group">
                  <summary className="w-fit cursor-pointer list-none font-mono text-xs text-muted-foreground hover:text-foreground">
                    <span className="group-open:hidden">Edit with an operation instead</span>
                    <span className="hidden group-open:inline">Operation</span>
                  </summary>
                  <div className="mt-2">
                    <OpsBox />
                  </div>
                </details>
              </div>
              <Separator className="my-4" />
              <Board showQueries />
            </BoardProvider>
          </div>
          {chatEnabled && (
            <div className="order-2 min-w-0">
              <React.Suspense fallback={<div className="rounded-md border p-4 text-sm text-muted-foreground">Loading chat…</div>}>
                <ChatPanel key={`${base}:${model}`} base={base} suggestions={suggestions} onTurnEnd={() => reloadBoard()} models={models} model={model} onModelChange={setModel} />
              </React.Suspense>
            </div>
          )}
        </div>
      </main>
      <footer className="mx-auto max-w-7xl px-4 pb-10 text-xs text-muted-foreground">
        <a className="underline underline-offset-4" href="/">lenspack</a> — a dashboard is data, not code. Build boards with the chat, edit with the ops box, drag widgets, restore versions, switch the charting library.
      </footer>
    </div>
  );
}
