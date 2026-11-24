import * as React from "react";

// A small markdown renderer, for chat replies and text widgets: paragraphs, bullet and numbered
// lists (one level of nesting), bold, italics, inline code, links, and code
// blocks; a heading becomes a bold line. It builds React elements from text
// and never parses HTML, so a reply cannot put markup in the page. Links open
// in a new tab, and only http(s) and mailto links are links at all.

type Block =
  | { kind: "p"; lines: string[] }
  | { kind: "h"; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: { text: string; children: { ordered: boolean; items: string[] } | null }[] }
  | { kind: "code"; text: string }
  | { kind: "quote"; lines: string[] };

const BULLET = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const FENCE = /^\s*(```|~~~)/;

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    if (FENCE.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i]!)) body.push(lines[i++]!);
      i++;
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      blocks.push({ kind: "h", text: heading[1]! });
      i++;
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s{0,3}>\s?/, ""));
      blocks.push({ kind: "quote", lines: body });
      continue;
    }
    const first = BULLET.exec(line);
    if (first) {
      const baseIndent = first[1]!.length;
      const ordered = /\d/.test(first[2]!);
      const list: Extract<Block, { kind: "list" }> = { kind: "list", ordered, start: ordered ? parseInt(first[2]!, 10) : 1, items: [] };
      while (i < lines.length) {
        const l = lines[i]!;
        if (!l.trim()) {
          // A blank line ends the list unless another item follows it.
          const next = lines[i + 1];
          if (next !== undefined && BULLET.test(next)) {
            i++;
            continue;
          }
          break;
        }
        const m = BULLET.exec(l);
        if (m && m[1]!.length <= baseIndent + 1) {
          list.items.push({ text: m[3]!, children: null });
        } else if (m && list.items.length) {
          const item = list.items.at(-1)!;
          item.children ??= { ordered: /\d/.test(m[2]!), items: [] };
          item.children.items.push(m[3]!);
        } else if (list.items.length && /^\s+/.test(l)) {
          // An indented line continues the item above it.
          const item = list.items.at(-1)!;
          if (item.children) item.children.items[item.children.items.length - 1] += ` ${l.trim()}`;
          else item.text += ` ${l.trim()}`;
        } else break;
        i++;
      }
      blocks.push(list);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !FENCE.test(lines[i]!) && !BULLET.test(lines[i]!) && !/^\s{0,3}(#{1,6}\s|>)/.test(lines[i]!)) para.push(lines[i++]!.trim());
    blocks.push({ kind: "p", lines: para });
  }
  return blocks;
}

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

/** Class names per element, so each host styles it its own way (Tailwind, plain CSS). */
export type MarkdownClasses = { root?: string; code?: string; link?: string; strong?: string; list?: (ordered: boolean, nested: boolean) => string; li?: string; heading?: string; pre?: string; quote?: string };

const cx = (c: string | undefined) => (c === undefined ? {} : { className: c });

// Inline marks, earliest first: code, links, bold, italics. Code is taken
// verbatim; everything else may hold further marks.
const INLINE = /(`+)([^`]+?)\1|\[([^\]]+)\]\(([^)\s]+)\)|\*\*(.+?)\*\*|__(.+?)__|(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?!\w)|(?<![\w_])_(?!\s)(.+?)(?<!\s)_(?![\w])/;

export function renderInline(text: string, key = "i", c: MarkdownClasses = {}): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let rest = text;
  let n = 0;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) {
      out.push(rest);
      break;
    }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    const k = `${key}.${n++}`;
    if (m[2] !== undefined) out.push(<code key={k} {...cx(c.code)}>{m[2]}</code>);
    else if (m[3] !== undefined) {
      const href = m[4]!;
      out.push(
        SAFE_URL.test(href) ? (
          <a key={k} href={href} target="_blank" rel="noopener noreferrer" {...cx(c.link)}>
            {renderInline(m[3], k, c)}
          </a>
        ) : (
          <React.Fragment key={k}>{renderInline(m[3], k, c)}</React.Fragment>
        ),
      );
    } else if (m[5] !== undefined || m[6] !== undefined) out.push(<strong key={k} {...cx(c.strong)}>{renderInline((m[5] ?? m[6])!, k, c)}</strong>);
    else out.push(<em key={k}>{renderInline((m[7] ?? m[8])!, k, c)}</em>);
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

function List({ ordered, start = 1, items, nested, c }: { ordered: boolean; start?: number; items: React.ReactNode[]; nested?: boolean; c: MarkdownClasses }) {
  const cls = cx(c.list?.(ordered, !!nested));
  const children = items.map((item, i) => <li key={i} {...cx(c.li)}>{item}</li>);
  return ordered ? <ol {...cls} start={start === 1 ? undefined : start}>{children}</ol> : <ul {...cls}>{children}</ul>;
}

/** Text as markdown: React elements only, never HTML from the text. */
export function Markdown({ text, classes: c = {} }: { text: string; classes?: MarkdownClasses }) {
  const blocks = React.useMemo(() => parseBlocks(text), [text]);
  return (
    <div {...cx(c.root)} data-testid="markdown">
      {blocks.map((b, i) => {
        const k = `b${i}`;
        switch (b.kind) {
          case "p":
            return <p key={k}>{b.lines.flatMap((l, j) => (j ? [<br key={`${k}br${j}`} />, ...renderInline(l, `${k}.${j}`, c)] : renderInline(l, `${k}.${j}`, c)))}</p>;
          case "h":
            return <p key={k} {...cx(c.heading)}>{renderInline(b.text, k, c)}</p>;
          case "code":
            return <pre key={k} {...cx(c.pre)}>{b.text}</pre>;
          case "quote":
            return <blockquote key={k} {...cx(c.quote)}>{renderInline(b.lines.join(" "), k, c)}</blockquote>;
          case "list":
            return (
              <List
                key={k}
                ordered={b.ordered}
                start={b.start}
                c={c}
                items={b.items.map((item, j) => (
                  <>
                    {renderInline(item.text, `${k}.${j}`, c)}
                    {item.children && <List nested c={c} ordered={item.children.ordered} items={item.children.items.map((t, n) => renderInline(t, `${k}.${j}.${n}`, c))} />}
                  </>
                ))}
              />
            );
        }
      })}
    </div>
  );
}
