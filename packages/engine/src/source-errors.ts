// What the model (and so the person asking) hears when a source fails. A database driver's own
// message names hosts, ports and URLs inside the deployment. When the source can't be reached the
// model gets "unreachable" and a reason it can act on; any other failure keeps its wording with
// addresses taken out. Each Source keeps the raw message for its own log.

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
export function unreachableReason(message: string): string | null {
  for (const [re, reason] of REASONS) if (re.test(message)) return reason;
  return null;
}

/** What to say for a failed query: a timeout or an unreachable source by its reason, anything else scrubbed of addresses. */
export function sourceMessage(raw: string, reason: string | null = unreachableReason(raw)): string {
  if (reason === "timed out") return "The data source did not answer in time (timed out). A narrower question may work, or try again shortly.";
  if (reason) return `The data source is unreachable (${reason}). The data could not be read; try again shortly.`;
  return scrubAddresses(raw);
}
