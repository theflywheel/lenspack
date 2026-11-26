// A board on any page, with no build of its own: one script tag (board.js) sets window.LenspackBoard,
// whose mount(el, { api }) draws the board the board API at `api` serves (GET api, api/data, api/ops,
// …), with the zero-dependency SVG charts. React is bundled in. Lenspack's admin panel draws its usage
// board this way, so the panel stays plain HTML while the board is the same renderer every host uses.
import * as React from "react";
import { createRoot } from "react-dom/client";

import { svgAdapter } from "./adapters/svg";
import { FilterBar } from "./filter-bar";
import { Board } from "./grid";
import { BoardProvider } from "./provider";
import type { Board as BoardType, BoardHost, Catalogue } from "./types";

type MountOptions = {
  /** The board's address in a board API: <base>/api/<pack>/<board>. */
  api: string;
  /** False draws it read-only even for someone who may edit it. */
  editable?: boolean;
  /** Told when a load fails. */
  onError?(message: string): void;
};

const getJson = async (url: string, init?: RequestInit) => {
  const res = await fetch(url, { credentials: "same-origin", ...init, headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body;
};
const query = (selections: Record<string, string>) => Object.entries(selections).map(([k, v]) => `f_${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");

function hostFor(api: string): BoardHost {
  const post = (path: string, body: unknown) => getJson(`${api}/${path}`, { method: "POST", body: JSON.stringify(body) });
  return {
    loadBoardData: (_config, selections) => getJson(`${api}/data${Object.keys(selections).length ? `?${query(selections)}` : ""}`),
    applyOps: (ops) => post("ops", { ops }),
    saveLayout: (layout, summary) => post("layout", { layout, summary }),
    loadWidgetPage: (id, page, selections) => getJson(`${api}/page?widget=${encodeURIComponent(id)}&page=${page}${Object.keys(selections).length ? `&${query(selections)}` : ""}`),
    loadFilterOptions: (field) => getJson(`${api}/options?field=${encodeURIComponent(field)}`),
    loadVersions: () => getJson(`${api}/versions`),
    revertTo: (version) => post("revert", { version }),
  };
}

function Embedded({ api, editable, onError }: MountOptions & { onLoaded(reload: () => void): void }) {
  const [state, setState] = React.useState<{ board: BoardType; catalogue: Catalogue; writable: boolean } | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);
  const host = React.useMemo(() => hostFor(api), [api]);
  const load = React.useCallback(() => {
    getJson(api)
      .then((b: { board: BoardType; catalogue: Catalogue; writable: boolean }) => setState(b))
      .catch((e: Error) => {
        setProblem(e.message);
        onError?.(e.message);
      });
  }, [api, onError]);
  React.useEffect(load, [load]);
  if (problem) return <p className="lp-muted">{problem}</p>;
  if (!state) return <p className="lp-muted">…</p>;
  return (
    <BoardProvider board={state.board} catalogue={state.catalogue} host={host} editable={editable !== false && state.writable} charts={svgAdapter}>
      <FilterBar />
      <Board />
    </BoardProvider>
  );
}

const LenspackBoard = {
  mount(el: HTMLElement, opts: MountOptions) {
    const root = createRoot(el);
    let key = 0;
    const draw = () => root.render(<Embedded key={key} {...opts} onLoaded={() => {}} />);
    draw();
    return {
      /** Fetches the board again (after a chat turn changed it, or new data). */
      reload() {
        key += 1;
        draw();
      },
      unmount: () => root.unmount(),
    };
  },
};

(globalThis as { LenspackBoard?: typeof LenspackBoard }).LenspackBoard = LenspackBoard;
