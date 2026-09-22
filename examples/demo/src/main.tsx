import * as React from "react";
import { createRoot } from "react-dom/client";

import type { Board as BoardT, BoardOp, Catalogue } from "@lenspack/core";
import { opSchema } from "@lenspack/core";
import { Board, BoardProvider, FilterBar, VersionHistory, useBoardOps, type BoardHost } from "@lenspack/react";
import "@lenspack/react/styles.css";
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

function App() {
  const [boards, setBoards] = React.useState<{ id: string; title: string }[]>([]);
  const [boardId, setBoardId] = React.useState<string>(new URLSearchParams(location.search).get("board") ?? "");
  const [state, setState] = React.useState<{ board: BoardT; catalogue: Catalogue } | null>(null);

  React.useEffect(() => {
    void api("/").then((r) => {
      setBoards(r.boards);
      if (!boardId && r.boards[0]) setBoardId(r.boards[0].id);
    });
  }, []);
  React.useEffect(() => {
    if (!boardId) return;
    void api(`/${boardId}`).then((r) => setState({ board: { ...r.board, updatedAt: new Date(r.board.updatedAt) }, catalogue: r.catalogue }));
  }, [boardId]);

  const host = React.useMemo<BoardHost>(
    () => ({
      loadBoardData: (_config, selections) => api(`/${boardId}/data?${new URLSearchParams(Object.fromEntries(Object.entries(selections).map(([k, v]) => [`f_${k}`, v])))}`),
      applyOps: async (ops) => {
        const r = await api(`/${boardId}/ops`, { method: "POST", body: JSON.stringify({ ops }) });
        if (r.ok) r.board.updatedAt = new Date(r.board.updatedAt);
        return r;
      },
      saveLayout: async (layout) => {
        const b = await api(`/${boardId}/layout`, { method: "POST", body: JSON.stringify({ layout }) });
        return { ...b, updatedAt: new Date(b.updatedAt) };
      },
      loadFilterOptions: (field) => api(`/${boardId}/options?field=${encodeURIComponent(field)}`),
      loadVersions: async () => (await api(`/${boardId}/versions`)).map((v: { createdAt: string }) => ({ ...v, createdAt: new Date(v.createdAt) })),
      revertTo: async (version) => {
        const b = await api(`/${boardId}/revert`, { method: "POST", body: JSON.stringify({ version }) });
        if (b) setState((s) => (s ? { ...s, board: { ...b, updatedAt: new Date(b.updatedAt) } } : s));
        return b;
      },
    }),
    [boardId],
  );

  if (!state) return <div className="wrap">Loading…</div>;
  return (
    <div className="wrap">
      <BoardProvider key={`${boardId}:${state.board.version}`} board={state.board} catalogue={state.catalogue} host={host}>
        <header>
          <h1>{state.board.config.title}</h1>
          <div style={{ display: "flex", gap: 8 }}>
            <select value={boardId} onChange={(e) => setBoardId(e.target.value)}>
              {boards.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.title}
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
  );
}

createRoot(document.getElementById("root")!).render(<App />);
