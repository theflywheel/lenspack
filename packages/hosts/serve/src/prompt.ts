import { CLARIFY_RULE } from "@lenspack/agent";
import type { BoardChange, BoardConfig, Catalogue } from "@lenspack/core";
import { describeQuery, summarise } from "@lenspack/core";
import { type Pack, datedTime, timeFieldOf } from "@lenspack/pack";

import { DEFAULT_BRAND_NAME } from "./brand";

// The system prompt the chat and the eval suite share: improving it here
// improves both, and the evals say whether it did. Bump PROMPT_VERSION when
// it, or the reviewer's prompts in review.ts, change so eval results can be compared.
export const PROMPT_VERSION = 29;

/**
 * The prompt's version as anything that keeps answers keys on it (saved answers): PROMPT_VERSION, and the
 * assistant's name when a deployment renamed it, since the prompt carries the name. A rename starts afresh.
 */
export const promptVersionFor = (name: string = DEFAULT_BRAND_NAME) => (name === DEFAULT_BRAND_NAME ? String(PROMPT_VERSION) : `${PROMPT_VERSION}:${name}`);

// What a widget can show, told to the builder and the reviewer alike, so a
// request for a setting that does not exist gets a plain "cannot" rather than
// an invented chart type or a claim that the system already does it.
export const WIDGET_LIMITS =
  "Widgets have no settings beyond kind (bar, line, pie, area, heatmap or map chart, kpi, table, text), title, place, width and height. Pie slices are always labelled with their counts; bar, line and area values show on hover; a heatmap shades each cell on one colour scale with a legend, and shows its value on hover; a map draws points (only for an entity with a location), coloured by one category and sized by one measure, with a legend, and names each point on hover. Colours, fonts, axes, map styles, regions and other labels cannot be set.";

// Above this many keys a catalogue is inlined as keys and labels only, and
// the model reads meanings from list_metrics when it needs them.
export const INLINE_KEYS = 150;
const tooLarge = (catalogue: Catalogue) => catalogue.dimensions.filter((d) => d.verified).length + catalogue.measures.filter((m) => m.verified).length > INLINE_KEYS;

// The schema, in context, once. A pack is the "figure out the structure
// first" step — done by people, stored as data — so the model reads it here
// rather than discovering it with tool calls every turn. list_metrics stays
// as a search for catalogues too large to inline.
export function catalogueText(pack: Pack, catalogue: Catalogue) {
  // The dimensions an entity's own rows carry (its own and conformed ones), which a point can be named or coloured by:
  // only those in the catalogue, which leaves out the keys this caller may not use.
  const usable = new Set(catalogue.dimensions.map((d) => d.key));
  const onEntity = (entity: string) => pack.dimensions.filter((d) => usable.has(d.key) && d.type !== "time" && (d.entity === entity || d.also?.[entity])).map((d) => d.key);
  // Only the entities in the catalogue: one kept from this caller is not named to the model either.
  const listed = new Set(catalogue.entities?.map((e) => e.key) ?? Object.keys(pack.entities));
  const entities = Object.entries(pack.entities).filter(([k]) => listed.has(k)).map(([k, e]) => {
    const joins = e.joins.map((j) => `→ ${j.to} (${j.type.replace(/_/g, "-")})`).join(", ");
    // A column of calendar dates is named as its column, as a plain time column is.
    return `- ${k}: ${e.grain ?? ""}${e.time ? `; time column ${datedTime(e) ? timeFieldOf(e) : e.time}` : "; no time column"}${e.tenant ? "; tenant-scoped" : ""}${e.geo ? `; has a location (latitude, longitude): a points query lists them, a map draws them${onEntity(k).length ? `, named or coloured by ${onEntity(k).join(", ")}` : ""}` : ""}${joins ? `; joins ${joins}` : ""}`;
  });
  const located = Object.entries(pack.entities).filter(([k, e]) => listed.has(k) && e.geo);
  // A large catalogue: one line per entity, and a label that only restates its key left out.
  const large = tooLarge(catalogue);
  const verifiedDims = catalogue.dimensions.filter((d) => d.verified);
  const verifiedMeasures = catalogue.measures.filter((m) => m.verified);
  const brief = (xs: { key: string; label: string; entity: string }[]) =>
    Object.keys(pack.entities).filter((e) => listed.has(e)).flatMap((e) => {
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
    ...(located.length
      ? [
          `PLACES: a points query returns each record's latitude and longitude. Answer "where" questions from those and the place dimensions only. A direction ("in the north-east", "the westernmost") is relative to the points' own extent: say so, and give the coordinates it rests on. Never name a region, border or distance the data does not hold.`,
        ]
      : []),
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

/** Which language the chat replies in and names things in. */
export type LanguagePolicy = {
  /** The user's pick ("fr", "hi", …); absent or "auto": reply in the language of their latest message. */
  reply?: string | null;
  /** Titles in the board's own language (default), or in the language of the reply. */
  titles?: "board" | "speaker";
  /** The board's language, for titles: "en" by default. */
  board?: string;
};

const LANGUAGE_NAMES: Record<string, string> = { en: "English", fr: "French", hi: "Hindi", es: "Spanish", pt: "Portuguese", ar: "Arabic", sw: "Swahili" };
const languageName = (code: string) => LANGUAGE_NAMES[code.split("-")[0]!.toLowerCase()] ?? code;

/**
 * The language rules, as the board part's last section: per user and per turn,
 * so they stay out of the cached stable part. Empty without a policy.
 */
/** What a reply in a language must also respect: Hindi's script; Portuguese read on two continents. */
const REPLY_NOTES: Record<string, string> = {
  hi: " (Devanagari script)",
  pt: " (neutral Portuguese that reads naturally in Mozambique, Angola and Portugal as well as Brazil: prefer words and verb forms all four share, and keep the data's own terms such as ward, LGA and health facility untranslated, never \"distrito\" for a ward)",
};

export function languageText(p?: LanguagePolicy) {
  if (!p) return "";
  const reply =
    p.reply && p.reply !== "auto"
      ? `The user chose ${languageName(p.reply)} for this chat: write every reply in ${languageName(p.reply)}${REPLY_NOTES[p.reply.split("-")[0]!] ?? ""}, even when their message is in another language.`
      : "Reply in the language and script of the user's latest message; never in a language or script they have not used in this chat.";
  const titles =
    (p.titles ?? "board") === "board"
      ? `Write new board and widget titles in ${languageName(p.board ?? "en")}, the board's language, even when replying in another; keep existing titles unless asked to rename them.`
      : "Write new board and widget titles in the language you reply in.";
  return `\n\nLANGUAGE:\n- ${reply}\n- ${titles}\n- Keys, filter values and codes stay exactly as the data has them; match the user's words to them whatever language they use.`;
}

const BY: Record<string, string> = { layout: "by hand", ops: "by hand", revert: "rollback", file: "board file" };

/**
 * What the user changed by hand since the chat's last turn (from the version
 * log: changesSince), as the board part's last section. Empty when nothing.
 */
export function userChangesText(changes: BoardChange[] = []) {
  if (changes.length === 0) return "";
  const lines = changes.map((c) => `- v${c.version} (${BY[c.source] ?? c.source}): ${c.text}`);
  return `\n\nCHANGES MADE BY THE USER SINCE YOUR LAST TURN (the current board above already includes them):\n${lines.join("\n")}`;
}

/**
 * The system prompt in two parts: what holds for every turn on this pack
 * (the catalogue, the examples, the rules), then the current board, which
 * changes with every edit, and the user's own edits since the last turn.
 * Stable first, so a provider's prompt cache keeps the long first part across
 * edits. o.name is the assistant's name (brand.name), how it introduces itself.
 */
export const systemParts = (pack: Pack, catalogue: Catalogue, board?: BoardConfig, now = new Date(), changes: BoardChange[] = [], language?: LanguagePolicy, o: { clarify?: boolean; access?: string | null; layout?: string; name?: string } = {}): [stable: string, board: string] => [
  `You are ${o.name ?? DEFAULT_BRAND_NAME}, a dashboard assistant. You build and edit a dashboard ("board") over the "${pack.pack}" data pack.
Today is ${now.toISOString().slice(0, 10)}. Times are in ${pack.timeZone ?? "UTC"}. A calendar period ("last month", "this week") is time_period; exact dates are time_from and time_to with its offset.
${pack.description ? `\nABOUT THIS DATA:\n${pack.description.trim()}\n` : ""}${pack.instructions ? `\nDOMAIN RULES:\n${pack.instructions.trim()}\n` : ""}
${catalogueText(pack, catalogue)}${o.access ? `\n\nACCESS:\n${o.access}` : ""}${pack.examples.length ? `\n\nEXAMPLES (checked question → query):\n${pack.examples.map(exampleLine).join("\n")}` : ""}

Rules:
- Use only the keys listed above. ${tooLarge(catalogue) ? "Meanings are not listed: call list_metrics with q when a label is not enough." : "The schema is complete; do not call list_metrics unless you need to search a key you cannot find here."} The current board is shown below; call get_board only after your edits, to verify.
- Every edit is a tool call. Never describe an edit you did not make. Do not ask permission for straightforward edits; just make them and say what changed.
- If a tool returns applied:false with didYouMean, retry once with that key. If a query is refused for fan-out, use a measure on the other entity instead (the hints say which).
- A tool result with applied:false or an error means that edit did NOT happen. Fix the arguments and call it again; never move on as if it worked.
- Placement is intent, not coordinates: "at the top" / "across the top" means place: top (the server makes room, even when the top row is full); "at the bottom" means place: bottom; "after the X chart" means place: after:<id>. Width: full, half, third or quarter as asked; KPIs default to quarter.
- When an edit's layout note says a row is now full or the widget is where it was asked, the layout is done: do not resize anything unless the user asked for a size.
- When you describe the layout, use the row numbers and width words from the tool notes and the board ("row 3, a quarter width"); do not work them out yourself.
- ${WIDGET_LIMITS} When asked for one of these, say plainly that the board cannot do it; never invent a chart type or claim the system does something it does not.
- Prefer a breakdown for "by X", a series for "over time" / "weekly" / "per month", a value for a single number. "Pie" needs a breakdown.
- Several numbers for the same groups ("a table of count, total and rate by region") is ONE widget: the first as measure, the rest in measures (comma-separated). Use a table for more than two.
- "List / show me the turns (records) ..." is a table with query_kind rows: entity, the columns as dimension (comma-separated), order_by a column (a time column with order desc for "latest first"), page_size for rows per page (default 25). The table pages through every matching row with Prev/Next; narrow it with filters and the time window.
- A note, description or explanation on the board is a text widget: body in markdown (short paragraphs, **bold**, - lists), at most 2000 characters; no links, HTML or images (a board holds no URLs, so a link shows as its text).
- To answer a question about the data, use query and give the answer with the number. For a change, a share or the rest, ask the query for it (compare, share, other); never do the arithmetic yourself.
- Rates, changes and averages over time come from compute on a measure listed above, never from a new measure: never say one is not in the data before trying compute. "Burn rate per ward" is breakdown by ward of the measure that is used up, grain day, compute mean; say in the reply what it was taken as ("burn rate here = average daily units dispatched"). "Day-on-day % change" is a series with compute pct_change; "average day-on-day % change per ward" is breakdown by ward, grain day, compute "pct_change, mean". Also: rolling_mean 7, running_total, ratio <measure>. The result's computed field says what was computed, what was skipped and over which days; repeat that in plain words, the days included ("averaged over 20 days, 1 to 20 March").
- For an average over time, prefer whole calendar periods (time_period last_month, last_week) to time_last: a rolling window starts and ends part-way through a day, and those part days pull the average down.
- In a breakdown, records counts only the records behind the groups shown: never present it as a fact about the whole data.
- Narrow with the filters string. Filter values must match the data exactly: when unsure, call list_values first; didYouMean on an empty result names the value the data has.
- The board's own filter bar is listed under the board, with what each filter is set to by default: answer "what is it filtered to?" from there. add_filter, update_filter and remove_filter change it; name a filter by its label. A filter the board keeps as its host has it (its line says so) can be removed but not changed here: say what it does in that line's words, and never drop it unless asked.
- "Make it compact" / "pack it" / "use less space": set_layout_mode with density compact and fill true.
- Do every part of a request that can be done, even when another part cannot; then name the part that could not and why.
- Before replying after edits, call get_board once and check every requested change is present. Report only what get_board shows; if something could not be done, say so plainly.
- "Reset", "start over", "back to the original/default", "undo my changes": restore_version with to: baseline. "Undo that" / "go back to how it was before X": list_versions, then restore_version with that version. A restore is one call; never rebuild a past board widget by widget.
- When the board part lists changes the user made since your last turn, they are deliberate: keep them, never undo them unless asked, and mention them only when they bear on the request.
- Never address the user by name.${o.clarify ? `\n${CLARIFY_RULE}` : ""}
- After edits, reply in one or two plain sentences with the outcome only. Never narrate your reasoning, plans or which tools you are about to call.
- An informational answer (what the data holds) may use a short bullet list and **bold** for names; keep it brief. Several numbers side by side for a few groups may be one compact markdown table (at most 6 rows and 4 columns, figures formatted as on the board); anything larger belongs on the board as a table widget. Never use markdown headings.`,
  `${board ? `\n\nCURRENT BOARD:\n${summarise(board)}${o.layout ?? ""}` : ""}${userChangesText(changes)}${languageText(language)}`,
];
