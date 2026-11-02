import * as React from "react";

import { LogOut, Monitor, Moon, Sun } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover";
import { cn } from "./lib/utils";
import { type ThemeChoice, useTheme } from "./theme";

const THEMES: { value: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

// The signed-in person's corner: who they are, the theme, and the way out.
// On an open server there is no one to name, so it holds the theme alone.
export function ProfileMenu({ user, signOut }: { user?: string; signOut?: string }) {
  const [theme, setTheme] = useTheme();
  const initial = (user ?? "").trim().charAt(0).toUpperCase();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={user ? `Account: ${user}` : "Appearance"}
          data-testid="profile-menu"
          className="flex size-8 items-center justify-center rounded-full border border-rule-strong bg-muted text-xs font-semibold text-foreground hover:bg-accent"
        >
          {initial || <Sun className="size-4" />}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-0">
        {user && (
          <div className="border-b border-rule px-4 py-3">
            <div className="text-2xs text-muted-foreground">Signed in as</div>
            <div className="truncate text-sm font-medium text-foreground" data-testid="signed-in">
              {user}
            </div>
          </div>
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
