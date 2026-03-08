"use client";

import { useState, useEffect, useCallback } from "react";

/**
 * Persist tab state in the URL hash (e.g. #crons).
 * SSR-safe — always starts with `defaultTab` to avoid hydration mismatch,
 * then syncs from hash on mount.
 * Uses replaceState to avoid polluting browser history on every tab switch.
 */
export function useHashTab<T extends string>(
  defaultTab: T,
  validTabs?: readonly T[],
): [T, (tab: T) => void] {
  const [tab, setTabState] = useState<T>(defaultTab);

  // Sync from hash on mount (client only)
  useEffect(() => {
    const h = window.location.hash.slice(1).split(/[?&]/)[0];
    if (h && (!validTabs || validTabs.includes(h as T))) {
      setTabState(h as T);
    }
  }, [defaultTab, validTabs]);

  useEffect(() => {
    const handler = () => {
      const h = window.location.hash.slice(1).split(/[?&]/)[0] as T;
      if (!h) { setTabState(defaultTab); return; }
      if (validTabs && !validTabs.includes(h)) return;
      setTabState(h);
    };
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, [defaultTab, validTabs]);

  const setTab = useCallback((t: T) => {
    setTabState(t);
    // Preserve query params when updating hash
    history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}#${t}`,
    );
  }, []);

  return [tab, setTab];
}
