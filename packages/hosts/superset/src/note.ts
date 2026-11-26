// A text widget, written to a Superset dashboard as a markdown block.
//
// A board holds no URLs (docs/concepts/boards.md). Superset draws a markdown block with links:
// [text](url), <https://…>, bare http(s) and www. addresses, e-mail addresses, and some HTML. So
// a note Lenspack writes is made plain first: a link becomes its text, brackets and < are escaped,
// and a bare address gets an invisible word joiner (U+2060) after its "http", "www" or "@". Superset
// finds bare addresses in the text after the markdown is read, so a backslash would not stop it;
// the joiner does, and the address still reads as typed. Bold, lists and the rest of the
// formatting are kept. Code (in backticks or a fenced block) is left as it is, because nothing in
// code is drawn as a link.

const FENCE = /^\s{0,3}(```|~~~)/;
const CODE_SPAN = /(`+)[\s\S]*?\1/g;
const JOIN = "\u2060";

function plainText(s: string): string {
  return (
    s
      // [text](url) and ![alt](url): the text alone.
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      // Brackets (reference links) and < (HTML, and <url>), escaped.
      .replace(/(?<!\\)[[\]<]/g, "\\$&")
      // Bare addresses, which Superset would link by itself.
      .replace(/\b(https?|ftp):/gi, `$1${JOIN}:`)
      .replace(/\b(www)\./gi, `$1${JOIN}.`)
      .replace(/@/g, `@${JOIN}`)
  );
}

/** A note's text as a Superset markdown block draws it: formatting kept, no links and no HTML. */
export function plainNote(body: string): string {
  let fenced = false;
  return body
    .split("\n")
    .map((line) => {
      if (FENCE.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      let out = "";
      let at = 0;
      for (const m of line.matchAll(CODE_SPAN)) {
        out += plainText(line.slice(at, m.index)) + m[0];
        at = m.index! + m[0].length;
      }
      return out + plainText(line.slice(at));
    })
    .join("\n");
}
