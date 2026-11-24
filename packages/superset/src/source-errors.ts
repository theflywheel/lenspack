// What the model (and so the person asking) hears when a query fails. Superset passes on the database
// driver's own message, which names hosts, ports and URLs inside the deployment. When the data source
// can't be reached the model gets "unreachable" and a reason it can act on; any other failure keeps its
// wording with addresses taken out. The server log keeps the raw message.

import { SupersetError } from "./client";

const REASONS: [RegExp, string][] = [
  [/connection refused|ECONNREFUSED|errno 111\b/i, "connection refused"],
  [/name or service not known|getaddrinfo|ENOTFOUND|EAI_AGAIN|temporary failure in name resolution|nodename nor servname|could not resolve host|errno -[23]\b/i, "host not found"],
  [/timed out|timeout|ETIMEDOUT|deadline exceeded/i, "timed out"],
  [/ECONNRESET|connection reset|broken pipe|connection aborted|remote end closed|server closed the connection/i, "connection dropped"],
  [/max retries exceeded|failed to establish a new connection|NewConnectionError|network is unreachable|no route to host|EHOSTUNREACH|ENETUNREACH/i, "no connection"],
  [/authentication failed|password authentication failed|invalid credentials|AUTHENTICATION_FAILED/i, "sign-in refused"],
];

/** Takes out URLs, host:port pairs, IP addresses and quoted host= values. */
export function scrubAddresses(text: string): string {
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'")]+/gi, "[address]")
    .replace(/\bhost\s*=\s*['"]?[^\s'",)]+['"]?/gi, "host=[address]")
    .replace(/\bport\s*=\s*\d+/gi, "port=[port]")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "[address]")
    .replace(/\[[0-9a-f:]{3,}\](?::\d+)?/gi, "[address]")
    // host:port, where the host has a letter in it (so a time like 10:05 stays).
    .replace(/\b(?=[a-z0-9.-]*[a-z])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?:\d{2,5}\b/gi, "[address]");
}

/** The reason class of a connection failure, or null when the error is something else (a bad query, a refusal). */
export function unreachableReason(message: string, status?: number): string | null {
  for (const [re, reason] of REASONS) if (re.test(message)) return reason;
  if (status === 502 || status === 503 || status === 504) return "Superset is unavailable";
  return null;
}

/** The error to hand on in place of `e`; `log` gets the raw message when it differs. */
export function sourceError(e: unknown, log?: (line: string) => void): Error {
  const raw = e instanceof Error ? e.message : String(e);
  const status = e instanceof SupersetError ? e.status : undefined;
  // fetch() itself failing means Superset is the one out of reach.
  const fetchFailed = e instanceof TypeError && /fetch failed/i.test(raw);
  const cause = fetchFailed ? String((e as { cause?: { code?: string; message?: string } }).cause?.code ?? (e as { cause?: { message?: string } }).cause?.message ?? "") : "";
  const reason = fetchFailed ? `Superset is unreachable${unreachableReason(cause) ? `: ${unreachableReason(cause)}` : ""}` : unreachableReason(raw, status);
  const said =
    reason === "timed out"
      ? "The data source did not answer in time (timed out). A narrower question may work, or try again shortly."
      : reason
        ? `The data source is unreachable (${reason}). The data could not be read; try again shortly.`
        : scrubAddresses(raw);
  if (said !== raw) log?.(`query failed: ${raw.slice(0, 1000)}`);
  const out = new Error(said);
  if (e instanceof SupersetError) Object.assign(out, { status: e.status });
  return out;
}
