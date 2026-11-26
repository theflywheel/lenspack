import type { Audit, AuditEvent } from "../audit";
import type { Features } from "../features";
import type { Provider } from "../llm";
import type { Budget, UsageLedger } from "../metering";
import type { SettingsStore } from "../settings";
import { panelRoutes } from "./panel";
import type { DocStore } from "./store";
import { type ReviewHost, reviewSystem } from "./system";
import { usageBoard } from "./usage";

export type ReviewMountOptions = {
  stateDir: string;
  hosts: ReviewHost[];
  /** The audit events at or after a time: what the review and the usage board read. */
  events?: (from: Date) => AuditEvent[];
  audit?: Audit;
  /** The host's admin prefix (/_superset, /_lenspack): the panel is at <prefix>/admin/. */
  prefix: string;
  /** In the host's words, for a refusal: "Superset admin". */
  adminName: string;
  title?: string;
  log: (line: string) => void;
  /** Where the review's documents are kept; the state directory's files by default. */
  docs?: DocStore;
};

/**
 * The review system and its admin panel, wired the same way for every host: the host passes its packs and
 * its audit log, gives the chat `turn` (AppOptions.definitions), mounts `routes(...)` once the runtime has
 * its models, and calls `start()` when it is listening.
 */
export function reviewMount(admin: { features: Features; settings: SettingsStore; app: { review: () => boolean; chatDefault: () => { model?: string; effort?: string } | undefined } }, o: ReviewMountOptions) {
  let models: Provider[] = [];
  const system = reviewSystem({ stateDir: o.stateDir, docs: o.docs, hosts: o.hosts, features: admin.features, settings: admin.settings, providers: () => models, events: o.events, audit: o.audit, log: o.log });
  return {
    system,
    turn: system.turn,
    start: () => system.start(),
    routes(rt: { providers: Provider[]; budget?: Budget; ledger?: UsageLedger; roles?: { reviewer?: string; escalate?: string } }) {
      models = rt.providers;
      // Usage as a board of its own (the panel's Overview), over the turn telemetry when it is written, the audit log otherwise.
      const usage = usageBoard({ stateDir: o.stateDir, events: o.events, providers: () => rt.providers, ledger: rt.ledger, budget: rt.budget, roles: rt.roles, audit: o.audit, review: admin.app.review, chatDefault: admin.app.chatDefault, log: o.log }).catch((e) => {
        o.log(`usage board off: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      });
      return panelRoutes({ prefix: o.prefix, system, features: admin.features, providers: () => rt.providers, adminName: o.adminName, title: o.title, log: o.log, usage });
    },
  };
}
