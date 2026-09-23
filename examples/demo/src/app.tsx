import * as React from "react";

import { Chat, useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { ArrowUp, ChevronDown, History, RotateCcw, SendHorizontal, X } from "lucide-react";

import type { Board as BoardT, BoardOp, Catalogue } from "@lenspack/core";
import { opSchema } from "@lenspack/core";
import { Board, BoardProvider, useBoard, useBoardOps, type BoardHost, type BoardVersion, type ChartAdapter, type FilterOption } from "@lenspack/react";

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

const api = async (path: string, init?: RequestInit) => {
  const r = await fetch(`/api${path}`, { headers: { "content-type": "application/json" }, ...init });
  return r.json();
};

type Part = { type: string; state?: string; output?: unknown; errorText?: string; text?: string };

function StepBadge({ name, part }: { name: string; part: Part }) {
  const r = part.output as { applied?: boolean; ok?: boolean; error?: string; didYouMean?: string; version?: number } | undefined;
  const failed = part.errorText !== undefined || r?.applied === false || r?.ok === false;
  const pending = !part.errorText && part.state && part.state !== "output-available";
  return (
    <div className="flex items-start gap-2 text-xs">
      <Badge variant={failed ? "destructive" : r?.applied ? "default" : "secondary"} className="font-mono">{name}</Badge>
      <span className={failed ? "text-destructive" : "text-muted-foreground"}>
        {part.errorText ? part.errorText.slice(0, 160) : failed ? `${r?.error ?? ""}${r?.didYouMean ? ` — retrying with “${r.didYouMean}”` : ""}` : r?.applied ? `saved as v${r.version}` : pending ? "…" : ""}
      </span>
    </div>
  );
}

// Chat beside the thing it edits. The model only ever calls the board tools;
// when its turn ends the board is fetched again and re-rendered.
export type ModelInfo = { name: string; model: string; available: boolean | null; latencyMs?: number; error?: string };

export function ChatPanel({
  base,
  suggestions,
  onTurnEnd,
  models,
  model,
  onModelChange,
}: {
  base: string;
  suggestions: string[];
  onTurnEnd: () => void;
  models: ModelInfo[];
  model: string;
  onModelChange: (m: string) => void;
}) {
  const chat = React.useMemo(() => new Chat({ transport: new DefaultChatTransport({ api: `/api${base}/chat?model=${encodeURIComponent(model)}` }) }), [base, model]);
  const { messages, sendMessage, status, error } = useChat({ chat });
  const busy = status === "submitted" || status === "streaming";
  const [input, setInput] = React.useState("");
  const wasBusy = React.useRef(false);
  const bottom = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (wasBusy.current && !busy) onTurnEnd();
    wasBusy.current = busy;
  }, [busy, onTurnEnd]);
  React.useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages, busy]);
  const ask = (text: string) => {
    if (!text.trim() || busy) return;
    void sendMessage({ text });
    setInput("");
  };
  return (
    <Card className="sticky top-4 flex max-h-[calc(100vh-6rem)] flex-col gap-0 py-0" data-testid="chat">
      <CardHeader className="flex flex-row items-center justify-between gap-2 border-b py-3 [.border-b]:pb-3">
        <CardTitle className="shrink-0 whitespace-nowrap text-sm">Chat</CardTitle>
        {models.length > 1 && (
          <Select value={model} onValueChange={onModelChange}>
            <SelectTrigger size="sm" className="h-7 min-w-0 flex-1 text-xs [&>span]:truncate" aria-label="Model" data-testid="model-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {models.map((m) => (
                <SelectItem key={m.name} value={m.name} disabled={m.available === false}>
                  {m.name}
                  {m.available === false ? " (unavailable)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </CardHeader>
      <ScrollArea className="min-h-[160px] flex-1">
        <CardContent className="space-y-4 py-4">
          {messages.length === 0 && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">Describe what belongs on this board. Every change is a version, so nothing is hard to undo.</p>
              {suggestions.map((s) => (
                <Button key={s} variant="outline" size="sm" className="h-auto w-full justify-start whitespace-normal py-1.5 text-left text-xs font-normal" onClick={() => ask(s)}>
                  {s}
                </Button>
              ))}
            </div>
          )}
          {messages.map((m) => (
            <div key={m.id} className="space-y-1.5">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{m.role === "user" ? "You" : "lenspack"}</p>
              {(m.parts as Part[]).filter((p) => p.type.startsWith("tool-")).map((p, i) => (
                <StepBadge key={i} name={p.type.slice(5)} part={p} />
              ))}
              {(m.parts as Part[]).filter((p) => p.type === "text" && p.text?.trim()).map((p, i) => (
                <p key={i} className="text-sm leading-6">{p.text}</p>
              ))}
            </div>
          ))}
          {busy && <p className="text-xs text-muted-foreground">Working…</p>}
          {error && <p className="text-xs text-destructive">{error.message}</p>}
          <div ref={bottom} />
        </CardContent>
      </ScrollArea>
      <form
        className="flex items-center gap-2 border-t p-2"
        onSubmit={(e) => {
          e.preventDefault();
          ask(input);
        }}
      >
        <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Add a chart…" disabled={busy} className="h-8 text-sm" />
        <Button type="submit" size="icon" className="size-8" disabled={busy || !input.trim()} aria-label="Send">
          <SendHorizontal />
        </Button>
      </form>
    </Card>
  );
}

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
  const { board, selections, setSelection, clearSelections, host } = useBoard();
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
  if (filters.length === 0) return null;
  const active = filters.some((f) => selections[f.field]);
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2" data-testid="lp-filter-bar">
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

// Version history in a popover. Rolling back appends rather than rewinds,
// so a rollback can itself be undone.
function VersionHistory({ onReverted }: { onReverted: () => void }) {
  const { board, host } = useBoard();
  const [versions, setVersions] = React.useState<BoardVersion[]>([]);
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (open && host.loadVersions) void host.loadVersions().then(setVersions);
  }, [open, host, board.version]);
  if (!host.loadVersions) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" data-testid="history-toggle">
          <History /> v{board.version}
          <ChevronDown className="opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        <ScrollArea className="max-h-96">
          <div className="p-2" data-testid="version-history">
            {versions.map((v) => (
              <div key={v.version} className="flex items-start gap-2 rounded-md px-2 py-2 hover:bg-accent">
                <div className="min-w-0 flex-1 text-sm">
                  <p>
                    <span className="font-mono text-xs">v{v.version}</span> {v.summary || "no change recorded"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {v.source === "chat" ? "by chat" : v.source === "revert" ? "rollback" : v.source === "layout" ? "by hand" : v.source} · {v.createdAt.toLocaleString()}
                  </p>
                </div>
                {v.version !== board.version && host.revertTo && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    disabled={busy !== null}
                    data-testid={`restore-${v.version}`}
                    onClick={async () => {
                      setBusy(v.version);
                      await host.revertTo!(v.version);
                      setBusy(null);
                      setOpen(false);
                      onReverted();
                    }}
                  >
                    <RotateCcw /> {busy === v.version ? "…" : "restore"}
                  </Button>
                )}
              </div>
            ))}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}

type Catalog = { example: string; description?: string; boards: { id: string; title: string }[] }[];

export function App({ adapters }: { adapters: Record<string, ChartAdapter> }) {
  const params = new URLSearchParams(location.search);
  const [catalog, setCatalog] = React.useState<Catalog>([]);
  const [chatEnabled, setChatEnabled] = React.useState(false);
  const [models, setModels] = React.useState<ModelInfo[]>([]);
  const [model, setModel] = React.useState<string>(params.get("model") ?? "");
  const [example, setExample] = React.useState<string>(params.get("example") ?? "");
  const [boardId, setBoardId] = React.useState<string>(params.get("board") ?? "");
  const [adapterName, setAdapterName] = React.useState<string>(params.get("charts") && adapters[params.get("charts")!] ? params.get("charts")! : "recharts");
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
  const reloadBoard = React.useCallback(() => {
    void api(base).then((r) => {
      if (!r.board) return setProblem(r.error ?? "This board does not exist");
      setProblem(null);
      setState({ board: { ...r.board, updatedAt: new Date(r.board.updatedAt) }, catalogue: r.catalogue });
    });
  }, [base]);
  React.useEffect(() => {
    if (!example || !boardId) return;
    history.replaceState(null, "", `/app?example=${example}&board=${boardId}&charts=${adapterName}${model ? `&model=${encodeURIComponent(model)}` : ""}`);
    reloadBoard();
  }, [example, boardId, adapterName, model, reloadBoard]);

  const host = React.useMemo<BoardHost>(
    () => ({
      loadBoardData: (_config, selections) => api(`${base}/data?${new URLSearchParams(Object.fromEntries(Object.entries(selections).map(([k, v]) => [`f_${k}`, v])))}`),
      applyOps: async (ops) => {
        const r = await api(`${base}/ops`, { method: "POST", body: JSON.stringify({ ops }) });
        if (r.ok) r.board.updatedAt = new Date(r.board.updatedAt);
        return r;
      },
      saveLayout: async (layout) => {
        const b = await api(`${base}/layout`, { method: "POST", body: JSON.stringify({ layout }) });
        return { ...b, updatedAt: new Date(b.updatedAt) };
      },
      loadFilterOptions: (field) => api(`${base}/options?field=${encodeURIComponent(field)}`),
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
  if (!state) return <div className="mx-auto max-w-6xl p-6 text-sm text-muted-foreground">Loading…</div>;

  return (
    <div className="min-h-screen bg-background text-foreground font-sans antialiased">
      <header className="border-b">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-3 px-4">
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <a href="/" className="flex items-center gap-2 font-semibold tracking-tight">
              <span className="inline-block size-4 rounded-sm bg-primary" aria-hidden />
              lenspack
            </a>
            <span className="text-muted-foreground">/</span>
            <span className="truncate text-muted-foreground">demo</span>
          </div>
          <div className="flex items-center gap-2">
            <Select
              value={example}
              onValueChange={(v) => {
                const next = catalog.find((c) => c.example === v);
                setExample(v);
                setBoardId(next?.boards[0]?.id ?? "");
              }}
            >
              <SelectTrigger size="sm" className="w-36" aria-label="Example pack"><SelectValue /></SelectTrigger>
              <SelectContent>{catalog.map((c) => <SelectItem key={c.example} value={c.example}>{c.example}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={boardId} onValueChange={setBoardId}>
              <SelectTrigger size="sm" className="w-52" aria-label="Board"><SelectValue /></SelectTrigger>
              <SelectContent>{(current?.boards ?? []).map((b) => <SelectItem key={b.id} value={b.id}>{b.title}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={adapterName} onValueChange={setAdapterName}>
              <SelectTrigger size="sm" className="w-40" aria-label="Charting library" data-testid="charts-select"><SelectValue /></SelectTrigger>
              <SelectContent>{Object.keys(adapters).map((n) => <SelectItem key={n} value={n}>charts: {n}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6">
        <div className={chatEnabled ? "grid gap-6 lg:grid-cols-4" : ""}>
          {chatEnabled && (
            <div className="lg:col-span-1">
              <ChatPanel key={`${base}:${model}`} base={base} suggestions={suggestions} onTurnEnd={reloadBoard} models={models} model={model} onModelChange={setModel} />
            </div>
          )}
          <div className={chatEnabled ? "min-w-0 lg:col-span-3" : "min-w-0"}>
            <BoardProvider key={`${base}:${state.board.version}`} board={state.board} catalogue={state.catalogue} host={host} charts={adapters[adapterName]!}>
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h1 className="text-xl font-semibold tracking-tight">{state.board.config.title}</h1>
                  {current?.description && <p className="mt-1 text-sm text-muted-foreground">{current.description}</p>}
                </div>
                <VersionHistory onReverted={reloadBoard} />
              </div>
              <div className="space-y-3">
                <OpsBox />
                <FilterBar />
              </div>
              <Separator className="my-4" />
              <Board />
            </BoardProvider>
          </div>
        </div>
      </main>
      <footer className="mx-auto max-w-7xl px-4 pb-10 text-xs text-muted-foreground">
        <a className="underline underline-offset-4" href="/">lenspack</a> — a dashboard is data, not code. Build boards with the chat, edit with the ops box, drag widgets, restore versions, switch the charting library.
      </footer>
    </div>
  );
}
