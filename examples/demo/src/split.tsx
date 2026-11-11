import * as React from "react";

import { MessageSquare } from "lucide-react";

import { Button } from "./components/ui/button";

// The board beside its chat. The chat's width is dragged (or set with the
// arrow keys) on the handle between them and remembered in this browser, as
// is whether the chat is hidden. The board is a grid that measures its own
// width, so it reflows as the handle moves. Hidden, the chat stays mounted:
// its conversation is still there when it comes back.

export const CHAT_MIN = 280;
const CHAT_DEFAULT = 340;
const STEP = 16;
const WIDTH_KEY = "lenspack-chat-width";
const HIDDEN_KEY = "lenspack-chat-hidden";

/** At most half the viewport, never under the minimum. */
export const clampChat = (w: number, viewport: number) => Math.round(Math.min(Math.max(w, CHAT_MIN), Math.max(CHAT_MIN, viewport * 0.5)));

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private windows and blocked storage: the choice lasts for this page only.
  }
}

function useViewport() {
  const [w, setW] = React.useState(() => window.innerWidth);
  React.useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return w;
}

// Side by side from Tailwind's lg; below it the chat goes under the board.
const SIDE_BY_SIDE = 1024;

export function SplitView({ main, side, enabled }: { main: React.ReactNode; side: (hide: () => void) => React.ReactNode; enabled: boolean }) {
  const viewport = useViewport();
  const [wanted, setWanted] = React.useState(() => Number(stored(WIDTH_KEY)) || CHAT_DEFAULT);
  const [hidden, setHidden] = React.useState(() => stored(HIDDEN_KEY) === "1");
  const [dragging, setDragging] = React.useState(false);
  const width = clampChat(wanted, viewport);
  const wide = viewport >= SIDE_BY_SIDE;
  const max = clampChat(Infinity, viewport);

  const hide = React.useCallback(() => {
    setHidden(true);
    store(HIDDEN_KEY, "1");
  }, []);
  const show = () => {
    setHidden(false);
    store(HIDDEN_KEY, "0");
  };
  const setWidth = (w: number) => {
    const next = clampChat(w, window.innerWidth);
    setWanted(next);
    store(WIDTH_KEY, String(next));
  };

  // Pointer drag: the chat is on the right, so its width is the distance from
  // the pointer to the container's right edge. One update per frame.
  const row = React.useRef<HTMLDivElement>(null);
  const frame = React.useRef(0);
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    setDragging(true);
    const right = row.current!.getBoundingClientRect().right;
    let last = width;
    const move = (ev: PointerEvent) => {
      last = clampChat(right - ev.clientX, window.innerWidth);
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => setWanted(last));
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      setDragging(false);
      setWidth(last);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? STEP * 4 : STEP;
    const to = e.key === "ArrowLeft" ? width + step : e.key === "ArrowRight" ? width - step : e.key === "Home" ? CHAT_MIN : e.key === "End" ? max : null;
    if (to === null) return;
    e.preventDefault();
    setWidth(to);
  };

  if (!enabled) return <div className="min-w-0">{main}</div>;
  return (
    <>
      <div ref={row} className={wide ? "flex items-stretch" : "space-y-6"} data-resizing={dragging || undefined} data-testid="split">
        <div className="min-w-0 flex-1">{main}</div>
        {wide && !hidden && (
          // The whole strip takes the pointer; the grip, which stays in view, takes the keyboard (a
          // focused strip as tall as the board would scroll the page to its top).
          <div onPointerDown={onPointerDown} onDoubleClick={() => setWidth(CHAT_DEFAULT)} title="Drag to resize the chat; double-click to reset" className="group relative w-5 shrink-0 cursor-col-resize touch-none select-none" data-testid="chat-resize">
            <span className={`absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors ${dragging ? "bg-declared" : "bg-transparent group-hover:bg-rule-strong group-has-focus-visible:bg-declared"}`} />
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize chat"
              aria-valuemin={CHAT_MIN}
              aria-valuemax={max}
              aria-valuenow={width}
              tabIndex={0}
              onKeyDown={onKeyDown}
              // Focus shows on the line and the grip, not as the page's outline.
              style={{ outline: "none" }}
              className={`sticky top-[50vh] mx-auto block h-10 w-1.5 rounded-full transition-colors ${dragging ? "bg-declared" : "bg-rule group-hover:bg-rule-strong focus-visible:bg-declared"}`}
              data-testid="chat-resize-grip"
            />
          </div>
        )}
        <div className={hidden ? "hidden" : "min-w-0 shrink-0"} style={wide ? { width } : undefined} data-testid="chat-column">
          {side(hide)}
        </div>
      </div>
      {hidden && (
        <Button variant="outline" className="fixed right-4 bottom-4 z-40 h-9 rounded-full bg-background px-4 shadow-md" onClick={show} aria-label="Show chat" data-testid="chat-show">
          <MessageSquare /> Chat
        </Button>
      )}
    </>
  );
}
