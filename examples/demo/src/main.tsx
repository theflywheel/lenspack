import * as React from "react";
import { createRoot } from "react-dom/client";

import type { Board as BoardT, BoardOp, Catalogue } from "@lenspack/core";
import { opSchema } from "@lenspack/core";
import { Chat, useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";

import { Board, BoardProvider, FilterBar, VersionHistory, useBoardOps, type BoardHost, type ChartAdapter } from "@lenspack/react";
import { createEchartsAdapter } from "@lenspack/react/adapters/echarts";
import { rechartsAdapter } from "@lenspack/react/adapters/recharts";
import { createShadcnAdapter } from "@lenspack/react/adapters/shadcn";
import { svgAdapter } from "@lenspack/react/adapters/svg";
import "@lenspack/react/styles.css";
import "./tailwind.css";

import * as shadcn from "./components/ui/chart";
import { Landing } from "./landing";

// Four charting libraries behind one seam. The board config never changes;
// only the adapter handed to the provider does, and it can change live.
const ADAPTERS: Record<string, ChartAdapter> = {
  recharts: rechartsAdapter,
  echarts: createEchartsAdapter(),
  shadcn: createShadcnAdapter(shadcn, { palette: ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"] }),
  svg: svgAdapter,
};
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

const api = async (path: string, init?: RequestInit) => {
  const r = await fetch(`/api${path}`, { headers: { "content-type": "application/json" }, ...init });
  return r.json();
};

// The demo has no chat; ops are typed as JSON to show that anything — a chat,
// a form, a command palette — drives the board through the same eight ops.
function OpsBox() {
  const { apply } = useBoardOps();
  const [text, setText] = React.useState('{"op":"set_title","title":"Renamed from the ops box"}');
  const [err, setErr] = React.useState<string | null>(null);
  return (
    <div>
      <div className="ops">
        <input value={text} onChange={(e) => setText(e.target.value)} />
        <button
          onClick={async () => {
            try {
              const parsed = opSchema.parse(JSON.parse(text)) as BoardOp;
              const r = await apply([parsed]);
              setErr(r.ok ? null : `${r.error}${r.hint ? ` — did you mean ${r.hint}?` : ""}`);
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          Apply op
        </button>
      </div>
      {err && <p className="err">{err}</p>}
    </div>
  );
}

type Part = { type: string; state?: string; output?: unknown; errorText?: string; text?: string };

// One line per tool call: what ran, and whether it changed the board. An
// argument the model got wrong (errorText) is shown too, not swallowed.
function EditStep({ name, part }: { name: string; part: Part }) {
  const r = part.output as { applied?: boolean; ok?: boolean; error?: string; didYouMean?: string; version?: number } | undefined;
  const failed = part.errorText !== undefined || r?.applied === false || r?.ok === false;
  return (
    <div className={`chat-step ${failed ? "chat-step-failed" : ""}`}>
      <span className="mono">{name}</span>
      {part.errorText ? (
        <span>{part.errorText.slice(0, 160)}</span>
      ) : failed ? (
        <span>
          {r?.error}
          {r?.didYouMean && ` — retrying with “${r.didYouMean}”`}
        </span>
      ) : r?.applied ? (
        <span>saved as v{r.version}</span>
      ) : part.state && part.state !== "output-available" ? (
        <span>…</span>
      ) : null}
    </div>
  );
}

// Chat beside the thing it edits. The model only ever calls the board tools;
// when its turn ends, the board is fetched again and re-rendered.
function ChatPanel({ base, suggestions, onTurnEnd }: { base: string; suggestions: string[]; onTurnEnd: () => void }) {
  const chat = React.useMemo(() => new Chat({ transport: new DefaultChatTransport({ api: `/api${base}/chat` }) }), [base]);
  const { messages, sendMessage, status, error } = useChat({ chat });
  const busy = status === "submitted" || status === "streaming";
  const [input, setInput] = React.useState("");
  const wasBusy = React.useRef(false);
  React.useEffect(() => {
    if (wasBusy.current && !busy) onTurnEnd();
    wasBusy.current = busy;
  }, [busy, onTurnEnd]);
  const ask = (text: string) => {
    if (!text.trim() || busy) return;
    void sendMessage({ text });
    setInput("");
  };
  return (
    <aside className="chat" data-testid="chat">
      <div className="chat-head">Build with chat</div>
      <div className="chat-log">
        {messages.length === 0 && (
          <div>
            <p className="desc">Describe what belongs on this board. Every change is a version, so nothing is hard to undo.</p>
            {suggestions.map((s) => (
              <button key={s} className="chat-suggest" onClick={() => ask(s)}>
                {s}
              </button>
            ))}
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className="chat-msg">
            <div className="chat-role">{m.role === "user" ? "You" : "lenspack"}</div>
            {(m.parts as Part[]).filter((p) => p.type.startsWith("tool-")).map((p, i) => (
              <EditStep key={i} name={p.type.slice(5)} part={p} />
            ))}
            {(m.parts as Part[]).filter((p) => p.type === "text" && p.text?.trim()).map((p, i) => (
              <p key={i} className="chat-text">{p.text}</p>
            ))}
          </div>
        ))}
        {busy && <p className="desc">Working…</p>}
        {error && <p className="err">{error.message}</p>}
      </div>
      <form
        className="chat-form"
        onSubmit={(e) => {
          e.preventDefault();
          ask(input);
        }}
      >
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Add a chart…" disabled={busy} />
        <button type="submit" disabled={busy || !input.trim()}>Send</button>
      </form>
    </aside>
  );
}

function App() {
  const params = new URLSearchParams(location.search);
  const [catalog, setCatalog] = React.useState<{ example: string; description?: string; boards: { id: string; title: string }[] }[]>([]);
  const [chatEnabled, setChatEnabled] = React.useState(false);
  const [example, setExample] = React.useState<string>(params.get("example") ?? "");
  const [boardId, setBoardId] = React.useState<string>(params.get("board") ?? "");
  const [adapterName, setAdapterName] = React.useState<string>(params.get("charts") && ADAPTERS[params.get("charts")!] ? params.get("charts")! : "recharts");
  const [state, setState] = React.useState<{ board: BoardT; catalogue: Catalogue } | null>(null);

  const [problem, setProblem] = React.useState<string | null>(null);
  React.useEffect(() => {
    void api("/").then((r) => {
      setCatalog(r.examples);
      setChatEnabled(!!r.chat);
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
  React.useEffect(() => {
    if (!example || !boardId) return;
    history.replaceState(null, "", `?example=${example}&board=${boardId}&charts=${adapterName}`);
    void api(`/${example}/${boardId}`).then((r) => {
      if (!r.board) return setProblem(r.error ?? "This board does not exist");
      setProblem(null);
      setState({ board: { ...r.board, updatedAt: new Date(r.board.updatedAt) }, catalogue: r.catalogue });
    });
  }, [example, boardId, adapterName]);

  const base = `/${example}/${boardId}`;
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
        if (b) setState((s) => (s ? { ...s, board: { ...b, updatedAt: new Date(b.updatedAt) } } : s));
        return b;
      },
    }),
    [base],
  );

  const current = catalog.find((c) => c.example === example);
  const reloadBoard = React.useCallback(() => {
    void api(base).then((r) => setState({ board: { ...r.board, updatedAt: new Date(r.board.updatedAt) }, catalogue: r.catalogue }));
  }, [base]);
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
  if (problem) return <div className="wrap"><p className="err">{problem}</p></div>;
  if (!state) return <div className="wrap">Loading…</div>;
  // The chat sits outside the keyed provider: a new board version re-mounts
  // the board, and the conversation must survive that.
  return (
    <div className="wrap">
      <div className={chatEnabled ? "split" : ""}>
        {chatEnabled && <ChatPanel key={base} base={base} suggestions={suggestions} onTurnEnd={reloadBoard} />}
        <div className="main">
          <BoardProvider key={`${base}:${state.board.version}`} board={state.board} catalogue={state.catalogue} host={host} charts={ADAPTERS[adapterName]!}>
            <header>
              <div>
                <h1>{state.board.config.title}</h1>
                {current?.description && <p className="desc">{current.description}</p>}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <select
                  value={example}
                  onChange={(e) => {
                    const next = catalog.find((c) => c.example === e.target.value);
                    setExample(e.target.value);
                    setBoardId(next?.boards[0]?.id ?? "");
                  }}
                >
                  {catalog.map((c) => (
                    <option key={c.example} value={c.example}>
                      {c.example}
                    </option>
                  ))}
                </select>
                <select value={boardId} onChange={(e) => setBoardId(e.target.value)}>
                  {(current?.boards ?? []).map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.title}
                    </option>
                  ))}
                </select>
                <select value={adapterName} onChange={(e) => setAdapterName(e.target.value)} title="Charting library" data-testid="charts-select">
                  {Object.keys(ADAPTERS).map((n) => (
                    <option key={n} value={n}>
                      charts: {n}
                    </option>
                  ))}
                </select>
                <VersionHistory />
              </div>
            </header>
            <OpsBox />
            <FilterBar />
            <Board />
          </BoardProvider>
        </div>
      </div>
      <footer>
        <a href="https://github.com/theflywheel/lenspack">lenspack</a> — a dashboard is data, not code. Four synthetic packs; build boards with the chat, edit with the ops box, drag widgets, restore versions — and switch the charting library (recharts, ECharts, shadcn, plain SVG) without touching the board.
      </footer>
    </div>
  );
}

const Root = location.pathname.startsWith("/app") ? App : () => <Landing adapters={ADAPTERS} />;
createRoot(document.getElementById("root")!).render(<Root />);
