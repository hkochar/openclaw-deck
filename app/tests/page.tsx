"use client";

import { useEffect, useState, useCallback } from "react";

// ── Types ───────────────────────────────────────────────────────────────────

interface SuiteResult {
  pass: number;
  fail: number;
  total: number;
  ok: boolean;
  output: string;
  ranAt: string;
}

const SUITE_NAMES = [
  "cron-parser",
  "config-validation",
  "git-utils",
  "model-utils",
  "security",
  "plist-parser",
  "discord-channels",
  "deck-config",
  "sentinel",
  "ops-bot",
  "integration:local",
  "integration:config",
  "integration:deck-config",
  "integration:gateway",
  "integration:cron",
] as const;

const COOLDOWN_MS = 8_000;

// ── Helpers ─────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function TestsPage() {
  const [suites, setSuites] = useState<Record<string, SuiteResult>>({});
  const [running, setRunning] = useState<string | null>(null);
  const [cooldownLeft, setCooldownLeft] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Load persisted results on mount
  const fetchResults = useCallback(() => {
    fetch("/api/test-run")
      .then((r) => r.json())
      .then((d) => { if (d.ok && d.suites) setSuites(d.suites); })
      .catch(() => {});
  }, []);

  useEffect(() => { fetchResults(); }, [fetchResults]);

  // Cooldown timer
  useEffect(() => {
    if (cooldownLeft <= 0) return;
    const timer = setInterval(() => {
      setCooldownLeft((prev) => {
        if (prev <= 1) return 0;
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [cooldownLeft]);

  const buttonsDisabled = running !== null || cooldownLeft > 0;

  // Run suites
  async function runSuites(suite?: string) {
    const label = suite || "all";
    setRunning(label);

    try {
      const res = await fetch("/api/test-run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(suite ? { suite } : {}),
      });
      const data = await res.json();
      if (data.ok && data.suites) {
        setSuites((prev) => ({ ...prev, ...data.suites }));
      }
    } catch {
      // Silently fail — results will show on next fetch
    }

    setRunning(null);
    setCooldownLeft(Math.ceil(COOLDOWN_MS / 1000));
  }

  // Toggle expanded row
  function toggleExpand(name: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  // Summary stats
  const ranSuites = SUITE_NAMES.filter((n) => suites[n]);
  const totalPass = ranSuites.reduce((s, n) => s + (suites[n]?.pass ?? 0), 0);
  const totalFail = ranSuites.reduce((s, n) => s + (suites[n]?.fail ?? 0), 0);
  const totalTests = ranSuites.reduce((s, n) => s + (suites[n]?.total ?? 0), 0);
  const allPassing = ranSuites.length > 0 && totalFail === 0;

  return (
    <div className="models-page">
      <div className="tests-header">
        <div className="tests-header-left">
          <h2>Test Runner</h2>
          {ranSuites.length > 0 && (
            <p className="tests-summary">
              {totalPass}/{totalTests} passing across {ranSuites.length} suites
              {totalFail > 0 && <> &mdash; <strong style={{ color: "#f87171" }}>{totalFail} failing</strong></>}
            </p>
          )}
        </div>
        <div className="tests-controls">
          {cooldownLeft > 0 && (
            <span className="tests-cooldown">{cooldownLeft}s</span>
          )}
          <button
            className={`cfg-btn${allPassing ? " cfg-btn--primary" : ""}`}
            onClick={() => runSuites()}
            disabled={buttonsDisabled}
          >
            {running === "all" ? "Running…" : "Run All"}
          </button>
        </div>
      </div>

      <div className="models-table-wrap">
        <table className="models-table">
          <thead>
            <tr>
              <th className="tests-col-expand"></th>
              <th>Suite</th>
              <th>Status</th>
              <th>Pass / Total</th>
              <th className="tests-col-lastrun">Last Run</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {SUITE_NAMES.map((name) => {
              const result = suites[name];
              const isRunning = running === name || running === "all";
              const isExpanded = expanded.has(name);

              return (
                <tr key={name} className="models-row" style={{ cursor: result ? "pointer" : undefined }} onClick={() => result && toggleExpand(name)}>
                  <td className="tests-col-expand">
                    {result && (
                      <span className="tests-expand-btn">{isExpanded ? "▾" : "▸"}</span>
                    )}
                  </td>
                  <td style={{ fontWeight: 600 }}>{name}</td>
                  <td>
                    {isRunning ? (
                      <span className="tests-status-badge tests-status-badge--running">running</span>
                    ) : result ? (
                      <span className={`tests-status-badge tests-status-badge--${result.ok ? "pass" : "fail"}`}>
                        {result.ok ? "pass" : "fail"}
                      </span>
                    ) : (
                      <span className="tests-status-badge tests-status-badge--none">&mdash;</span>
                    )}
                  </td>
                  <td className="tests-counts">
                    {result ? `${result.pass} / ${result.total}` : "—"}
                  </td>
                  <td className="tests-time tests-col-lastrun">
                    {result ? timeAgo(result.ranAt) : "never"}
                  </td>
                  <td>
                    <button
                      className="cfg-btn cfg-btn--sm"
                      onClick={(e) => { e.stopPropagation(); runSuites(name); }}
                      disabled={buttonsDisabled}
                    >
                      {isRunning && running === name ? "…" : "Run"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Expanded output panels — rendered outside the table for cleaner layout */}
      {SUITE_NAMES.map((name) => {
        const result = suites[name];
        if (!result || !expanded.has(name)) return null;
        return (
          <div key={`output-${name}`} style={{ marginBottom: 2 }}>
            <pre className="tests-output">{result.output.trim() || "(no output)"}</pre>
          </div>
        );
      })}
    </div>
  );
}
