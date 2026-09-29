import type { BoardConfig, Catalogue } from "@lenspack/core";
import { summarise } from "@lenspack/core";
import type { Pack } from "@lenspack/spec";

// The system prompt the chat and the eval suite share: improving it here
// improves both, and the evals say whether it did. Bump PROMPT_VERSION when
// it changes so eval results can be compared.
export const PROMPT_VERSION = 3;

// The schema, in context, once. A pack is the "figure out the structure
// first" step — done by people, stored as data — so the model reads it here
// rather than discovering it with tool calls every turn. list_metrics stays
// as a search for catalogues too large to inline.
export function catalogueText(pack: Pack, catalogue: Catalogue) {
  const entities = Object.entries(pack.entities).map(([k, e]) => {
    const joins = e.joins.map((j) => `→ ${j.to} (${j.type.replace(/_/g, "-")})`).join(", ");
    return `- ${k}: ${e.grain ?? ""}${e.time ? `; time column ${e.time}` : "; no time column"}${e.tenant ? "; tenant-scoped" : ""}${joins ? `; joins ${joins}` : ""}`;
  });
  const dims = catalogue.dimensions.filter((d) => d.verified).map((d) => `- ${d.key} (${d.entity}, ${d.type}${d.grains ? `, grains ${d.grains.join("/")}` : ""}): ${d.label}${d.synonyms?.length ? ` [${d.synonyms.join(", ")}]` : ""}${d.hint ? ` — ${d.hint}` : ""}`);
  const measures = catalogue.measures.filter((m) => m.verified).map((m) => `- ${m.key} (${m.entity}, ${m.format}): ${m.label}${m.synonyms?.length ? ` [${m.synonyms.join(", ")}]` : ""}${m.hint ? ` — ${m.hint}` : ""}`);
  return [
    `ENTITIES (a measure is computed at its entity's grain; a dimension on another entity needs a many-to-one path):`,
    ...entities,
    `DIMENSIONS (key (entity, type): label [synonyms] — hint):`,
    ...dims,
    `MEASURES (key (entity, format): label [synonyms] — hint):`,
    ...measures,
  ].join("\n");
}

export const SYSTEM = (pack: Pack, catalogue: Catalogue, board?: BoardConfig) => `You build and edit a dashboard ("board") over the "${pack.pack}" data pack.

${catalogueText(pack, catalogue)}

${board ? `CURRENT BOARD:\n${summarise(board)}` : ""}

Rules:
- Use only the keys listed above. The schema is complete; do not call list_metrics unless you need to search a key you cannot find here. The current board is shown above; call get_board only after your edits, to verify.
- Every edit is a tool call. Never describe an edit you did not make. Do not ask permission for straightforward edits; just make them and say what changed.
- If a tool returns applied:false with didYouMean, retry once with that key. If a query is refused for fan-out, use a measure on the other entity instead (the hints say which).
- A tool result with applied:false or an error means that edit did NOT happen. Fix the arguments and call it again; never move on as if it worked.
- Placement is intent, not coordinates: "at the top" / "across the top" means place: top (the server makes room, even when the top row is full); "at the bottom" means place: bottom; "after the X chart" means place: after:<id>. Width: full, half, third or quarter as asked; KPIs default to quarter.
- Prefer a breakdown for "by X", a series for "over time" / "weekly" / "per month", a value for a single number. "Pie" needs a breakdown.
- To answer a question about the data, use query and give the answer with the number.
- "Make it compact" / "pack it" / "use less space": set_layout_mode with density compact and fill true.
- Before replying after edits, call get_board once and check every requested change is present. Report only what get_board shows; if something could not be done, say so plainly.
- Reply in one or two plain sentences with the outcome only. Never narrate your reasoning, plans or which tools you are about to call. No markdown headings, no bullet lists.`;
