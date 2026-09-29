import * as React from "react";

import { Chat, useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { ArrowUp, ChevronDown, SendHorizontal, X } from "lucide-react";

import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { Input } from "./components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { Separator } from "./components/ui/separator";
import { ScrollArea } from "./components/ui/scroll-area";

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

// Provider names carry the host in parentheses ("glm-5.3-flash (openrouter)")
// so roles and URLs can name them exactly; the menu shows just the model,
// keeping the host only where two available entries would otherwise collide.
function labelFor(name: string, models: ModelInfo[]) {
  const base = (n: string) => n.replace(/\s*\([^)]*\)\s*$/, "");
  const mine = base(name);
  const collides = models.filter((m) => m.available !== false && m.name !== name && base(m.name) === mine).length > 0;
  return collides ? name : mine;
}

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
  // The receipt: what the board actually gained during a turn, read back from
  // the version log. A model's claim and the receipt are shown side by side.
  const startVersion = React.useRef<number | null>(null);
  const [receipts, setReceipts] = React.useState<Record<string, BoardVersion[] | "none">>({});
  React.useEffect(() => {
    if (wasBusy.current && !busy) {
      onTurnEnd();
      const last = messages[messages.length - 1];
      const from = startVersion.current;
      if (last?.role === "assistant" && from !== null) {
        void fetch(`/api${base}/versions`)
          .then((r) => r.json())
          .then((vs: (BoardVersion & { createdAt: string })[]) => {
            const gained = vs.filter((v) => v.version > from).map((v) => ({ ...v, createdAt: new Date(v.createdAt) })).reverse();
            setReceipts((prev) => ({ ...prev, [last.id]: gained.length ? gained : "none" }));
          });
      }
    }
    wasBusy.current = busy;
  }, [busy, onTurnEnd, messages, base]);
  React.useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages, busy]);
  const ask = async (text: string) => {
    if (!text.trim() || busy) return;
    const b = await (await fetch(`/api${base}`)).json();
    startVersion.current = b.board?.version ?? null;
    void sendMessage({ text });
    setInput("");
  };
  return (
    <Card className="sticky top-4 flex max-h-[calc(100vh-6rem)] flex-col gap-0 rounded-md py-0" data-testid="chat">
      <CardHeader className="flex flex-row items-center justify-between gap-2 border-b py-3 [.border-b]:pb-3">
        <CardTitle className="shrink-0 whitespace-nowrap font-mono text-xs font-medium text-muted-foreground">build with chat</CardTitle>
        {models.length > 1 && (
          <Select value={model} onValueChange={onModelChange}>
            <SelectTrigger size="sm" className="h-7 min-w-0 flex-1 text-xs [&>span]:truncate" aria-label="Model" data-testid="model-select">
              <SelectValue>{labelFor(model, models)}</SelectValue>
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
      </CardHeader>
      <ScrollArea className="min-h-[160px] flex-1">
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
          {messages.map((m) => (
            <div key={m.id} className="space-y-1.5">
              <p className="font-mono text-2xs text-muted-foreground">{m.role === "user" ? "you" : "lenspack"}</p>
              {(m.parts as Part[]).filter((p) => p.type.startsWith("tool-")).map((p, i) => (
                <StepBadge key={i} name={p.type.slice(5)} part={p} />
              ))}
              {(m.parts as Part[]).map((p, i) =>
                p.type === "text" && p.text?.trim() ? (
                  <p key={i} className="text-sm leading-6">{p.text}</p>
                ) : p.type === "data-review" ? (
                  <ReviewBlock key={i} r={p.data as ReviewData} onApply={(text) => void ask(text)} />
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

