import { QUERY, assembleQuery } from "@lenspack/agent";
import { type Connector, type Ctx, run } from "@lenspack/engine";
import type { Pack } from "@lenspack/pack";

import type { ComparedReading, Comparison, OpenQuestion } from "./questions";

// Compare readings: each reading of an open question run through the engine as its stored query
// says, with no model, and the figures put side by side ("counting this way gives 1,240 on the top
// facility; that way gives 310"). The plan is the reading's own query arguments, written by the daily
// review or an admin; a reading with only words is listed as not runnable.

const TOP = 8;

/** A number as the panel shows it: a percentage for a percent format between -1.5 and 1.5, else grouped digits. */
export function figure(v: number | null | undefined, format?: string): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "no value";
  if (format === "percent" && Math.abs(v) <= 1.5) return `${(v * 100).toLocaleString("en", { maximumFractionDigits: 1 })}%`;
  return v.toLocaleString("en", { maximumFractionDigits: Math.abs(v) < 10 ? 2 : Math.abs(v) < 1000 ? 1 : 0 });
}

/** One reading's figures. */
export async function runReading(r: OpenQuestion["readings"][number], o: { pack: Pack; connector: Connector; ctx?: Ctx; timeoutMs?: number }): Promise<ComparedReading> {
  const base = { reading: r.id, label: r.label };
  if (!r.query) return { ...base, ok: false, error: "this reading has no query to run", summary: "not runnable: no query" };
  try {
    const args = QUERY.parse(r.query);
    if (args.query_kind === "rows" || args.query_kind === "points") return { ...base, ok: false, error: "only value, breakdown and series readings are compared", summary: "not compared" };
    const query = assembleQuery(args, o.pack);
    const data = await run(query, { pack: o.pack, connector: o.connector, ctx: o.ctx, timeoutMs: o.timeoutMs ?? 30_000 });
    if (data.error) return { ...base, ok: false, kind: query.kind, error: data.error, summary: `refused: ${data.error.slice(0, 160)}` };
    const rows = data.rows.filter((x) => !x.other);
    const format = data.format;
    const computed = data.computed ? { computed: data.computed.slice(0, 400) } : {};
    if (query.kind === "value") {
      const value = rows[0]?.value ?? null;
      return { ...base, ok: true, kind: query.kind, format, value, ...computed, summary: figure(value, format) };
    }
    if (query.kind === "series") {
      const last = rows.slice(-TOP).map((x) => ({ group: x.series ? `${x.group} · ${x.series}` : x.group, value: x.value }));
      const value = last.at(-1)?.value ?? null;
      return { ...base, ok: true, kind: query.kind, format, value, rows: last, ...computed, summary: last.length ? `${figure(value, format)} in the latest bucket (${last.at(-1)!.group})` : "no rows" };
    }
    const top = rows.slice(0, TOP).map((x) => ({ group: x.group, value: x.value }));
    return { ...base, ok: true, kind: query.kind, format, rows: top, ...computed, summary: top.length ? `${figure(top[0]!.value, format)} for the top group (${top[0]!.group})` : "no rows" };
  } catch (e) {
    const error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    return { ...base, ok: false, error, summary: `could not run: ${error.slice(0, 160)}` };
  }
}

/** The figures side by side in one plain sentence, from the results alone. */
export function headline(results: ComparedReading[]): string {
  const ok = results.filter((r) => r.ok);
  if (ok.length < 2) return ok.length ? `Only "${ok[0]!.label}" could be run: ${ok[0]!.summary}.` : "None of the readings could be run.";
  const breakdowns = ok.filter((r) => r.kind === "breakdown" && r.rows?.length);
  if (breakdowns.length === ok.length) {
    const [a, ...rest] = breakdowns;
    const topA = a!.rows![0]!;
    const parts = rest.map((b) => {
      const same = b.rows!.find((x) => x.group === topA.group);
      const shared = b.rows!.slice(0, 5).filter((x) => a!.rows!.slice(0, 5).some((y) => y.group === x.group)).length;
      const onTop = same ? `${figure(same.value, b.format)} for ${topA.group}` : `${topA.group} is not in its top ${b.rows!.length}`;
      return `counting "${b.label}" gives ${onTop}, and its top group is ${b.rows![0]!.group} (${figure(b.rows![0]!.value, b.format)}); the two top fives share ${shared} of 5`;
    });
    return `Counting "${a!.label}" gives ${figure(topA.value, a!.format)} for the top group (${topA.group}); ${parts.join("; ")}. Which is appropriate?`;
  }
  const values = ok.map((r) => r.value).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const apart = values.length >= 2 && Math.min(...values.map(Math.abs)) > 0 ? ` The largest is ${(Math.max(...values.map(Math.abs)) / Math.min(...values.map(Math.abs))).toLocaleString("en", { maximumFractionDigits: 1 })}× the smallest.` : "";
  return `${ok.map((r) => `Counting "${r.label}" gives ${r.summary}`).join("; ")}.${apart} Which is appropriate?`;
}

/** Every reading of a question run, and the sentence that compares them. No model is called. */
export async function compareReadings(q: Pick<OpenQuestion, "readings">, o: { pack: Pack; connector: Connector; ctx?: Ctx; now?: () => Date; timeoutMs?: number }): Promise<Comparison> {
  const readings: ComparedReading[] = [];
  // One at a time: a source under load is not asked for six answers at once.
  for (const r of q.readings) readings.push(await runReading(r, o));
  return { at: (o.now ?? (() => new Date()))().toISOString(), readings, headline: headline(readings) };
}
