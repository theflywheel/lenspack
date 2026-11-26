// Data export: who may pull a deployment's records out, and which of them. Pure, like the rest of policy: the host says
// who the caller is (it checked an export token against the deployment's secrets) and what the deployment keeps; this
// decides. An export token is not a sign-in: it opens these streams and nothing else, and it is separate from any
// host's admin rights.

/** The streams a deployment can export, read-only. */
export const EXPORT_STREAMS = ["turns", "feedback", "events", "transcripts", "recordings", "audit", "cost"] as const;
export type ExportStream = (typeof EXPORT_STREAMS)[number];
export const isExportStream = (s: string): s is ExportStream => (EXPORT_STREAMS as readonly string[]).includes(s);

/** What one export token may do: which streams, and whether user names come out as written. */
export type ExportGrant = {
  /** The token's name, never the token: who the audit log says exported. */
  name: string;
  streams: readonly ExportStream[];
  /** User names as written. Without it every user name is a stable stand-in, so rows still join across streams. */
  usernames: boolean;
};

/** Whether the deployment keeps a stream now, and if not, why (in words for the caller). */
export type StreamState = { kept: true } | { kept: false; why: string };
export type StreamStates = Record<ExportStream, StreamState>;

export type ExportDecision =
  | { ok: true; stream: ExportStream; usernames: boolean; actor: string }
  | { ok: false; status: 403 | 404; code: "unknown-stream" | "not-granted" | "not-kept"; error: string };

/** The audit log's name for an exporter: "export:<token name>", so an export is never mistaken for a person. */
export const exportActor = (grant: Pick<ExportGrant, "name">) => `export:${grant.name}`;

/**
 * May this grant read this stream now? A stream the token was not given is refused (403); a stream the deployment does
 * not keep (its telemetry item is off, there is no audit log) answers 404 with the reason, so a token cannot learn
 * from the export what the switches would have hidden.
 */
export function exportDecision(grant: ExportGrant, stream: string, states: StreamStates): ExportDecision {
  if (!isExportStream(stream)) return { ok: false, status: 404, code: "unknown-stream", error: `no stream "${stream}" (one of ${EXPORT_STREAMS.join(", ")})` };
  if (!grant.streams.includes(stream)) return { ok: false, status: 403, code: "not-granted", error: `the token ${grant.name} may not export ${stream}` };
  const state = states[stream];
  if (!state.kept) return { ok: false, status: 404, code: "not-kept", error: `${stream} are not kept on this deployment: ${state.why}` };
  return { ok: true, stream, usernames: grant.usernames, actor: exportActor(grant) };
}

/** What a grant may read, stream by stream, for the export's index route. */
export function exportIndex(grant: ExportGrant, states: StreamStates) {
  return {
    token: grant.name,
    usernames: grant.usernames,
    streams: grant.streams.filter((s) => states[s].kept),
    off: Object.fromEntries(grant.streams.filter((s) => !states[s].kept).map((s) => [s, (states[s] as { why: string }).why])),
  };
}
