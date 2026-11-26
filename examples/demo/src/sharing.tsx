import * as React from "react";

import { Package, Share2, User, Users, X } from "lucide-react";

import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover";

// The board menu's groups and the share dialog. A board someone made is shown
// to the people they name, to everyone signed in, or to nobody else; whoever
// it is shown to reads it and may save a copy, never change it.

export type Entry = { id: string; title: string; owner?: string; shared?: boolean; everyone?: boolean; people?: string[]; writable?: boolean };
export type Sharing = { everyone: boolean; people: string[] };
type Group = { key: "pack" | "yours" | "shared"; label: string; icon: typeof Package; boards: Entry[] };

// The board menu: the pack's own boards, yours, and those others shared with
// you. Temporary boards (previews, evals) stay out of it.
export function boardGroups(boards: Entry[], me: { user: string } | null): Group[] {
  const listed = boards.filter((b) => !b.id.startsWith("tmp_"));
  const mine = (b: Entry) => !!b.owner && (!me || b.owner === me.user);
  return [
    { key: "pack", label: "The pack's boards", icon: Package, boards: listed.filter((b) => !b.owner) },
    { key: "yours", label: "Yours", icon: User, boards: listed.filter(mine) },
    { key: "shared", label: "Shared with you", icon: Users, boards: listed.filter((b) => b.owner && !mine(b)) },
  ];
}

/** How someone else's board reached the viewer: with everyone, or with them by name. Who else it names is its owner's to know. */
export function reachedBy(b: { everyone?: boolean }): string {
  return b.everyone ? "Shared with everyone" : "Shared with you";
}

/** Who a board is shared with, in a few words for its owner. */
export function sharedWith({ everyone, people }: Sharing): string {
  if (everyone) return "Shared with everyone";
  if (people.length === 1) return `Shared with ${people[0]}`;
  return people.length ? `Shared with ${people.length} people` : "Share";
}

/** The share dialog's body: who has access, adding and removing people, and everyone signed in. Every change is saved at once. */
export function SharePanel({ title, owner, sharing, suggestions, busy, error, onChange }: { title: string; owner: string; sharing: Sharing; suggestions: string[]; busy?: boolean; error?: string | null; onChange: (next: Sharing) => void }) {
  const [name, setName] = React.useState("");
  const typed = name.trim();
  // A name is one person whatever its case.
  const listed = (who: string) => [owner, ...sharing.people].some((p) => p.toLowerCase() === who.toLowerCase());
  const add = (who: string) => {
    setName("");
    if (who && !listed(who)) onChange({ ...sharing, people: [...sharing.people, who] });
  };
  const offered = suggestions.filter((p) => !listed(p) && p.toLowerCase().includes(typed.toLowerCase())).slice(0, 6);
  return (
    <div className="space-y-3 text-sm" data-testid="share-dialog">
      <div>
        <p className="truncate font-medium">Share “{title}”</p>
        <p className="text-xs text-muted-foreground">View only: they can read it and save a copy, not change it.</p>
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add(typed);
        }}
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Add people by user name" aria-label="User name" className="h-8" disabled={busy} data-testid="share-person-input" />
        <Button type="submit" size="sm" variant="secondary" disabled={busy || !typed} data-testid="share-add">
          Add
        </Button>
      </form>
      {offered.length > 0 && (
        <div className="flex flex-wrap gap-1" data-testid="share-suggestions">
          {offered.map((p) => (
            <button key={p} type="button" className="rounded-full border px-2 py-0.5 text-xs hover:bg-accent" disabled={busy} onClick={() => add(p)} data-testid={`share-suggestion-${p}`}>
              + {p}
            </button>
          ))}
        </div>
      )}
      <div>
        <p className="mb-1 text-xs font-medium text-muted-foreground">Who has access</p>
        <ul className="max-h-48 space-y-0.5 overflow-y-auto" data-testid="share-people">
          <li className="flex items-center gap-2 py-1">
            <User className="size-4 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{owner}</span>
            <span className="text-xs text-muted-foreground">owner</span>
          </li>
          {sharing.people.map((p) => (
            <li key={p} className="flex items-center gap-2 py-0.5" data-testid={`share-person-${p}`}>
              <User className="size-4 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{p}</span>
              <span className="text-xs text-muted-foreground">can view</span>
              <Button variant="ghost" size="icon" className="size-7" disabled={busy} aria-label={`Remove ${p}`} onClick={() => onChange({ ...sharing, people: sharing.people.filter((x) => x !== p) })} data-testid={`share-remove-${p}`}>
                <X />
              </Button>
            </li>
          ))}
        </ul>
      </div>
      <label className="flex cursor-pointer items-start gap-2 border-t pt-3">
        <input type="checkbox" className="mt-0.5 size-4 accent-primary" checked={sharing.everyone} disabled={busy} onChange={(e) => onChange({ ...sharing, everyone: e.target.checked })} data-testid="share-everyone" />
        <span>
          <span className="flex items-center gap-1">
            <Users className="size-3.5 text-muted-foreground" /> Everyone signed in
          </span>
          <span className="block text-xs text-muted-foreground">Anyone who can open this pack can view it.</span>
        </span>
      </label>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

/** The owner's share button and its dialog. People who have used the server are offered as names; any name may be typed. */
export function ShareButton({ base, title, owner, entry, load, onSaved }: { base: string; title: string; owner: string; entry?: Entry; load: (path: string, init?: RequestInit) => Promise<any>; onSaved: () => void }) {
  const [open, setOpen] = React.useState(false);
  const [sharing, setSharing] = React.useState<Sharing>({ everyone: !!entry?.everyone, people: entry?.people ?? [] });
  const [suggestions, setSuggestions] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // The menu's entry is what the server last said; it wins whenever it changes.
  const said = JSON.stringify([!!entry?.everyone, entry?.people ?? []]);
  React.useEffect(() => setSharing({ everyone: !!entry?.everyone, people: entry?.people ?? [] }), [said]);
  React.useEffect(() => {
    if (!open) return;
    void load("/_people").then((r) => setSuggestions(Array.isArray(r?.people) ? r.people : []));
  }, [open, load]);
  const change = async (next: Sharing) => {
    setBusy(true);
    setError(null);
    const r = await load(`${base}/share`, { method: "POST", body: JSON.stringify(next) });
    setBusy(false);
    if (r?.error) return setError(r.error);
    setSharing({ everyone: !!r.everyone, people: r.people ?? [] });
    onSaved();
  };
  const isShared = sharing.everyone || sharing.people.length > 0;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" data-testid="share-board" aria-pressed={isShared}>
          {isShared ? <Users /> : <Share2 />} {sharedWith(sharing)}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <SharePanel title={title} owner={owner} sharing={sharing} suggestions={suggestions} busy={busy} error={error} onChange={(next) => void change(next)} />
      </PopoverContent>
    </Popover>
  );
}
