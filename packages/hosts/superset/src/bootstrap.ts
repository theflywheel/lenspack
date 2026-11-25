// Lenspack's own Superset account. On first start Lenspack signs in once as a Superset admin
// (SUPERSET_ADMIN_USERNAME / SUPERSET_ADMIN_PASSWORD) and asks lenspack_superset.py's bootstrap endpoint to
// create (or reset) its service user with a password it generates. The password is kept in the state
// directory (mode 600); from then on the admin credentials can be removed. A password given in the
// environment (LENSPACK_SUPERSET_PASSWORD) overrides all of this, for deployments that manage the
// account themselves.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type SupersetClient, supersetClient } from "./client";

export type ServiceAccount = { username: string; password: string; source: "env" | "state" | "bootstrap" };

export type BootstrapOptions = {
  url: string;
  username: string;
  stateDir: string;
  /** LENSPACK_SUPERSET_PASSWORD (or the config's password): use as is, never bootstrap. */
  password?: string;
  admin?: { username?: string; password?: string };
  log?: (s: string) => void;
  /** For tests. */
  client?: (o: { url: string; username: string; password: string }) => SupersetClient;
};

const FILE = "superset-account.json";

/** The account Lenspack signs in to Superset with, creating it if needed. */
export async function serviceAccount(o: BootstrapOptions): Promise<ServiceAccount> {
  const make = o.client ?? ((c) => supersetClient(c));
  const log = o.log ?? (() => {});
  if (o.password) return { username: o.username, password: o.password, source: "env" };

  const path = join(o.stateDir, FILE);
  if (existsSync(path)) {
    const saved = JSON.parse(readFileSync(path, "utf8")) as { username: string; password: string };
    if (saved.username === o.username) {
      try {
        // Signs in and makes one token-authenticated call that every version answers (Superset 5's /api/v1/me/
        // reads only the session cookie, so it answers 401 to a token whatever the password; 6.1's takes a token).
        await make({ url: o.url, username: saved.username, password: saved.password }).get("/api/v1/security/csrf_token/");
        return { ...saved, source: "state" };
      } catch (e) {
        // The account was deleted or its password changed (a new metadata database): make it again if we can.
        log(`the saved Superset account ${saved.username} no longer signs in (${e instanceof Error ? e.message : String(e)})`);
      }
    }
  }

  if (!o.admin?.password)
    throw new Error(
      `No Superset account for Lenspack: set SUPERSET_ADMIN_PASSWORD (and SUPERSET_ADMIN_USERNAME if the admin isn't "admin") for the first start, or LENSPACK_SUPERSET_PASSWORD for an account you manage`,
    );
  const admin = make({ url: o.url, username: o.admin.username || "admin", password: o.admin.password });
  const password = randomBytes(24).toString("base64url");
  await admin.post("/api/v1/lenspack/bootstrap", { username: o.username, password });
  writeFileSync(path, JSON.stringify({ username: o.username, password }), { mode: 0o600 });
  log(`created the Superset account ${o.username} (password kept in ${path}); SUPERSET_ADMIN_PASSWORD is no longer needed`);
  return { username: o.username, password, source: "bootstrap" };
}

/** The identity-signing key, from Superset (derived there from its SECRET_KEY). */
export async function identityKey(client: SupersetClient): Promise<string> {
  const r = await client.get<{ result: { key: string } }>("/api/v1/lenspack/identity-key");
  if (!r?.result?.key || r.result.key.length < 32) throw new Error("Superset returned no identity key: is lenspack_superset.py loaded?");
  return r.result.key;
}
