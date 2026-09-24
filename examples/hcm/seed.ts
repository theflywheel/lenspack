import type { Writer } from "@lenspack/sql";

import { type Dialect, execAll, insertRows, json, rng } from "../_shared/seed-util";

// A synthetic DIGIT HCM tenant with the REAL column names and types (from UAT
// metadata) and the real conventions: BIGINT epoch-millisecond audit times,
// isdeleted on every table, id + clientreferenceid, JSON in additionaldetails,
// cipher-format identifiers ("<keyId>|<base64>"), a dotted project hierarchy,
// one address row per task. No real data: every value is generated.

const ms = (d: Date) => d.getTime();
const cipher = (plain: string) => `316090|${Buffer.from([...plain].reverse().join("")).toString("base64")}`;
const STATUSES = [["ADMINISTRATION_SUCCESS", 72], ["ADMINISTRATION_FAILED", 6], ["BENEFICIARY_REFUSED", 9], ["CLOSED_HOUSEHOLD", 10], ["NOT_ADMINISTERED", 3]] as const;
const REASONS = ["BENEFICIARY_ABSENT", "STOCK_OUT", "REFUSED", "SICK", "INELIGIBLE"];
const SYMPTOMS = ["FEVER", "VOMITING", "RASH", "DIZZINESS", "SWELLING", "HEADACHE"];
const PRODUCTS = ["PVAR-SPAQ-3-11", "PVAR-SPAQ-12-59", "PVAR-BEDNET", "PVAR-VITA"];
const LOCALITIES = (n: number) => Array.from({ length: n }, (_, i) => `NG_ST_LGA${1 + Math.floor(i / 12)}_W${1 + Math.floor(i / 3)}_L${i + 1}`);

export async function seed(writer: Writer, dialect: Dialect, opts: { households?: number; now?: Date } = {}) {
  const r = rng(41);
  const now = opts.now ?? new Date("2026-09-01T00:00:00Z");
  const H = opts.households ?? 5000;
  const J = json(dialect);
  const TENANT = "ng.state";
  const campaignStart = new Date("2026-06-01T00:00:00Z");
  const span = ms(now) - ms(campaignStart);
  const audit = () => {
    const t = ms(campaignStart) + Math.floor(r.next() * span);
    return { createdby: `u${r.int(1, 40)}`, lastmodifiedby: `u${r.int(1, 40)}`, createdtime: t, lastmodifiedtime: t + r.int(0, 3600e3), rowversion: r.int(1, 3), isdeleted: r.chance(0.04), clientcreatedtime: t - r.int(0, 600e3), clientlastmodifiedtime: t, clientcreatedby: `c${r.int(1, 12)}`, clientlastmodifiedby: `c${r.int(1, 12)}` };
  };
  const details = () => (r.chance(0.6) ? JSON.stringify({ source: r.pick(["mobile", "web"]), version: r.int(1, 4), note: r.pick(["", "verified", "revisit"]) }) : null);

  await execAll(writer, [
    "DROP VIEW IF EXISTS v_project",
    ...["referral", "side_effect", "task_resource", "project_task", "project_beneficiary", "project_address", "project", "individual_identifier", "household_member", "individual", "household", "address"].map((t) => `DROP TABLE IF EXISTS ${t}`),
    `CREATE TABLE address (id VARCHAR PRIMARY KEY, tenantid VARCHAR, doorno VARCHAR, latitude DOUBLE PRECISION, longitude DOUBLE PRECISION, locationaccuracy INTEGER, type VARCHAR, addressline1 VARCHAR, addressline2 VARCHAR, landmark VARCHAR, city VARCHAR, pincode VARCHAR, buildingname VARCHAR, street VARCHAR, localitycode VARCHAR, clientreferenceid VARCHAR, wardcode VARCHAR)`,
    `CREATE TABLE household (id VARCHAR PRIMARY KEY, tenantid VARCHAR, clientreferenceid VARCHAR, numberofmembers INTEGER, addressid VARCHAR, additionaldetails ${J}, createdby VARCHAR, lastmodifiedby VARCHAR, createdtime BIGINT, lastmodifiedtime BIGINT, rowversion BIGINT, isdeleted BOOLEAN, clientcreatedtime BIGINT, clientlastmodifiedtime BIGINT, clientcreatedby VARCHAR, clientlastmodifiedby VARCHAR, householdtype VARCHAR)`,
    `CREATE TABLE individual (id VARCHAR PRIMARY KEY, userid VARCHAR, clientreferenceid VARCHAR, tenantid VARCHAR, givenname VARCHAR, familyname VARCHAR, othernames VARCHAR, dateofbirth DATE, gender VARCHAR, bloodgroup VARCHAR, mobilenumber VARCHAR, altcontactnumber VARCHAR, email VARCHAR, fathername VARCHAR, husbandname VARCHAR, photo VARCHAR, additionaldetails ${J}, createdby VARCHAR, lastmodifiedby VARCHAR, createdtime BIGINT, lastmodifiedtime BIGINT, rowversion BIGINT, isdeleted BOOLEAN, individualid VARCHAR, relationship VARCHAR, issystemuser BOOLEAN, username VARCHAR, type VARCHAR, roles ${J}, useruuid VARCHAR, issystemuseractive BOOLEAN, clientcreatedtime BIGINT, clientlastmodifiedtime BIGINT, clientcreatedby VARCHAR, clientlastmodifiedby VARCHAR)`,
    `CREATE TABLE household_member (id VARCHAR PRIMARY KEY, tenantid VARCHAR, individualid VARCHAR, individualclientreferenceid VARCHAR, householdid VARCHAR, householdclientreferenceid VARCHAR, isheadofhousehold BOOLEAN, additionaldetails ${J}, createdby VARCHAR, createdtime BIGINT, lastmodifiedby VARCHAR, lastmodifiedtime BIGINT, rowversion BIGINT, isdeleted BOOLEAN, clientcreatedtime BIGINT, clientlastmodifiedtime BIGINT, clientcreatedby VARCHAR, clientlastmodifiedby VARCHAR, clientreferenceid VARCHAR)`,
    `CREATE TABLE individual_identifier (individualid VARCHAR, identifiertype VARCHAR, identifierid VARCHAR, createdby VARCHAR, lastmodifiedby VARCHAR, createdtime BIGINT, lastmodifiedtime BIGINT, isdeleted BOOLEAN, id VARCHAR PRIMARY KEY, individualclientreferenceid VARCHAR, clientreferenceid VARCHAR)`,
    `CREATE TABLE project (id VARCHAR PRIMARY KEY, tenantid VARCHAR, name VARCHAR, projecthierarchy VARCHAR, startdate BIGINT, enddate BIGINT)`,
    `CREATE TABLE project_address (projectid VARCHAR, boundary VARCHAR)`,
    `CREATE TABLE project_beneficiary (id VARCHAR PRIMARY KEY, tenantid VARCHAR, projectid VARCHAR, beneficiaryid VARCHAR, clientreferenceid VARCHAR, beneficiaryclientreferenceid VARCHAR, createdby VARCHAR, lastmodifiedby VARCHAR, dateofregistration BIGINT, additionaldetails ${J}, createdtime BIGINT, lastmodifiedtime BIGINT, rowversion BIGINT, isdeleted BOOLEAN, clientcreatedtime BIGINT, clientlastmodifiedtime BIGINT, clientcreatedby VARCHAR, clientlastmodifiedby VARCHAR, tag VARCHAR)`,
    `CREATE TABLE project_task (id VARCHAR PRIMARY KEY, clientreferenceid VARCHAR, tenantid VARCHAR, projectid VARCHAR, projectbeneficiaryid VARCHAR, projectbeneficiaryclientreferenceid VARCHAR, plannedstartdate BIGINT, plannedenddate BIGINT, actualstartdate BIGINT, actualenddate BIGINT, addressid VARCHAR, status VARCHAR, additionaldetails ${J}, createdby VARCHAR, createdtime BIGINT, lastmodifiedby VARCHAR, lastmodifiedtime BIGINT, rowversion BIGINT, isdeleted BOOLEAN, clientcreatedtime BIGINT, clientlastmodifiedtime BIGINT, clientcreatedby VARCHAR, clientlastmodifiedby VARCHAR)`,
    `CREATE TABLE task_resource (id VARCHAR PRIMARY KEY, tenantid VARCHAR, productvariantid VARCHAR, taskid VARCHAR, quantity DOUBLE PRECISION, isdelivered BOOLEAN, reasonifnotdelivered VARCHAR, createdby VARCHAR, createdtime BIGINT, lastmodifiedby VARCHAR, lastmodifiedtime BIGINT, isdeleted BOOLEAN, clientreferenceid VARCHAR, additionaldetails ${J})`,
    `CREATE TABLE side_effect (id VARCHAR PRIMARY KEY, clientreferenceid VARCHAR, tenantid VARCHAR, taskid VARCHAR, taskclientreferenceid VARCHAR, projectbeneficiaryid VARCHAR, projectbeneficiaryclientreferenceid VARCHAR, symptoms ${J}, createdby VARCHAR, createdtime BIGINT, lastmodifiedby VARCHAR, lastmodifiedtime BIGINT, clientcreatedby VARCHAR, clientcreatedtime BIGINT, clientlastmodifiedby VARCHAR, clientlastmodifiedtime BIGINT, rowversion BIGINT, isdeleted BOOLEAN, additionaldetails ${J})`,
    `CREATE TABLE referral (id VARCHAR PRIMARY KEY, clientreferenceid VARCHAR, tenantid VARCHAR, projectbeneficiaryid VARCHAR, projectbeneficiaryclientreferenceid VARCHAR, referrerid VARCHAR, recipientid VARCHAR, recipienttype VARCHAR, reasons ${J}, sideeffectid VARCHAR, sideeffectclientreferenceid VARCHAR, createdby VARCHAR, createdtime BIGINT, lastmodifiedby VARCHAR, lastmodifiedtime BIGINT, clientcreatedby VARCHAR, clientcreatedtime BIGINT, clientlastmodifiedby VARCHAR, clientlastmodifiedtime BIGINT, rowversion BIGINT, isdeleted BOOLEAN, additionaldetails ${J}, referralcode VARCHAR, projectid VARCHAR)`,
  ]);

  // Geography: localities with a ward and an LGA baked into the code, as in prod.
  const locs = LOCALITIES(Math.max(12, Math.round(H / 60)));
  const addresses: unknown[][] = [];
  const addr = (ref: string, loc: string | null) => {
    const id = `ADR-${addresses.length + 1}`;
    addresses.push([id, TENANT, r.chance(0.3) ? String(r.int(1, 99)) : null, 4 + r.next() * 9, 3 + r.next() * 11, r.pick([null, 5, 12, 30]), "PERMANENT", r.pick([null, "Main St", "Market Rd"]), null, r.pick([null, "Mosque", "School"]), r.pick([null, "Yola", "Kano", "Ibadan"]), null, null, null, loc, ref, loc ? loc.split("_")[3] ?? null : null]);
    return id;
  };

  // Projects: 2 campaigns, each root -> 4 leaf projects mapped to a boundary.
  const projects: unknown[][] = [];
  const projectAddresses: unknown[][] = [];
  const leaves: { id: string; loc: string[] }[] = [];
  for (const [ci, camp] of ["SMC-2026-R1", "BEDNET-2026"].entries()) {
    const rootId = `PRJ-${camp}`;
    projects.push([rootId, TENANT, camp, rootId, ms(campaignStart) + ci * 20 * 86400e3, ms(now)]);
    for (let l = 1; l <= 4; l++) {
      const id = `${rootId}-L${l}`;
      const lgaLocs = locs.filter((x) => x.includes(`_LGA${l + ci * 4}_`) || x.includes(`_LGA${l}_`)).slice(0, 12);
      projects.push([id, TENANT, `${camp} LGA${l}`, `${rootId}.${id}`, ms(campaignStart) + ci * 20 * 86400e3, ms(now)]);
      projectAddresses.push([id, `NG_ST_LGA${l}`]);
      leaves.push({ id, loc: lgaLocs.length ? lgaLocs : locs.slice(0, 6) });
    }
  }

  const households: unknown[][] = [];
  const individuals: unknown[][] = [];
  const members: unknown[][] = [];
  const identifiers: unknown[][] = [];
  const beneficiaries: unknown[][] = [];
  const tasks: unknown[][] = [];
  const resources: unknown[][] = [];
  const sideEffects: unknown[][] = [];
  const referrals: unknown[][] = [];
  let ind = 0, mem = 0, idn = 0, ben = 0, tsk = 0, res = 0, se = 0, ref = 0;

  for (let h = 1; h <= H; h++) {
    const loc = r.pick(locs);
    const hid = `HH-${h}`;
    const size = r.weighted([[1, 5], [2, 10], [3, 14], [4, 16], [5, 14], [6, 12], [7, 8], [8, 5], [10, 3], [13, 1]]);
    const a = audit();
    households.push([hid, TENANT, `hhc-${h}`, size, r.chance(0.02) ? null : addr(`adc-H${h}`, loc), details(), a.createdby, a.lastmodifiedby, a.createdtime, a.lastmodifiedtime, a.rowversion, a.isdeleted, a.clientcreatedtime, a.clientlastmodifiedtime, a.clientcreatedby, a.clientlastmodifiedby, r.pick(["FAMILY", "FAMILY", "COMMUNITY", null])]);
    for (let m = 0; m < size; m++) {
      let iid: string;
      if (ind > 0 && r.chance(0.03)) iid = `IND-${r.int(1, ind)}`; // an individual shared across households
      else {
        iid = `IND-${++ind}`;
        const ia = audit();
        const age = r.weighted([[r.int(0, 4), 18], [r.int(5, 14), 27], [r.int(15, 49), 40], [r.int(50, 85), 15]]);
        const dob = new Date(ms(now) - age * 365.25 * 86400e3 - r.int(0, 364) * 86400e3).toISOString().slice(0, 10);
        individuals.push([iid, null, `indc-${ind}`, TENANT, r.pick(["Amina", "Chinedu", "Fátima", "Ibrahim", "Ngozi", "Musa", "Zainab", "Emeka"]), r.pick(["Bello", "Okafor", "Abubakar", "Adeyemi", "Eze", "Yusuf"]), null, dob, r.pick(["MALE", "FEMALE", "FEMALE", null]), null, r.chance(0.28) ? cipher(`0803${String(ind).padStart(8, "0")}`) : null, null, null, null, null, null, details(), ia.createdby, ia.lastmodifiedby, ia.createdtime, ia.lastmodifiedtime, ia.rowversion, ia.isdeleted, `UIN-${ind}`, r.pick(["SELF", "CHILD", "SPOUSE", null]), false, null, null, null, null, null, ia.clientcreatedtime, ia.clientlastmodifiedtime, ia.clientcreatedby, ia.clientlastmodifiedby]);
        if (r.chance(0.9)) identifiers.push([iid, r.pick(["NATIONAL_ID", "UNIQUE_BENEFICIARY_ID", "DEFAULT"]), cipher(`ID-${String(ind).padStart(9, "0")}`), "u1", "u1", ia.createdtime, ia.lastmodifiedtime, r.chance(0.05), `IDN-${++idn}`, `indc-${ind}`, `idc-${idn}`]);
      }
      const ma = audit();
      members.push([`HM-${++mem}`, TENANT, iid, `indc-${iid.slice(4)}`, hid, `hhc-${h}`, m === 0, details(), ma.createdby, ma.createdtime, ma.lastmodifiedby, ma.lastmodifiedtime, ma.rowversion, ma.isdeleted, ma.clientcreatedtime, ma.clientlastmodifiedtime, ma.clientcreatedby, ma.clientlastmodifiedby, `hmc-${mem}`]);
    }
    // Enrolment: a household joins each campaign whose leaf covers its locality, with ~70% probability.
    for (const leaf of leaves) {
      if (!leaf.loc.includes(loc) || !r.chance(0.7)) continue;
      const bid = `PB-${++ben}`;
      const ba = audit();
      beneficiaries.push([bid, TENANT, leaf.id, hid, `pbc-${ben}`, `hhc-${h}`, ba.createdby, ba.lastmodifiedby, ba.createdtime, details(), ba.createdtime, ba.lastmodifiedtime, ba.rowversion, ba.isdeleted, ba.clientcreatedtime, ba.clientlastmodifiedtime, ba.clientcreatedby, ba.clientlastmodifiedby, r.pick([null, "TAG-A"])]);
      // Visits: usually 1, sometimes a revisit; each with its own address row and product lines.
      const visits = r.weighted([[0, 12], [1, 60], [2, 22], [3, 6]]);
      for (let v = 0; v < visits; v++) {
        const tid = `TSK-${++tsk}`;
        const ta = audit();
        const status = r.weighted(STATUSES);
        const planned = ta.createdtime - r.int(0, 3) * 86400e3;
        const started = r.chance(0.92) ? planned + r.int(-3600e3, 5 * 86400e3) : null;
        const ended = started !== null && r.chance(0.95) ? started + r.int(3, 40) * 60e3 * (status === "CLOSED_HOUSEHOLD" ? 0.3 : 1) : null;
        tasks.push([tid, `tc-${tsk}`, TENANT, leaf.id, bid, `pbc-${ben}`, planned, planned + 86400e3, started, ended, addr(`adc-T${tsk}`, r.chance(0.98) ? loc : null), status, details(), ta.createdby, ta.createdtime, ta.lastmodifiedby, ta.lastmodifiedtime, ta.rowversion, ta.isdeleted, ta.clientcreatedtime, ta.clientlastmodifiedtime, ta.clientcreatedby, ta.clientlastmodifiedby]);
        const lines = status === "ADMINISTRATION_SUCCESS" ? r.int(1, 3) : r.int(0, 1);
        for (let l = 0; l < lines; l++) {
          const delivered = status === "ADMINISTRATION_SUCCESS" ? r.chance(0.96) : r.chance(0.15);
          resources.push([`TR-${++res}`, TENANT, r.pick(PRODUCTS), tid, delivered ? r.int(1, 3) : 0, delivered, delivered ? null : r.pick(REASONS), ta.createdby, ta.createdtime, ta.lastmodifiedby, ta.lastmodifiedtime, r.chance(0.03), `trc-${res}`, details()]);
        }
        if (status === "ADMINISTRATION_SUCCESS" && r.chance(0.04)) {
          const sa = audit();
          sideEffects.push([`SE-${++se}`, `sec-${se}`, TENANT, tid, `tc-${tsk}`, bid, `pbc-${ben}`, JSON.stringify([r.pick(SYMPTOMS), ...(r.chance(0.3) ? [r.pick(SYMPTOMS)] : [])]), sa.createdby, ta.createdtime + r.int(1, 48) * 3600e3, sa.lastmodifiedby, sa.lastmodifiedtime, sa.clientcreatedby, sa.clientcreatedtime, sa.clientlastmodifiedby, sa.clientlastmodifiedtime, sa.rowversion, sa.isdeleted, details()]);
          if (r.chance(0.5)) {
            const ra = audit();
            referrals.push([`REF-${++ref}`, `refc-${ref}`, TENANT, bid, `pbc-${ben}`, `u${r.int(1, 40)}`, `FAC-${r.int(1, 30)}`, r.pick(["FACILITY", "COMMUNITY_HEALTH_WORKER", "HOSPITAL"]), JSON.stringify([r.pick(["SIDE_EFFECT", "SICK_CHILD", "NO_STOCK"])]), `SE-${se}`, `sec-${se}`, ra.createdby, ta.createdtime + r.int(2, 72) * 3600e3, ra.lastmodifiedby, ra.lastmodifiedtime, ra.clientcreatedby, ra.clientcreatedtime, ra.clientlastmodifiedby, ra.clientlastmodifiedtime, ra.rowversion, ra.isdeleted, details(), `RC-${ref}`, leaf.id]);
          }
        }
      }
    }
  }

  await insertRows(writer, "address", ["id", "tenantid", "doorno", "latitude", "longitude", "locationaccuracy", "type", "addressline1", "addressline2", "landmark", "city", "pincode", "buildingname", "street", "localitycode", "clientreferenceid", "wardcode"], addresses);
  await insertRows(writer, "household", ["id", "tenantid", "clientreferenceid", "numberofmembers", "addressid", "additionaldetails", "createdby", "lastmodifiedby", "createdtime", "lastmodifiedtime", "rowversion", "isdeleted", "clientcreatedtime", "clientlastmodifiedtime", "clientcreatedby", "clientlastmodifiedby", "householdtype"], households);
  await insertRows(writer, "individual", ["id", "userid", "clientreferenceid", "tenantid", "givenname", "familyname", "othernames", "dateofbirth", "gender", "bloodgroup", "mobilenumber", "altcontactnumber", "email", "fathername", "husbandname", "photo", "additionaldetails", "createdby", "lastmodifiedby", "createdtime", "lastmodifiedtime", "rowversion", "isdeleted", "individualid", "relationship", "issystemuser", "username", "type", "roles", "useruuid", "issystemuseractive", "clientcreatedtime", "clientlastmodifiedtime", "clientcreatedby", "clientlastmodifiedby"], individuals);
  await insertRows(writer, "household_member", ["id", "tenantid", "individualid", "individualclientreferenceid", "householdid", "householdclientreferenceid", "isheadofhousehold", "additionaldetails", "createdby", "createdtime", "lastmodifiedby", "lastmodifiedtime", "rowversion", "isdeleted", "clientcreatedtime", "clientlastmodifiedtime", "clientcreatedby", "clientlastmodifiedby", "clientreferenceid"], members);
  await insertRows(writer, "individual_identifier", ["individualid", "identifiertype", "identifierid", "createdby", "lastmodifiedby", "createdtime", "lastmodifiedtime", "isdeleted", "id", "individualclientreferenceid", "clientreferenceid"], identifiers);
  await insertRows(writer, "project", ["id", "tenantid", "name", "projecthierarchy", "startdate", "enddate"], projects);
  await insertRows(writer, "project_address", ["projectid", "boundary"], projectAddresses);
  await insertRows(writer, "project_beneficiary", ["id", "tenantid", "projectid", "beneficiaryid", "clientreferenceid", "beneficiaryclientreferenceid", "createdby", "lastmodifiedby", "dateofregistration", "additionaldetails", "createdtime", "lastmodifiedtime", "rowversion", "isdeleted", "clientcreatedtime", "clientlastmodifiedtime", "clientcreatedby", "clientlastmodifiedby", "tag"], beneficiaries);
  await insertRows(writer, "project_task", ["id", "clientreferenceid", "tenantid", "projectid", "projectbeneficiaryid", "projectbeneficiaryclientreferenceid", "plannedstartdate", "plannedenddate", "actualstartdate", "actualenddate", "addressid", "status", "additionaldetails", "createdby", "createdtime", "lastmodifiedby", "lastmodifiedtime", "rowversion", "isdeleted", "clientcreatedtime", "clientlastmodifiedtime", "clientcreatedby", "clientlastmodifiedby"], tasks);
  await insertRows(writer, "task_resource", ["id", "tenantid", "productvariantid", "taskid", "quantity", "isdelivered", "reasonifnotdelivered", "createdby", "createdtime", "lastmodifiedby", "lastmodifiedtime", "isdeleted", "clientreferenceid", "additionaldetails"], resources);
  await insertRows(writer, "side_effect", ["id", "clientreferenceid", "tenantid", "taskid", "taskclientreferenceid", "projectbeneficiaryid", "projectbeneficiaryclientreferenceid", "symptoms", "createdby", "createdtime", "lastmodifiedby", "lastmodifiedtime", "clientcreatedby", "clientcreatedtime", "clientlastmodifiedby", "clientlastmodifiedtime", "rowversion", "isdeleted", "additionaldetails"], sideEffects);
  await insertRows(writer, "referral", ["id", "clientreferenceid", "tenantid", "projectbeneficiaryid", "projectbeneficiaryclientreferenceid", "referrerid", "recipientid", "recipienttype", "reasons", "sideeffectid", "sideeffectclientreferenceid", "createdby", "createdtime", "lastmodifiedby", "lastmodifiedtime", "clientcreatedby", "clientcreatedtime", "clientlastmodifiedby", "clientlastmodifiedtime", "rowversion", "isdeleted", "additionaldetails", "referralcode", "projectid"], referrals);

  // The project view: the dotted hierarchy resolved to root and name, boundary joined in.
  await execAll(writer, [
    `CREATE VIEW v_project AS
       SELECT p.id, p.tenantid, p.name, split_part(p.projecthierarchy, '.', 1) AS root, p.projecthierarchy, pa.boundary
       FROM project p LEFT JOIN project_address pa ON pa.projectid = p.id`,
  ]);
}
