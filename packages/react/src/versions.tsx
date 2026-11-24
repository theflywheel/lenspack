import * as React from "react";

import { useBoard } from "./provider";
import type { BoardVersion } from "./types";

// The history is the whole point of storing a board as data. Clicking a
// version shows it read-only (the provider's preview); restoring appends it
// as a new version rather than rewinding, so a restore can itself be undone.

/** Who made a version, and when: "by chat · 24/11/2026, 10:14:58". */
export const versionByline = (v: BoardVersion) =>
  `${v.source === "chat" ? "by chat" : v.source === "revert" ? "rollback" : v.source === "layout" ? "by hand" : v.source} · ${v.createdAt.toLocaleString()}`;

/**
 * The board's history without the markup: its versions, newest first, loaded
 * while `open`; which one is the latest; and `restore`, absent when the host
 * cannot restore (a read-only board), with `busy` the version being restored.
 * `<VersionHistory>` draws it plainly; a host with its own design system draws
 * it with that.
 */
export function useVersions(open: boolean) {
  const { board, host, revert } = useBoard();
  const [versions, setVersions] = React.useState<BoardVersion[]>([]);
  const [busy, setBusy] = React.useState<number | null>(null);

  React.useEffect(() => {
    if (open && host.loadVersions) void host.loadVersions().then(setVersions);
  }, [open, host, board.version]);

  const restore = async (version: number) => {
    if (busy !== null) return;
    setBusy(version);
    try {
      await revert(version);
    } finally {
      setBusy(null);
    }
  };
  return { available: !!host.loadVersions, versions, latest: versions[0]?.version, busy, restore: host.revertTo ? restore : undefined };
}

export function VersionHistory() {
  const { board, previewing, preview } = useBoard();
  const [open, setOpen] = React.useState(false);
  const { available, versions, latest, busy, restore } = useVersions(open);
  if (!available) return null;

  return (
    <div className="lp-history">
      <button type="button" className="lp-button" onClick={() => setOpen(!open)} data-testid="history-toggle">
        History{versions.length ? ` (${versions.length})` : ""}
        {previewing && ` · viewing v${previewing.version}`}
      </button>
      {open && (
        <div className="lp-history-panel" data-testid="version-history">
          {versions.map((v) => (
            <div key={v.version} className="lp-history-row" aria-current={v.version === board.version ? "true" : undefined}>
              <button type="button" className="lp-history-text" data-testid={`version-${v.version}`} onClick={() => preview(v.version === latest ? null : v)}>
                <p>
                  <b>v{v.version}</b> {v.summary || "no change recorded"}
                  {v.version === latest && <span className="lp-muted"> (current)</span>}
                </p>
                <p className="lp-muted">{versionByline(v)}</p>
              </button>
              {v.version !== latest && restore && (
                <button type="button" className="lp-link" disabled={busy !== null} onClick={() => void restore(v.version).then(() => setOpen(false))} data-testid={`restore-${v.version}`}>
                  {busy === v.version ? "…" : "restore"}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
