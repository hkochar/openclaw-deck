"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";

interface TourStep {
  /** CSS selector for the target element (null = centered modal) */
  target: string | null;
  /** Page the step lives on (pathname) */
  page: string;
  /** Tooltip title */
  title: string;
  /** Tooltip body */
  body: string;
  /** Preferred tooltip position */
  position?: "top" | "bottom" | "left" | "right";
}

const STEPS: TourStep[] = [
  // -- Overview page --
  {
    target: null,
    page: "/",
    title: "Welcome to Deck",
    body: "This quick tour walks you through each page. Use arrow keys or the buttons below. You can restart anytime from Deck Config > Dashboard.",
  },
  {
    target: ".grid.cards",
    page: "/",
    title: "Overview — KPI Cards",
    body: "Your fleet at a glance: active agents, today's cost, gateway uptime, and alert count. This is your daily check-in.",
  },
  {
    target: ".agent-grid",
    page: "/",
    title: "Agent Status Grid",
    body: "Each agent's current state — running, idle, or paused — plus model, daily cost, and context window pressure. Click any agent to jump to their Logs.",
  },
  {
    target: ".system-health",
    page: "/",
    title: "System Health",
    body: "CPU, memory, disk usage, service status, and channel connections. Context pressure alerts show here when agents approach their context window limit.",
  },
  // -- Costs page --
  {
    target: ".cg-grid",
    page: "/costs",
    title: "Costs & Budget Enforcement",
    body: "Per-agent spending with budget gauges. Set daily caps that auto-pause runaway agents. Throttle chains downgrade to cheaper models automatically. Toggle Actual vs API Equivalent costs.",
  },
  // -- Schedule page --
  {
    target: null,
    page: "/schedule",
    title: "Schedule & Model Drift",
    body: "Cron jobs, model configuration, and drift detection. If your provider silently routes to a different model, Deck flags it here and alerts you in Discord.",
  },
  // -- Logs page --
  {
    target: null,
    page: "/logs",
    title: "Logs — Live Event Stream",
    body: "Every LLM call, tool invocation, and message in real time. Expand any event to see full prompts, responses, extended thinking, and cost. Filter by agent, type, billing, and time range.",
  },
  // -- Sessions page --
  {
    target: null,
    page: "/sessions",
    title: "Sessions & Replay",
    body: "All agent sessions — active and archived — with context utilization tracking. Click Replay to step through a session event by event, with anomaly detection and cost progress.",
  },
  // -- Analysis page --
  {
    target: null,
    page: "/analysis",
    title: "Session Analysis",
    body: "Every session gets graded A-F across Research Depth, Task Completion, Tool Efficiency, Error Recovery, and Cost Efficiency. Red flags surface automatically.",
  },
  // -- Knowledge page --
  {
    target: null,
    page: "/knowledge",
    title: "Knowledge",
    body: "Browse agent memory files and docs. See what your agents 'know' — useful for understanding decisions and debugging forgotten context.",
  },
  // -- Services page --
  {
    target: null,
    page: "/services",
    title: "Services & Reliability",
    body: "Start, stop, and restart services. View provider success rates, error rates, and latency. Silence and stuck detection alerts you when an agent goes quiet.",
  },
  // -- OpenClaw Config page --
  {
    target: null,
    page: "/config",
    title: "OpenClaw Config",
    body: "Gateway config editor with versioned backups. Preview, diff, and one-click restore. Every change is tracked — if an agent breaks your config, revert in seconds.",
  },
  // -- Deck Config page --
  {
    target: null,
    page: "/deck-config",
    title: "Deck Config",
    body: "Set budgets, configure agents, connect Discord for mobile alerts (pause, resume, restart from your phone), and tune sentinel thresholds.",
  },
  // -- Finish --
  {
    target: null,
    page: "/",
    title: "You're all set!",
    body: "Deck runs itself from here — budget enforcement, drift detection, silence alerts, and context pressure monitoring all happen automatically. Restart this tour anytime from Deck Config > Dashboard.",
  },
];

// Map page routes to nav tab keys (for hidden tab filtering)
const PAGE_TO_NAV_KEY: Record<string, string> = {
  "/": "overview",
  "/costs": "costs",
  "/schedule": "schedule",
  "/logs": "logs",
  "/sessions": "sessions",
  "/analysis": "analysis",
  "/knowledge": "knowledge",
  "/search": "search",
  "/services": "services",
  "/config": "config",
  "/deck-config": "deck-config",
};

const STORAGE_KEY = "deck-tour-completed";

export function AppTour() {
  const [active, setActive] = useState(false);
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [visibleSteps, setVisibleSteps] = useState<TourStep[]>(STEPS);
  const overlayRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  const router = useRouter();

  // Check if tour should auto-start (first visit) or was triggered via config
  // Also fetch hidden tabs to filter steps
  useEffect(() => {
    function loadAndStart(autoStart: boolean) {
      fetch("/api/dashboard-prefs")
        .then((r) => r.json())
        .then((data) => {
          const hidden = new Set<string>(data.hiddenTabs ?? []);
          // Filter out steps for hidden pages (always keep overview "/" and deck-config)
          const filtered = STEPS.filter((s) => {
            const navKey = PAGE_TO_NAV_KEY[s.page];
            if (!navKey) return true;
            if (navKey === "overview" || navKey === "deck-config") return true;
            return !hidden.has(navKey);
          });
          setVisibleSteps(filtered);

          if (autoStart || data.showWalkthrough) {
            setActive(true);
            setStep(0);
          }
        })
        .catch(() => {
          // On error, use all steps
          setVisibleSteps(STEPS);
          if (autoStart) {
            setActive(true);
            setStep(0);
          }
        });
    }

    const isFirstVisit = !localStorage.getItem(STORAGE_KEY);
    loadAndStart(isFirstVisit);

    // Listen for manual trigger from Deck Config
    const handler = () => loadAndStart(true);
    window.addEventListener("tour-start", handler);
    return () => window.removeEventListener("tour-start", handler);
  }, []);

  // Position the highlight on the target element and scroll it into view
  const positionTooltip = useCallback(() => {
    const s = visibleSteps[step];
    if (!s || !s.target) {
      setRect(null);
      return;
    }
    const el = document.querySelector(s.target);
    if (el) {
      // Scroll target into view so highlight is visible, but leave room for the tooltip at top
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      // Read rect after a small delay to let scroll settle
      setTimeout(() => {
        setRect(el.getBoundingClientRect());
      }, 300);
    } else {
      setRect(null);
    }
  }, [step, visibleSteps]);

  useEffect(() => {
    if (!active) return;
    // Navigate to step's page if needed
    const s = visibleSteps[step];
    if (s && s.page !== pathname) {
      router.push(s.page);
      // Re-position after navigation settles
      const t = setTimeout(positionTooltip, 500);
      return () => clearTimeout(t);
    }
    // Small delay for DOM to render
    const t = setTimeout(positionTooltip, 150);
    return () => clearTimeout(t);
  }, [active, step, pathname, router, positionTooltip, visibleSteps]);

  // Reposition on scroll/resize
  useEffect(() => {
    if (!active) return;
    const handler = () => positionTooltip();
    window.addEventListener("scroll", handler, true);
    window.addEventListener("resize", handler);
    return () => {
      window.removeEventListener("scroll", handler, true);
      window.removeEventListener("resize", handler);
    };
  }, [active, positionTooltip]);

  const close = useCallback(() => {
    setActive(false);
    localStorage.setItem(STORAGE_KEY, "1");
    // Clear config flag so it doesn't re-trigger
    fetch("/api/dashboard-prefs/tour", { method: "POST", body: JSON.stringify({ show: false }) }).catch(() => {});
  }, []);

  const next = useCallback(() => {
    if (step >= visibleSteps.length - 1) {
      close();
    } else {
      setStep((s) => s + 1);
    }
  }, [step, visibleSteps.length, close]);

  const prev = useCallback(() => {
    setStep((s) => Math.max(0, s - 1));
  }, []);

  // Keyboard nav
  useEffect(() => {
    if (!active) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
      if (e.key === "ArrowRight" || e.key === "Enter") next();
      if (e.key === "ArrowLeft") prev();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [active, close, next, prev]);

  if (!active) return null;

  const s = visibleSteps[step];
  const isCenter = !s.target || !rect;
  const isLast = step === visibleSteps.length - 1;

  // Tooltip always pinned to top-right so it's never below the fold
  const tooltipStyle: React.CSSProperties = isCenter
    ? { position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)" }
    : { position: "fixed", top: 16, right: 16 };

  return (
    <div className="tour-overlay" ref={overlayRef}>
      {/* Dark overlay with cutout for target */}
      <svg className="tour-mask" width="100%" height="100%">
        <defs>
          <mask id="tour-cutout">
            <rect x="0" y="0" width="100%" height="100%" fill="white" />
            {rect && (
              <rect
                x={rect.left - 6}
                y={rect.top - 6}
                width={rect.width + 12}
                height={rect.height + 12}
                rx="8"
                fill="black"
              />
            )}
          </mask>
        </defs>
        <rect
          x="0" y="0" width="100%" height="100%"
          fill="rgba(0,0,0,0.55)"
          mask="url(#tour-cutout)"
        />
      </svg>

      {/* Highlight ring around target */}
      {rect && (
        <div
          className="tour-highlight"
          style={{
            position: "fixed",
            left: rect.left - 6,
            top: rect.top - 6,
            width: rect.width + 12,
            height: rect.height + 12,
          }}
        />
      )}

      {/* Tooltip */}
      <div className="tour-tooltip" style={tooltipStyle}>
        <div className="tour-tooltip-header">
          <span className="tour-tooltip-title">{s.title}</span>
          <button className="tour-tooltip-close" onClick={close} title="Exit tour">&times;</button>
        </div>
        <p className="tour-tooltip-body">{s.body}</p>
        <div className="tour-tooltip-footer">
          <span className="tour-tooltip-progress">
            {step + 1} / {visibleSteps.length}
          </span>
          <div className="tour-tooltip-nav">
            {step > 0 && (
              <button className="tour-btn tour-btn--secondary" onClick={prev}>Back</button>
            )}
            <button className="tour-btn tour-btn--primary" onClick={next}>
              {isLast ? "Done" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
