import { chmodSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { fileAudit } from "../src/audit";
import { jsonlUsageSink } from "../src/metering";

// Files that name people are readable by the server's own user only.
const mode = (p: string) => statSync(p).mode & 0o777;

describe("files that name people are private", () => {
  it.skipIf(process.platform === "win32")("the usage file is created 600, and an existing one is made 600", () => {
    const dir = mkdtempSync(join(tmpdir(), "lp-usage-"));
    const fresh = join(dir, "usage.jsonl");
    jsonlUsageSink(fresh).record({ at: "2026-01-01T00:00:00Z", user: "ana" } as never);
    expect(mode(fresh)).toBe(0o600);
    const old = join(dir, "old.jsonl");
    writeFileSync(old, "");
    chmodSync(old, 0o644);
    jsonlUsageSink(old);
    expect(mode(old)).toBe(0o600);
  });

  it.skipIf(process.platform === "win32")("a single-file audit log is created 600, and an existing one is made 600", () => {
    const dir = mkdtempSync(join(tmpdir(), "lp-audit-"));
    const fresh = join(dir, "audit.jsonl");
    fileAudit(fresh)({ at: "2026-01-01T00:00:00Z", user: "ana", action: "chat", outcome: "ok" });
    expect(mode(fresh)).toBe(0o600);
    const old = join(dir, "old.jsonl");
    writeFileSync(old, "");
    chmodSync(old, 0o644);
    fileAudit(old);
    expect(mode(old)).toBe(0o600);
  });
});
