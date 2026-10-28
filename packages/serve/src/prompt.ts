import type { BoardConfig, Catalogue } from "@lenspack/core";
import { describeQuery, summarise } from "@lenspack/core";
import type { Pack } from "@lenspack/spec";

// The system prompt the chat and the eval suite share: improving it here
// improves both, and the evals say whether it did. Bump PROMPT_VERSION when
// it changes so eval results can be compared.
export const PROMPT_VERSION = 7;

// What a widget can show, told to the builder and the reviewer alike, so a
// request for a setting that does not exist gets a plain "cannot" rather than
// an invented chart type or a claim that the system already does it.
export const WIDGET_LIMITS =
  "Widgets have no settings beyond kind (bar, line, pie or area chart, kpi, table, text), title, place, width and height. Pie slices are always labelled with their counts; bar, line and area values show on hover. Colours, fonts, axes and other labels cannot be set.";

// Above this many keys a catalogue is inlined as keys and labels only, and
// the model reads meanings from list_metrics when it needs them.
export const INLINE_KEYS = 150;
const tooLarge = (catalogue: Catalogue) => catalogue.dimensions.filter((d) => d.verified).length + catalogue.measures.filter((m) => m.verified).length > INLINE_KEYS;

// The schema, in context, once. A pack is the "figure out the structure
// first" step — done by people, stored as data — so the model reads it here
// rather than discovering it with tool calls every turn. list_metrics stays
// as a search for catalogues too large to inline.
export function catalogueText(pack: Pack, catalogue: Catalogue) {
  const entities = Object.entries(pack.entities).map(([k, e]) => {
    const joins = e.joins.map((j) => `→ ${j.to} (${j.type.replace(/_/g, "-")})`).join(", ");
    return `- ${k}: ${e.grain ?? ""}${e.time ? `; time column ${e.time}` : "; no time column"}${e.tenant ? "; tenant-scoped" : ""}${joins ? `; joins ${joins}` : ""}`;
  });
  // A large catalogue: one line per entity, and a label that only restates its key left out.
  const large = tooLarge(catalogue);
  const verifiedDims = catalogue.dimensions.filter((d) => d.verified);
  const verifiedMeasures = catalogue.measures.filter((m) => m.verified);
  const brief = (xs: { key: string; label: string; entity: string }[]) =>
    Object.keys(pack.entities).flatMap((e) => {
      const keys = xs.filter((x) => x.entity === e).map((x) => (x.label.toLowerCase() === x.key.replace(/_/g, " ") ? x.key : `${x.key} (${x.label})`));
      return keys.length ? [`- ${e}: ${keys.join(", ")}`] : [];
    });
  const dims = large ? brief(verifiedDims) : verifiedDims.map((d) => `- ${d.key} (${d.entity}, ${d.type}${d.grains ? `, grains ${d.grains.join("/")}` : ""}): ${d.label}${d.synonyms?.length ? ` [${d.synonyms.join(", ")}]` : ""}${d.hint ? ` — ${d.hint}` : ""}`);
  const measures = large ? brief(verifiedMeasures) : verifiedMeasures.map((m) => `- ${m.key} (${m.entity}, ${m.format}): ${m.label}${m.synonyms?.length ? ` [${m.synonyms.join(", ")}]` : ""}${m.hint ? ` — ${m.hint}` : ""}`);
  return [
    `ENTITIES (a measure is computed at its entity's grain; a dimension on another entity needs a many-to-one path):`,
    ...entities,
    large ? `DIMENSIONS by entity (key (label)):` : `DIMENSIONS (key (entity, type): label [synonyms] — hint):`,
    ...dims,
    large ? `MEASURES by entity (key (label)):` : `MEASURES (key (entity, format): label [synonyms] — hint):`,
    ...measures,
  ].join("\n");
}

// An example as the board summary words a query, with the filters and a
// rows query's order and limit, which that summary leaves out.
const exampleLine = ({ question, query: q, note }: Pack["examples"][number]) => {
  const order = q.kind === "rows" ? `${q.orderBy ? ` order by ${q.orderBy.key} ${q.orderBy.dir}` : ""}${q.limit !== 50 ? ` top ${q.limit}` : ""}` : "";
  const filters = (q.filters ?? []).map((f) => ` where ${f.dimension} ${f.op} ${JSON.stringify(f.value)}`).join("");
  // describeQuery already names a rows query as rows.
  return `- "${question}" → ${q.kind === "rows" ? "" : `${q.kind} `}${describeQuery(q)}${order}${filters}${note ? ` (${note})` : ""}`;
};

export const SYSTEM = (pack: Pack, catalogue: Catalogue, board?: BoardConfig, now = new Date()) => `You build and edit a dashboard ("board") over the "${pack.pack}" data pack.
Today is ${now.toISOString().slice(0, 10)}. Times are in ${pack.timeZone ?? "UTC"}. A calendar period ("last month", "this week") is time_period; exact dates are time_from and time_to with its offset.
${pack.description ? `\nABOUT THIS DATA:\n${pack.description.trim()}\n` : ""}${pack.instructions ? `\nDOMAIN RULES:\n${pack.instructions.trim()}\n` : ""}
${catalogueText(pack, catalogue)}${pack.examples.length ? `\n\nEXAMPLES (checked question → query):\n${pack.examples.map(exampleLine).join("\n")}` : ""}

${board ? `CURRENT BOARD:\n${summarise(board)}` : ""}

Rules:
- Use only the keys listed above. ${tooLarge(catalogue) ? "Meanings are not listed: call list_metrics with q when a label is not enough." : "The schema is complete; do not call list_metrics unless you need to search a key you cannot find here."} The current board is shown above; call get_board only after your edits, to verify.
- Every edit is a tool call. Never describe an edit you did not make. Do not ask permission for straightforward edits; just make them and say what changed.
- If a tool returns applied:false with didYouMean, retry once with that key. If a query is refused for fan-out, use a measure on the other entity instead (the hints say which).
- A tool result with applied:false or an error means that edit did NOT happen. Fix the arguments and call it again; never move on as if it worked.
- Placement is intent, not coordinates: "at the top" / "across the top" means place: top (the server makes room, even when the top row is full); "at the bottom" means place: bottom; "after the X chart" means place: after:<id>. Width: full, half, third or quarter as asked; KPIs default to quarter.
- ${WIDGET_LIMITS} When asked for one of these, say plainly that the board cannot do it; never invent a chart type or claim the system does something it does not.
- Prefer a breakdown for "by X", a series for "over time" / "weekly" / "per month", a value for a single number. "Pie" needs a breakdown.
- Several numbers for the same groups ("a table of count, total and rate by region") is ONE widget: the first as measure, the rest in measures (comma-separated). Use a table for more than two.
- To answer a question about the data, use query and give the answer with the number. For a change, a share or the rest, ask the query for it (compare, share, other); never do the arithmetic yourself.
- Narrow with the filters string. Filter values must match the data exactly: when unsure, call list_values first; didYouMean on an empty result names the value the data has.
- "Make it compact" / "pack it" / "use less space": set_layout_mode with density compact and fill true.
- Before replying after edits, call get_board once and check every requested change is present. Report only what get_board shows; if something could not be done, say so plainly.
- Reply in one or two plain sentences with the outcome only. Never narrate your reasoning, plans or which tools you are about to call. No markdown headings, no bullet lists.`;
