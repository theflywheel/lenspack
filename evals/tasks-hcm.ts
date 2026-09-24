import type { BoardConfig } from "@lenspack/core";

// Harder tasks on the hcm pack: cross-entity rates, epoch-millisecond time
// windows, soft-delete correctness, fan-out traps, a hierarchy dimension, and
// requests the schema cannot answer — where the right behaviour is an honest
// refusal or a proposal, not a made-up widget.

export type HcmFacts = {
  worstLocality: { locality: string; rate: number; tasks: number }; // lowest success rate among localities with >= 100 visits
  topReason: { reason: string; count: number };
  households: number; // live (not soft-deleted) households
};

export type HcmTask = {
  id: string;
  prompt: string;
  /** edit = the board must change; question = only the reply matters; refusal = nothing should be added. Only edits are reviewed. */
  kind: "edit" | "question" | "refusal";
  check: (config: BoardConfig, reply: string, facts: HcmFacts) => string | null;
};

const loose = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const find = (c: BoardConfig, pred: (w: BoardConfig["widgets"][string], id: string) => boolean) => Object.entries(c.widgets).find(([id, w]) => pred(w, id));
const KEYS = (c: BoardConfig) => Object.keys(c.widgets);

export const hcmTasks: HcmTask[] = [
  {
    id: "delivery-by-locality",
    kind: "edit",
    prompt: "Show the delivered rate of product lines by locality as a bar chart, lowest first.",
    check: (c) => {
      const hit = find(c, (w) => w.kind === "chart" && w.chart === "bar" && w.query.kind === "breakdown" && w.query.measure === "delivered_rate" && w.query.dimension === "locality");
      if (!hit) return "no bar of delivered_rate by locality";
      const q = hit[1].kind === "chart" ? hit[1].query : null;
      return q && q.kind === "breakdown" && q.sort === "asc" ? null : "not sorted ascending";
    },
  },
  {
    id: "fanout-trap",
    kind: "edit",
    prompt: "Add a pie chart of administration success rate by product variant.",
    // success_rate lives on tasks; product on resources across a one-to-many. The
    // answerable neighbour is delivered_rate by product (resources grain).
    check: (c) => {
      const wrong = find(c, (w) => w.kind === "chart" && w.query.kind === "breakdown" && w.query.dimension === "product" && w.query.measure === "success_rate");
      if (wrong) return "added a fan-out widget (success_rate by product) — should have been refused";
      const ok = find(c, (w) => w.kind === "chart" && w.query.kind === "breakdown" && w.query.dimension === "product" && ["delivered_rate", "resources", "undelivered", "quantity"].includes(w.query.measure));
      return ok ? null : "did not recover with a resources-grain measure by product";
    },
  },
  {
    id: "epoch-window",
    kind: "edit",
    prompt: "Plot weekly visits split by campaign for the last 10 weeks as a line chart.",
    check: (c) => {
      const hit = find(c, (w) => w.kind === "chart" && w.query.kind === "series" && w.query.measure === "tasks" && w.query.grain === "week" && w.query.by === "campaign");
      if (!hit) return "no weekly tasks series split by campaign";
      const q = hit[1].kind === "chart" ? hit[1].query : null;
      return q?.time && "last" in q.time && q.time.last === "10w" ? null : `window not 10w: ${JSON.stringify(q?.time)}`;
    },
  },
  {
    id: "duration-percentile",
    kind: "edit",
    prompt: "Add a KPI for the P90 visit length in minutes over the last 30 days, and a bar chart of median visit length by project.",
    check: (c) => {
      const kpi = find(c, (w) => w.kind === "kpi" && w.query.kind === "value" && w.query.measure === "p90_visit_minutes");
      if (!kpi) return "no p90_visit_minutes KPI";
      const kq = kpi[1].kind === "kpi" ? kpi[1].query : null;
      if (!(kq?.time && "last" in kq.time && kq.time.last === "30d")) return "KPI window not 30d";
      const bar = find(c, (w) => w.kind === "chart" && w.query.kind === "breakdown" && w.query.measure === "median_visit_minutes" && w.query.dimension === "project");
      return bar ? null : "no median_visit_minutes by project";
    },
  },
  {
    id: "hierarchy",
    kind: "edit",
    prompt: "Compare refusal rate across campaigns as a bar chart, then add a filter on campaign that applies to everything.",
    check: (c) => {
      const bar = find(c, (w) => w.kind === "chart" && w.query.kind === "breakdown" && w.query.measure === "refusal_rate" && w.query.dimension === "campaign");
      if (!bar) return "no refusal_rate by campaign";
      return c.filters.some((f) => f.field === "campaign" && f.applies.includes("*")) ? null : "no campaign filter applying to *";
    },
  },
  {
    id: "question-worst-locality",
    kind: "question",
    prompt: "Which locality has the lowest administration success rate among localities with at least 100 visits? Give the locality code, its rate and its visit count.",
    check: (_c, reply, f) => {
      const pct = (f.worstLocality.rate * 100).toFixed(1);
      const named = reply.includes(f.worstLocality.locality);
      const rated = reply.includes(pct) || reply.includes(pct.replace(/\.\d$/, "")) || reply.includes(f.worstLocality.rate.toFixed(3));
      return named && rated ? null : `expected ${f.worstLocality.locality} at ${pct}% (${f.worstLocality.tasks} visits): "${reply.slice(0, 160)}"`;
    },
  },
  {
    id: "question-top-reason",
    kind: "question",
    prompt: "What is the most common reason a product line was not delivered, and how many lines does it account for?",
    check: (_c, reply, f) => (loose(reply).includes(loose(f.topReason.reason)) && reply.includes(String(f.topReason.count)) ? null : `expected ${f.topReason.reason} (${f.topReason.count}): "${reply.slice(0, 160)}"`),
  },
  {
    id: "unanswerable-radius",
    kind: "refusal",
    prompt: "Add a map of households within 2 km of facility FAC-7.",
    // Nothing in the pack can express this. The right outcome: no widget added,
    // and the reply says so (optionally proposing a measure).
    check: (c, reply) => {
      if (KEYS(c).length !== 7) return `a widget was added (${KEYS(c).length - 7}) for an unanswerable request`;
      return /cannot|can't|not (possible|supported|available)|no (map|way)|unable|isn't|doesn't/i.test(reply) ? null : `reply did not say it cannot: "${reply.slice(0, 160)}"`;
    },
  },
  {
    id: "two-dimensions",
    kind: "refusal",
    prompt: "Add a stacked bar chart of visits by locality and status.",
    // A breakdown takes one dimension; a series can split by one. The honest
    // answers: a breakdown by one of them plus a filter, or a clear statement.
    check: (c, reply) => {
      const added = KEYS(c).length - 7;
      if (added === 0) return /one dimension|single dimension|cannot|can't|not supported/i.test(reply) ? null : `nothing added and no explanation: "${reply.slice(0, 160)}"`;
      const ok = find(c, (w) => w.kind === "chart" && w.query.kind === "breakdown" && w.query.measure === "tasks" && (w.query.dimension === "locality" || w.query.dimension === "status"));
      return ok ? null : "added something that is not visits by locality or by status";
    },
  },
  {
    id: "soft-delete-count",
    kind: "question",
    prompt: "How many households are registered in total? Reply with the number.",
    // The seed soft-deletes ~4%; the pack's entity filter must exclude them.
    check: (_c, reply, f) => (reply.replace(/,/g, "").includes(String(f.households)) ? null : `expected ${f.households}: "${reply.slice(0, 120)}"`),
  },
];
