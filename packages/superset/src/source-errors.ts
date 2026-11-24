// What the model hears when a Superset query fails: Superset passes on the database driver's own
// message, which the engine's sourceMessage scrubs of addresses or turns into "unreachable" and a
// reason. Superset itself out of reach, or answering 502-504, is a reason of its own.

import { sourceMessage, unreachableReason } from "@lenspack/engine";

import { SupersetError } from "./client";

/** The error to hand on in place of `e`; `log` gets the raw message when it differs. */
export function sourceError(e: unknown, log?: (line: string) => void): Error {
  const raw = e instanceof Error ? e.message : String(e);
  const status = e instanceof SupersetError ? e.status : undefined;
  // fetch() itself failing means Superset is the one out of reach.
  const fetchFailed = e instanceof TypeError && /fetch failed/i.test(raw);
  const cause = fetchFailed ? String((e as { cause?: { code?: string; message?: string } }).cause?.code ?? (e as { cause?: { message?: string } }).cause?.message ?? "") : "";
  const gateway = status === 502 || status === 503 || status === 504 ? "Superset is unavailable" : null;
  const reason = fetchFailed ? `Superset is unreachable${unreachableReason(cause) ? `: ${unreachableReason(cause)}` : ""}` : (unreachableReason(raw) ?? gateway);
  const said = sourceMessage(raw, reason);
  if (said !== raw) log?.(`query failed: ${raw.slice(0, 1000)}`);
  const out = new Error(said);
  if (e instanceof SupersetError) Object.assign(out, { status: e.status });
  return out;
}
