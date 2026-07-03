import { useCallback, useEffect, useState } from "react";

export type ThemeName = "light" | "dark";

const STORAGE_KEY = "pcr-ai-report.theme.v1";

function readStoredTheme(): ThemeName {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  return raw === "dark" ? "dark" : "light";
}

export function useTheme() {
  const [theme, setThemeState] = useState<ThemeName>(readStoredTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  const setTheme = useCallback((next: ThemeName) => setThemeState(next), []);
  const toggleTheme = useCallback(
    () => setThemeState((t) => (t === "light" ? "dark" : "light")),
    []
  );

  return { theme, setTheme, toggleTheme };
}
