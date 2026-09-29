import type { Writer } from "@lenspack/sql";

import { type Dialect, execAll, insertRows, rng } from "../_shared/seed-util";

// A synthetic distribution campaign shaped like DIGIT's DSS indexes: one
// document per delivery in `project-task-index-v1`, one per project (with its
// household target) in `project-index-v1`, every field under `Data.` with the
// same names and types. No real data: every value is generated.
//
// The same documents seed a search index and SQL tables whose columns are the
// literal field paths ("Data.district"), so one pack answers on both and the
// two can be checked against each other number for number.

export const TASK_INDEX = "project-task-index-v1";
export const PROJECT_INDEX = "project-index-v1";

type Doc = { Data: Record<string, string | number | boolean | null> };

const PROVINCES = { Northern: ["Kawambwa", "Mansa", "Samfya"], Eastern: ["Chipata", "Lundazi", "Petauke", "Katete"], Western: ["Mongu", "Senanga"] } as const;
const VARIANTS = [["PVAR-NET-SINGLE", 70], ["PVAR-NET-DOUBLE", 30]] as const;
const REASONS = [["BENEFICIARY_ABSENT", 40], ["REFUSED", 25], ["STOCK_OUT", 20], ["HOUSE_LOCKED", 15]] as const;

export function documents(opts: { households?: number; now?: Date } = {}) {
  const r = rng(7);
  const now = opts.now ?? new Date("2026-09-01T00:00:00Z");
  const start = new Date("2026-07-01T00:00:00Z").getTime();
  const span = now.getTime() - start;
  const H = opts.households ?? 4000;
  const districts = Object.entries(PROVINCES).flatMap(([province, ds]) => ds.map((district) => ({ province, district })));

  const projects: Doc[] = districts.map(({ province, district }, i) => ({
    Data: {
      projectId: `P-${i + 1}`,
      province,
      district,
      targetType: "HOUSEHOLD",
      overallTarget: 250 + r.int(0, 300),
      targetPerDay: 20 + r.int(0, 20),
      startDate: start,
      endDate: now.getTime(),
    },
  }));
  // One project targets individuals too, so the household filter matters.
  projects.push({ Data: { ...projects[0]!.Data, projectId: "P-IND", targetType: "INDIVIDUAL", overallTarget: 5000 } });

  const tasks: Doc[] = [];
  for (let h = 0; h < H; h++) {
    const where = districts[Math.min(districts.length - 1, Math.floor(Math.pow(r.next(), 1.3) * districts.length))]!;
    const project = projects.find((p) => p.Data.district === where.district)!;
    const household = r.chance(0.85);
    const delivered = r.chance(0.88);
    const quantity = delivered ? r.int(1, 3) : 0;
    const locality = `${where.district.slice(0, 3).toUpperCase()}-L${r.int(1, 6)}`;
    tasks.push({
      Data: {
        id: `T-${h + 1}`,
        projectId: project.Data.projectId as string,
        province: where.province,
        administrativeProvince: where.province,
        district: where.district,
        locality,
        village: `${locality}-V${r.int(1, 4)}`,
        productVariant: r.weighted(VARIANTS),
        deliveredTo: household ? "HOUSEHOLD" : "INDIVIDUAL",
        quantity,
        // DSS convention: an empty comment on a delivery, a reason otherwise.
        deliveryComments: delivered ? "" : r.weighted(REASONS),
        isDelivered: delivered,
        userId: `U-${r.int(1, 60)}`,
        createdTime: start + Math.floor(r.next() * span),
      },
    });
  }
  return { tasks, projects };
}

const FIELD_TYPES: Record<string, "keyword" | "long" | "boolean"> = {
  id: "keyword", projectId: "keyword", province: "keyword", administrativeProvince: "keyword", district: "keyword", locality: "keyword",
  village: "keyword", productVariant: "keyword", deliveredTo: "keyword", quantity: "long", deliveryComments: "keyword", isDelivered: "boolean",
  userId: "keyword", createdTime: "long", targetType: "keyword", overallTarget: "long", targetPerDay: "long", startDate: "long", endDate: "long",
};
const SQL_TYPE = { keyword: "VARCHAR", long: "BIGINT", boolean: "BOOLEAN" } as const;

const columnsOf = (docs: Doc[]) => Object.keys(docs[0]!.Data);

/** SQL tables named like the indexes, one column per field path. */
export async function seed(writer: Writer, _dialect: Dialect, opts: { households?: number; now?: Date } = {}) {
  const { tasks, projects } = documents(opts);
  const q = (s: string) => `"${s}"`;
  for (const [table, docs] of [[TASK_INDEX, tasks], [PROJECT_INDEX, projects]] as const) {
    const cols = columnsOf(docs);
    await execAll(writer, [`DROP TABLE IF EXISTS ${q(table)}`, `CREATE TABLE ${q(table)} (${cols.map((c) => `${q(`Data.${c}`)} ${SQL_TYPE[FIELD_TYPES[c]!]}`).join(", ")})`]);
    await insertRows(writer, q(table), cols.map((c) => q(`Data.${c}`)), docs.map((d) => cols.map((c) => d.Data[c] ?? null)));
  }
}

type Request = (method: string, path: string, body?: unknown) => Promise<any>;

/**
 * The same documents into a search index. Strings are mapped the way DIGIT's
 * dynamic mapping leaves them — text with a keyword sub-field — so the
 * connector's text→keyword resolution is exercised, not assumed.
 */
export async function seedSearch(request: Request, opts: { households?: number; now?: Date } = {}) {
  const { tasks, projects } = documents(opts);
  for (const [index, docs] of [[TASK_INDEX, tasks], [PROJECT_INDEX, projects]] as const) {
    await request("DELETE", `/${index}`).catch(() => undefined);
    const properties = Object.fromEntries(
      columnsOf(docs).map((c) => [c, FIELD_TYPES[c] === "keyword" ? { type: "text", fields: { keyword: { type: "keyword", ignore_above: 256 } } } : { type: FIELD_TYPES[c] }]),
    );
    await request("PUT", `/${index}`, { settings: { number_of_shards: 1, number_of_replicas: 0 }, mappings: { properties: { Data: { properties } } } });
    for (let i = 0; i < docs.length; i += 2000) {
      const lines = docs.slice(i, i + 2000).flatMap((d, j) => [JSON.stringify({ index: { _id: String(i + j + 1) } }), JSON.stringify(d)]);
      const res = await request("POST", `/${index}/_bulk`, lines.join("\n") + "\n");
      if (res?.errors) throw new Error(`bulk into ${index} reported errors`);
    }
    await request("POST", `/${index}/_refresh`);
  }
}
