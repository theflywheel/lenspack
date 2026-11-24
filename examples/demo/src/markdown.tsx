import { Markdown as Render, type MarkdownClasses, parseBlocks, renderInline } from "@lenspack/react";

// The chat's replies use the renderer the text widgets use (no HTML from the
// text, only http(s) and mailto links, in a new tab), styled for the panel.
export { parseBlocks, renderInline };

const CHAT: MarkdownClasses = {
  code: "rounded bg-muted px-1 py-px font-mono text-[0.85em]",
  link: "underline underline-offset-2 hover:text-foreground",
  strong: "font-semibold text-foreground",
  list: (ordered, nested) => `${ordered ? "list-decimal" : "list-disc"} space-y-0.5 pl-5 marker:text-muted-foreground ${nested ? "mt-0.5" : ""}`,
  li: "pl-0.5",
  heading: "font-semibold text-foreground",
  pre: "overflow-x-auto rounded bg-muted px-2 py-1.5 font-mono text-xs leading-5",
  quote: "border-l-2 pl-2 text-muted-foreground",
};

/** A chat reply as markdown, compact enough for a side panel. */
export function Markdown({ text, className = "" }: { text: string; className?: string }) {
  return <Render text={text} classes={{ ...CHAT, root: `space-y-2 text-sm leading-6 ${className}` }} />;
}
