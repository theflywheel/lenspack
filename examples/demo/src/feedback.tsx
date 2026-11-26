import * as React from "react";

import { ThumbsDown, ThumbsUp } from "lucide-react";

// Thumbs up or down under each answer, and on down a short list of what was wrong, posted to /api/_telemetry with
// the turn's id (docs/telemetry.md). The words follow the browser's language when it is one Lenspack's chat
// speaks (en, fr, hi, pt).

const WORDS = {
  en: { helpful: "Helpful", notHelpful: "Not helpful", whatWrong: "What was wrong?", "wrong-number": "Wrong number", "wrong-place": "Wrong place or item", misunderstood: "Misunderstood my question", "too-slow": "Too slow", other: "Other", comment: "Anything else? (optional)", send: "Send", thanks: "Thanks for the feedback." },
  fr: { helpful: "Utile", notHelpful: "Pas utile", whatWrong: "Qu'est-ce qui n'allait pas ?", "wrong-number": "Chiffre faux", "wrong-place": "Mauvais lieu ou élément", misunderstood: "Question mal comprise", "too-slow": "Trop lent", other: "Autre", comment: "Autre chose ? (facultatif)", send: "Envoyer", thanks: "Merci pour votre retour." },
  hi: { helpful: "मददगार", notHelpful: "मददगार नहीं", whatWrong: "क्या गलत था?", "wrong-number": "गलत संख्या", "wrong-place": "गलत जगह या चीज़", misunderstood: "मेरा सवाल गलत समझा", "too-slow": "बहुत धीमा", other: "कुछ और", comment: "कुछ और कहना है? (वैकल्पिक)", send: "भेजें", thanks: "आपकी राय के लिए धन्यवाद।" },
  pt: { helpful: "Útil", notHelpful: "Não foi útil", whatWrong: "O que estava errado?", "wrong-number": "Número errado", "wrong-place": "Local ou item errado", misunderstood: "Pergunta mal compreendida", "too-slow": "Muito lento", other: "Outro", comment: "Mais alguma coisa? (opcional)", send: "Enviar", thanks: "Agradecemos a sua opinião." },
} as const;
const REASONS = ["wrong-number", "wrong-place", "misunderstood", "too-slow", "other"] as const;
type Lang = keyof typeof WORDS;

const lang = (): Lang => {
  const l = (typeof navigator !== "undefined" ? navigator.language : "en").slice(0, 2) as Lang;
  return l in WORDS ? l : "en";
};

/** The device, network and viewport classes a chat request carries: never the user agent itself. */
export function clientInfo() {
  const ua = navigator.userAgent || "";
  const nav = navigator as Navigator & { userAgentData?: { mobile?: boolean }; connection?: { effectiveType?: string; saveData?: boolean } };
  const tablet = /iPad|Tablet|PlayBook|Silk|Android(?!.*Mobile)/i.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
  const device = nav.userAgentData?.mobile === true ? "mobile" : tablet ? "tablet" : /Mobi|iPhone|iPod|Windows Phone/i.test(ua) ? "mobile" : "desktop";
  const w = window.innerWidth;
  return { device, ...(nav.connection?.effectiveType ? { network: nav.connection.effectiveType } : {}), ...(typeof nav.connection?.saveData === "boolean" ? { saveData: nav.connection.saveData } : {}), viewport: w < 600 ? "narrow" : w < 1024 ? "medium" : "wide" };
}

const post = (body: Record<string, unknown>) => fetch("/api/_telemetry", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), keepalive: true }).then((r) => r.ok, () => false);

/** Reports an event about a turn (such as explain-opened); nothing when the turn has no id (telemetry off). */
export function reportEvent(type: string, turn: { turnId?: string } | undefined) {
  if (turn?.turnId) void post({ type, turnId: turn.turnId });
}

export function Feedback({ turnId }: { turnId: string }) {
  const w = WORDS[lang()];
  const [rating, setRating] = React.useState<"up" | "down" | null>(null);
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState<string | null>(null);
  const [comment, setComment] = React.useState("");
  const [thanked, setThanked] = React.useState(false);
  const first = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (open) first.current?.focus();
  }, [open]);
  const button = "rounded-sm border border-transparent p-1 text-muted-foreground hover:border-border hover:text-foreground aria-pressed:border-primary aria-pressed:text-primary";
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground" role="group" aria-label={`${w.helpful} / ${w.notHelpful}`} data-testid="feedback">
      <button
        type="button"
        className={button}
        aria-pressed={rating === "up"}
        aria-label={w.helpful}
        title={w.helpful}
        onClick={() => {
          setRating("up");
          setOpen(false);
          void post({ type: "feedback", turnId, rating: "up" }).then(() => setThanked(true));
        }}
      >
        <ThumbsUp className="size-3.5" aria-hidden="true" />
      </button>
      <button
        type="button"
        className={button}
        aria-pressed={rating === "down"}
        aria-label={w.notHelpful}
        title={w.notHelpful}
        onClick={() => {
          setRating("down");
          setOpen(true);
          void post({ type: "feedback", turnId, rating: "down" });
        }}
      >
        <ThumbsDown className="size-3.5" aria-hidden="true" />
      </button>
      <span role="status">{thanked ? w.thanks : ""}</span>
      {open && (
        <form
          className="mt-1 basis-full rounded-md border p-2 text-foreground"
          onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
          onSubmit={(e) => {
            e.preventDefault();
            setOpen(false);
            void post({ type: "feedback", turnId, rating: "down", ...(reason ? { reason } : {}), ...(comment.trim() ? { comment: comment.trim() } : {}) }).then(() => setThanked(true));
          }}
        >
          <fieldset className="space-y-0.5">
            <legend className="font-medium">{w.whatWrong}</legend>
            {REASONS.map((r, i) => (
              <label key={r} className="flex cursor-pointer items-center gap-1.5">
                <input ref={i === 0 ? first : undefined} type="radio" name={`fb-${turnId}`} value={r} checked={reason === r} onChange={() => setReason(r)} />
                {w[r]}
              </label>
            ))}
            <textarea className="mt-1 w-full rounded-sm border bg-transparent p-1" maxLength={1000} aria-label={w.comment} placeholder={w.comment} value={comment} onChange={(e) => setComment(e.target.value)} />
            <button type="submit" className="rounded-sm bg-primary px-2 py-0.5 font-medium text-primary-foreground">
              {w.send}
            </button>
          </fieldset>
        </form>
      )}
    </div>
  );
}
