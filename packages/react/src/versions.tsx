import * as React from "react";

import { useBoard } from "./provider";
import type { BoardVersion } from "./types";

// The history is the whole point of storing a board as data. Rolling back
// appends rather than rewinds, so a rollback can itself be undone.
export function VersionHistory() {
  const { board, host, refresh } = useBoard();
  const [open, setOpen] = React.useState(false);
  const [versions, setVersions] = React.useState<BoardVersion[]>([]);
  const [busy, setBusy] = React.useState<number | null>(null);

  React.useEffect(() => {
    if (!open || !host.loadVersions) return;
    void host.loadVersions().then(setVersions);
  }, [open, host, board.version]);

  if (!host.loadVersions) return null;

  const revert = async (version: number) => {
    if (!host.revertTo) return;
    setBusy(version);
    await host.revertTo(version);
    setBusy(null);
    await refresh();
    setOpen(false);
  };

  return (
    <div className="lp-history">
      <button type="button" className="lp-button" onClick={() => setOpen(!open)} data-testid="history-toggle">
        History{versions.length ? ` (${versions.length})` : ""}
      </button>
      {open && (
        <div className="lp-history-panel" data-testid="version-history">
          {versions.map((v) => (
            <div key={v.version} className="lp-history-row">
              <div className="lp-history-text">
                <p>
                  <b>v{v.version}</b> {v.summary || "no change recorded"}
                </p>
                <p className="lp-muted">
                  {v.source === "chat" ? "by chat" : v.source === "revert" ? "rollback" : v.source === "layout" ? "by hand" : v.source} · {v.createdAt.toLocaleString()}
                </p>
              </div>
              {v.version !== board.version && host.revertTo && (
                <button type="button" className="lp-link" disabled={busy !== null} onClick={() => revert(v.version)} data-testid={`restore-${v.version}`}>
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
