import * as React from "react";

import { ChevronRight, Gauge, LogOut, Monitor, Moon, Sun, UserRound } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover";
import { cn } from "./lib/utils";
import { type ThemeChoice, useTheme } from "./theme";

const THEMES: { value: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

// The person's corner: who they are, the theme, what the AI has cost (for
// those who may see it), and the way out. On an open server there is no one
// signed in, so it names a guest, and there is no way out to offer.
export function ProfileMenu({ user, signOut, onUsage }: { user?: string; signOut?: string; onUsage?: () => void }) {
  const [theme, setTheme] = useTheme();
  const [open, setOpen] = React.useState(false);
  const initial = (user ?? "").trim().charAt(0).toUpperCase();
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={user ? `Account: ${user}` : "Guest: theme and usage"}
          title={user ?? "Guest"}
          data-testid="profile-menu"
          className="flex size-8 shrink-0 items-center justify-center rounded-full border border-rule-strong bg-muted text-xs font-semibold text-foreground hover:bg-accent"
        >
          {initial || <UserRound className="size-4" />}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-0">
        <div className="border-b border-rule px-4 py-3">
          <div className="text-2xs text-muted-foreground">{user ? "Signed in as" : "Browsing as"}</div>
          <div className="truncate text-sm font-medium text-foreground" data-testid="signed-in">
            {user ?? "Guest"}
          </div>
          {!user && <div className="text-2xs text-muted-foreground">This server is open: no sign-in.</div>}
        </div>
        {onUsage && (
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onUsage();
            }}
            className="flex w-full items-center gap-2 border-b border-rule px-4 py-2.5 text-left text-sm text-foreground hover:bg-accent"
            data-testid="usage-open"
          >
            <Gauge className="size-4 text-muted-foreground" />
            <span className="flex-1">AI usage</span>
            <ChevronRight className="size-4 text-muted-foreground" />
          </button>
        )}
        <div className="px-4 py-3">
          <div className="mb-2 text-2xs text-muted-foreground">Theme</div>
          <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-1 rounded-md border border-rule p-0.5">
            {THEMES.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={theme === value}
                data-testid={`theme-${value}`}
                onClick={() => setTheme(value)}
                className={cn(
                  "flex items-center justify-center gap-1 rounded-sm px-2 py-1 text-xs text-muted-foreground hover:text-foreground",
                  theme === value && "bg-accent font-medium text-foreground",
                )}
              >
                <Icon className="size-3.5" /> {label}
              </button>
            ))}
          </div>
        </div>
        {signOut && (
          <a href={signOut} className="flex items-center gap-2 border-t border-rule px-4 py-2.5 text-sm text-foreground hover:bg-accent" data-testid="sign-out">
            <LogOut className="size-4" /> Sign out
          </a>
        )}
      </PopoverContent>
    </Popover>
  );
}
