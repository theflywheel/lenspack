import type { BoardConfig } from "@lenspack/core";

// Board-building tasks a model must complete through the tools, each with a
// check on the resulting board (or the reply). Deliberately covering the
// failure modes that matter: vocabulary, refusal recovery, multi-step edits,
// and answering a question with a real number.

/** Facts computed from the eval database, so checks never hard-code numbers. */
export type Facts = { topRefund: { country: string; rate: number } };

export type Task = {
  id: string;
  prompt: string;
  /** Returns null when the task passed, or what is wrong. */
  check: (config: BoardConfig, reply: string, facts: Facts) => string | null;
};

const widget = (c: BoardConfig, pred: (w: BoardConfig["widgets"][string]) => boolean) => Object.entries(c.widgets).find(([, w]) => pred(w));

export const tasks: Task[] = [
  {
    id: "kpi",
    prompt: "Add a KPI for total revenue across the top, quarter width.",
    check: (c) => {
      // The canonical board already has a revenue KPI (revenue_30d); the new
      // one must be another widget, on row 1, at most a third wide.
      const hits = Object.entries(c.widgets).filter(([id, w]) => id !== "revenue_30d" && w.kind === "kpi" && w.query.kind === "value" && w.query.measure === "revenue");
      if (hits.length === 0) return "no new kpi widget with a value query on revenue";
      const placed = hits.map(([id]) => c.layout.find((l) => l.i === id)!);
      return placed.some((l) => l.y === 0 && l.w <= 4) ? null : `new kpi not on the top row at quarter width (${placed.map((l) => `y=${l.y}, w=${l.w}`).join("; ")})`;
    },
  },
  {
    id: "breakdown",
    prompt: "Show revenue by country as a bar chart.",
    check: (c) => (widget(c, (w) => w.kind === "chart" && w.chart === "bar" && w.query.kind === "breakdown" && w.query.dimension === "country" && w.query.measure === "revenue") ? null : "no bar chart of revenue by country"),
  },
  {
    id: "series-split",
    prompt: "Plot weekly orders split by channel for the last 12 weeks, as a line chart.",
    check: (c) => {
      const hit = widget(c, (w) => w.kind === "chart" && w.query.kind === "series" && w.query.measure === "orders" && w.query.grain === "week" && w.query.by === "channel");
      if (!hit) return "no weekly orders series split by channel";
      const q = hit[1].kind !== "text" ? hit[1].query : null;
      return q && q.time && "last" in q.time && /^12w$/.test(q.time.last) ? null : `time window not 12w (${JSON.stringify(q && q.time)})`;
    },
  },
  {
    id: "fanout-recovery",
    prompt: "Add a pie chart of revenue by product category.",
    // revenue lives on orders; category on products across a one-to-many — the model must recover with item_revenue.
    check: (c) => (widget(c, (w) => w.kind === "chart" && w.query.kind === "breakdown" && w.query.dimension === "category" && w.query.measure === "item_revenue") ? null : "did not recover from the fan-out refusal with item_revenue by category"),
  },
  {
    id: "typo-recovery",
    prompt: "Add a bar chart of refund rate by contry.",
    check: (c) => (widget(c, (w) => w.kind === "chart" && w.query.kind === "breakdown" && w.query.dimension === "country" && w.query.measure === "refund_rate") ? null : "did not recover from the typo to country"),
  },
  {
    id: "multi-step",
    prompt: "Rename the board to Shop health, add a country filter that applies to everything, and remove the pie chart.",
    check: (c) => {
      if (c.title !== "Shop health") return `title is "${c.title}"`;
      if (!c.filters.some((f) => f.field === "country" && f.applies.includes("*"))) return "no country filter applying to *";
      if (widget(c, (w) => w.kind === "chart" && w.chart === "pie")) return "pie chart still present";
      return null;
    },
  },
  {
    id: "question",
    prompt: "Which country has the highest refund rate? Answer with the country code and the rate.",
    check: (_c, reply, facts) => {
      const { country, rate } = facts.topRefund;
      const pct = (rate * 100).toFixed(1);
      const namesCountry = new RegExp(`\\b${country}\\b`, "i").test(reply);
      const namesRate = reply.includes(pct) || reply.includes(pct.replace(/\.\d$/, "")) || reply.includes(rate.toFixed(3));
      return namesCountry && namesRate ? null : `expected ${country} at ${pct}%: "${reply.slice(0, 120)}"`;
    },
  },
  {
    id: "layout",
    prompt: "Make the weekly revenue chart full width and move it to the top.",
    check: (c) => {
      const item = c.layout.find((l) => l.i === "revenue_trend");
      if (!item) return "revenue_trend widget missing";
      return item.w === 12 && item.y === 0 ? null : `revenue_trend is w=${item.w} y=${item.y}`;
    },
  },
];
