"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", key: "overview", label: "Overview" },
  { href: "/costs", key: "costs", label: "Costs" },
  { href: "/schedule", key: "schedule", label: "Schedule" },
  { href: "/logs", key: "logs", label: "Logs" },
  { href: "/tests", key: "tests", label: "Tests" },
  { href: "/knowledge", key: "knowledge", label: "Knowledge" },
  { href: "/sessions", key: "sessions", label: "Sessions" },
  { href: "/analysis", key: "analysis", label: "Analysis" },
  { href: "/search", key: "search", label: "Search" },
  { href: "/services", key: "services", label: "Services" },
  { href: "/config", key: "config", label: "OpenClaw Config" },
  { href: "/deck-config", key: "deck-config", label: "Deck Config" },
];

// Always visible regardless of config
const ALWAYS_VISIBLE = new Set(["services", "deck-config"]);

// Hidden by default on fresh install (no saved prefs)
const DEFAULT_HIDDEN = new Set(["tests"]);

export function Nav() {
  const pathname = usePathname();
  const [hiddenTabs, setHiddenTabs] = useState<Set<string>>(DEFAULT_HIDDEN);

  const loadPrefs = useCallback(() => {
    fetch("/api/dashboard-prefs")
      .then((r) => r.json())
      .then((data) => {
        setHiddenTabs(new Set(data.hiddenTabs ?? [...DEFAULT_HIDDEN]));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadPrefs();
  }, [loadPrefs]);

  // Listen for changes from Deck Config Dashboard tab
  useEffect(() => {
    const handler = () => loadPrefs();
    window.addEventListener("dashboard-prefs-changed", handler);
    return () => window.removeEventListener("dashboard-prefs-changed", handler);
  }, [loadPrefs]);

  const visibleLinks = LINKS.filter(
    (link) => ALWAYS_VISIBLE.has(link.key) || !hiddenTabs.has(link.key)
  );

  return (
    <nav>
      {visibleLinks.map(({ href, label }) => {
        const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={active ? "nav-active" : undefined}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
