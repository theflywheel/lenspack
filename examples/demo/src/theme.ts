import * as React from "react";

// Light, dark, or whatever the system says. index.html applies the stored
// pick before first paint; this keeps <html data-theme> in step after that.
export type ThemeChoice = "system" | "light" | "dark";
const KEY = "lenspack-theme";
const dark = () => matchMedia("(prefers-color-scheme: dark)");

function stored(): ThemeChoice {
  try {
    const t = localStorage.getItem(KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

function apply(choice: ThemeChoice) {
  document.documentElement.dataset.theme = choice === "system" ? (dark().matches ? "dark" : "light") : choice;
}

export function useTheme() {
  const [choice, setChoice] = React.useState<ThemeChoice>(stored);
  React.useEffect(() => {
    apply(choice);
    try {
      if (choice === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, choice);
    } catch {
      // A private window may refuse storage: the pick lasts until reload.
    }
    if (choice !== "system") return;
    const m = dark();
    const follow = () => apply("system");
    m.addEventListener("change", follow);
    return () => m.removeEventListener("change", follow);
  }, [choice]);
  return [choice, setChoice] as const;
}
