import * as React from "react";

import { Chat, useChat } from "@ai-sdk/react";
import { changesSince, listInWords } from "@lenspack/core";
import type { BoardVersion } from "@lenspack/react";
import { DefaultChatTransport } from "ai";
import { Hand, PanelRightClose, SendHorizontal } from "lucide-react";

import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { Input } from "./components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";

// The chat panel, in a chunk of its own: the AI SDK loads when a board with
// chat is opened, not with the landing page or the board.

type Part = { type: string; state?: string; output?: unknown; errorText?: string; text?: string; data?: unknown };
type ReviewData = { round: number; reviewer: string; satisfied: boolean; unavailable?: boolean; missing: string[]; wrong: string[]; note: string };

// The adversarial reviewer's verdict, as the server streamed it. When it is
// not satisfied, the findings can be sent back as the next instruction — by
// the person, not automatically.
function ReviewBlock({ r, onApply }: { r: ReviewData; onApply?: (text: string) => void }) {
  const fixes = [...r.missing.map((m) => `missing: ${m}`), ...r.wrong.map((w) => `wrong: ${w}`)];
  return (
    <div className={`rounded-md border px-2 py-1.5 text-xs ${r.satisfied ? "border-border text-muted-foreground" : "border-destructive/40 text-destructive"}`} data-testid="review">
      <div className="flex items-center gap-2">
        <Badge variant={r.unavailable ? "outline" : r.satisfied ? "secondary" : "destructive"} className="font-mono">review {r.round}</Badge>
        <span className={r.satisfied && !r.unavailable ? "text-foreground" : ""}>{r.unavailable ? "unavailable" : r.satisfied ? "satisfied" : "not satisfied"}</span>
        <span className="ml-auto truncate text-muted-foreground">{r.reviewer}</span>
      </div>
      {(r.missing.length > 0 || r.wrong.length > 0) && (
        <ul className="mt-1 space-y-0.5">
          {r.missing.map((m, i) => <li key={`m${i}`}>missing: {m}</li>)}
          {r.wrong.map((w, i) => <li key={`w${i}`}>wrong: {w}</li>)}
        </ul>
      )}
      {r.note && <p className="mt-1 text-muted-foreground">{r.note}</p>}
      {!r.satisfied && !r.unavailable && fixes.length > 0 && onApply && (
        <Button
          variant="outline"
          size="sm"
          className="mt-2 h-7 text-xs"
          data-testid="apply-fixes"
          onClick={() => onApply(`A review found the last edit incomplete. Fix exactly these points, then verify with get_board:\n${fixes.map((f) => `- ${f}`).join("\n")}`)}
        >
          Apply fixes
        </Button>
      )}
    </div>
  );
}

type UsageData = { total: { inputTokens: number; cachedInputTokens: number; outputTokens: number; usd: number; unpriced: number }; models?: { role: string; effort?: string }[]; queries: { queries: number } };

const kilo = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

// What the turn cost, as the server metered it: one quiet line under the reply.
function UsageLine({ u }: { u: UsageData }) {
  const t = u.total;
  const cost = t.unpriced > 0 && t.usd === 0 ? "unpriced" : `$${t.usd < 0.01 ? t.usd.toFixed(4) : t.usd.toFixed(2)}${t.unpriced > 0 ? " + unpriced" : ""}`;
  const effort = u.models?.find((m) => m.role === "build")?.effort;
  return (
    <p className="font-mono text-[11px] text-muted-foreground" data-testid="usage">
      {kilo(t.inputTokens)} in{t.cachedInputTokens ? ` (${kilo(t.cachedInputTokens)} cached)` : ""} · {kilo(t.outputTokens)} out · {cost} · {u.queries.queries} {u.queries.queries === 1 ? "query" : "queries"}
      {effort ? ` · ${effort} effort` : ""}
    </p>
  );
}

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
export type ModelInfo = { name: string; model: string; available: boolean | null; latencyMs?: number; error?: string; efforts?: { levels: string[]; default: string } };

/** The effort a turn asks for: the remembered one if this model takes it; "" leaves it to the server's default. */
export function effortOf(info: ModelInfo | undefined, remembered: string) {
  return info?.efforts?.levels.includes(remembered) ? remembered : "";
}

// Provider names carry the host in parentheses ("glm-5.3-flash (openrouter)")
// so roles and URLs can name them exactly; the menu shows just the model,
// keeping the host only where two available entries would otherwise collide.
function labelFor(name: string, models: ModelInfo[]) {
  const base = (n: string) => n.replace(/\s*\([^)]*\)\s*$/, "");
  const mine = base(name);
  const collides = models.filter((m) => m.available !== false && m.name !== name && base(m.name) === mine).length > 0;
  return collides ? name : mine;
}

// Once the user's own edits have settled, one line in the transcript says
// what the assistant will be told with the next message. Local: no model call.
const SETTLE_MS = 15_000;
type Notice = { at: number; text: string };

export function ChatPanel({
  base,
  suggestions,
  onTurnEnd,
  boardVersion,
  edits,
  onHide,
  models,
  model,
  onModelChange,
  effort,
  onEffortChange,
}: {
  base: string;
  suggestions: string[];
  onTurnEnd: () => void;
  /** The board's version when the panel opened. */
  boardVersion: number;
  /** Counts the edits made by hand (not by chat); each one restarts the settle timer. */
  edits: number;
  onHide?: () => void;
  models: ModelInfo[];
  model: string;
  onModelChange: (m: string) => void;
  /** A level the model takes, or "" for its default. */
  effort: string;
  onEffortChange: (e: string) => void;
}) {
  const efforts = models.find((m) => m.name === model)?.efforts;
  const chat = React.useMemo(
    () => new Chat({ transport: new DefaultChatTransport({ api: `/api${base}/chat?model=${encodeURIComponent(model)}${effort ? `&effort=${encodeURIComponent(effort)}` : ""}` }) }),
    [base, model, effort],
  );
  const { messages, sendMessage, status, error } = useChat({ chat });
  const busy = status === "submitted" || status === "streaming";
  const [input, setInput] = React.useState("");
  const wasBusy = React.useRef(false);
  const bottom = React.useRef<HTMLDivElement>(null);
  // The receipt: what the board actually gained during a turn, read back from
  // the version log. A model's claim and the receipt are shown side by side.
  const startVersion = React.useRef<number | null>(null);
  // The version the last turn started at: the server tells the next turn what
  // the user changed by hand after it (the chat's own edits are left out).
  const lastTurnFrom = React.useRef<number | null>(null);
  const [receipts, setReceipts] = React.useState<Record<string, BoardVersion[] | "none">>({});
  React.useEffect(() => {
    if (wasBusy.current && !busy) {
      onTurnEnd();
      const last = messages[messages.length - 1];
      const from = startVersion.current;
      lastTurnFrom.current = from;
      if (last?.role === "assistant" && from !== null) {
        void fetch(`/api${base}/versions`)
          .then((r) => r.json())
          .then((vs: (BoardVersion & { createdAt: string })[]) => {
            // Only the chat's own versions: what the user did meanwhile is not this turn's receipt.
            const gained = vs.filter((v) => v.version > from && v.source === "chat").map((v) => ({ ...v, createdAt: new Date(v.createdAt) })).reverse();
            setReceipts((prev) => ({ ...prev, [last.id]: gained.length ? gained : "none" }));
          });
      }
    }
    wasBusy.current = busy;
  }, [busy, onTurnEnd, messages, base]);

  // Hand edits since the last notice (or since the panel opened, or the last
  // message was sent: from then on the assistant sees the board as it is).
  const noticedFrom = React.useRef(boardVersion);
  const [notices, setNotices] = React.useState<Notice[]>([]);
  const busyRef = React.useRef(busy);
  busyRef.current = busy;
  const countRef = React.useRef(messages.length);
  countRef.current = messages.length;
  React.useEffect(() => {
    if (edits === 0) return;
    let timer: ReturnType<typeof setTimeout>;
    const settle = () => {
      // Mid-turn, wait: the turn's end moves the board on as well.
      if (busyRef.current) return void (timer = setTimeout(settle, SETTLE_MS));
      void fetch(`/api${base}/versions`)
        .then((r) => r.json())
        .then((vs: BoardVersion[]) => {
          const changes = changesSince(vs, noticedFrom.current);
          if (changes.length === 0) return;
          noticedFrom.current = Math.max(...vs.map((v) => v.version));
          const said = listInWords(changes.map((c) => c.text));
          setNotices((prev) => [...prev, { at: countRef.current, text: `You ${said}. The assistant will see this with your next message.` }]);
        })
        .catch(() => {});
    };
    timer = setTimeout(settle, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [edits, base]);

  React.useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages, busy, notices]);
  const ask = async (text: string) => {
    if (!text.trim() || busy) return;
    const b = await (await fetch(`/api${base}`)).json();
    startVersion.current = b.board?.version ?? null;
    // The model sees the board as it is now; a notice pending for edits before this is moot.
    if (startVersion.current !== null) noticedFrom.current = Math.max(noticedFrom.current, startVersion.current);
    void sendMessage({ text }, lastTurnFrom.current !== null ? { body: { since: lastTurnFrom.current } } : undefined);
    setInput("");
  };
  const noticesAt = (at: number) =>
    notices
      .filter((n) => n.at === at)
      .map((n, i) => (
        <p key={`n${at}.${i}`} className="flex items-start gap-1.5 border-l-2 border-rule pl-2 text-xs leading-5 text-muted-foreground" data-testid="edit-notice">
          <Hand className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
          <span>{n.text}</span>
        </p>
      ));
  return (
    <Card className="sticky top-[4.5rem] flex max-h-[calc(100vh-5.5rem)] flex-col gap-0 rounded-md py-0" data-testid="chat">
      {/* Title on its own line, the model and its effort under it: side by side in a 320px panel, the
          model's name had no room left and showed as an empty box. */}
      <CardHeader className="flex flex-col items-stretch gap-2 border-b py-3 [.border-b]:pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="font-mono text-xs font-medium text-muted-foreground">build with chat</CardTitle>
          {onHide && (
            <Button variant="ghost" size="icon" className="-my-1 -mr-2 size-7 text-muted-foreground" onClick={onHide} aria-label="Hide chat" title="Hide chat" data-testid="chat-hide">
              <PanelRightClose />
            </Button>
          )}
        </div>
        {(models.length > 1 || efforts) && (
          <div className="flex min-w-0 items-center gap-2">
            {models.length > 1 && (
              <Select value={model} onValueChange={onModelChange}>
                <SelectTrigger size="sm" className="h-7 min-w-0 flex-1 gap-1 px-2 text-xs" aria-label="Model" title={model} data-testid="model-select">
                  <SelectValue>
                    <span className="truncate">{labelFor(model, models)}</span>
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {models
                    .filter((m) => m.available !== false)
                    .map((m) => (
                      <SelectItem key={m.name} value={m.name}>
                        {labelFor(m.name, models)}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            )}
            {/* Only for a model with an effort setting; choosing its default goes back to asking for none. */}
            {efforts && (
              <Select value={effort || efforts.default} onValueChange={(e) => onEffortChange(e === efforts.default ? "" : e)}>
                <SelectTrigger size="sm" className="h-7 w-auto shrink-0 gap-1 px-2 text-xs *:data-[slot=select-value]:gap-1" aria-label="Effort" title="How hard the model thinks: higher is slower and costs more" data-testid="effort-select">
                  <SelectValue>
                    <span className="text-muted-foreground">Effort</span> {effort || efforts.default}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {efforts.levels.map((l) => (
                    <SelectItem key={l} value={l}>
                      {l}
                      {l === efforts.default ? " (default)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        )}
      </CardHeader>
      {/* A plain scrolling box: inside a card with only a max height, a scroll area never gets a height of
          its own, and a long conversation spills over the input and takes its clicks. */}
      <div className="min-h-[160px] flex-1 overflow-y-auto overscroll-contain">
        <CardContent className="space-y-4 py-4">
          {messages.length === 0 && (
            <div className="space-y-2">
              <p className="text-xs leading-relaxed text-muted-foreground">
                Describe what belongs on this board. Every change is a version, so nothing here is hard to undo.
              </p>
              {suggestions.map((s) => (
                <Button key={s} variant="outline" size="sm" className="h-auto w-full justify-start whitespace-normal rounded-sm py-1.5 text-left text-xs font-normal leading-snug" onClick={() => ask(s)}>
                  {s}
                </Button>
              ))}
            </div>
          )}
          {noticesAt(0)}
          {messages.map((m, mi) => (
            <React.Fragment key={m.id}>
            {mi > 0 && noticesAt(mi)}
            <div className="space-y-1.5">
              <p className="font-mono text-2xs text-muted-foreground">{m.role === "user" ? "you" : "lenspack"}</p>
              {(m.parts as Part[]).filter((p) => p.type.startsWith("tool-")).map((p, i) => (
                <StepBadge key={i} name={p.type.slice(5)} part={p} />
              ))}
              {(m.parts as Part[]).map((p, i) =>
                p.type === "text" && p.text?.trim() ? (
                  <p key={i} className="text-sm leading-6">{p.text}</p>
                ) : p.type === "data-review" ? (
                  <ReviewBlock key={i} r={p.data as ReviewData} onApply={(text) => void ask(text)} />
                ) : p.type === "data-usage" ? (
                  <UsageLine key={i} u={p.data as UsageData} />
                ) : p.type === "data-round" && (p.data as { round: number }).round > 1 ? (
                  <p key={i} className="text-[11px] text-muted-foreground">round {(p.data as { round: number }).round} · {(p.data as { builder: string }).builder}</p>
                ) : null,
              )}
              {m.role === "assistant" && receipts[m.id] && (
                <div className="rounded-md border border-dashed px-2 py-1.5 text-xs text-muted-foreground" data-testid="receipt">
                  <span className="font-medium text-foreground">Receipt</span>
                  {receipts[m.id] === "none" ? (
                    <span> — no changes were made to the board.</span>
                  ) : (
                    <ul className="mt-1 space-y-0.5">
                      {(receipts[m.id] as BoardVersion[]).map((v) => (
                        <li key={v.version}>
                          <span className="font-mono">v{v.version}</span> {v.summary}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
            </React.Fragment>
          ))}
          {messages.length > 0 && noticesAt(messages.length)}
          {busy && <p className="text-xs text-muted-foreground">Working…</p>}
          {error && <p className="text-xs text-destructive">{error.message}</p>}
          <div ref={bottom} />
        </CardContent>
      </div>
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

