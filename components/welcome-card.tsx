"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

const STORAGE_KEY = "deck-welcome-dismissed";

export function WelcomeCard() {
  const [dismissed, setDismissed] = useState(true); // start hidden to avoid flash

  useEffect(() => {
    setDismissed(localStorage.getItem(STORAGE_KEY) === "1");
  }, []);

  if (dismissed) return null;

  function handleDismiss() {
    localStorage.setItem(STORAGE_KEY, "1");
    setDismissed(true);
  }

  return (
    <div className="welcome-card">
      <div className="welcome-header">
        <h2>Welcome to Deck</h2>
        <button className="welcome-dismiss" onClick={handleDismiss} title="Dismiss">
          &times;
        </button>
      </div>
      <p className="welcome-subtitle">
        Your agent orchestration dashboard. Here&apos;s how to get started:
      </p>

      <div className="welcome-steps">
        <div className="welcome-step">
          <span className="welcome-step-num">1</span>
          <div>
            <strong>Set your gateway URL</strong>
            <p>Tell Deck where your OpenClaw gateway is running</p>
            <Link href="/deck-config#edit.infra" className="welcome-link">Deck Config &rarr; Infrastructure &rarr;</Link>
          </div>
        </div>

        <div className="welcome-step">
          <span className="welcome-step-num">2</span>
          <div>
            <strong>Configure agents</strong>
            <p>Add your agents in Deck Config &rarr; Agents tab</p>
            <Link href="/deck-config#edit.agents" className="welcome-link">Deck Config &rarr; Agents &rarr;</Link>
          </div>
        </div>

        <div className="welcome-step">
          <span className="welcome-step-num">3</span>
          <div>
            <strong>Install the gateway plugin</strong>
            <p>The plugin collects cost, session, and reliability data</p>
            <code className="welcome-code">openclaw plugins install --link ./plugin</code>
          </div>
        </div>

        <div className="welcome-step">
          <span className="welcome-step-num">4</span>
          <div>
            <strong>Set up budgets</strong> <span className="welcome-optional">(optional)</span>
            <p>Control spending with daily limits and alert thresholds</p>
            <Link href="/deck-config#edit.budgets" className="welcome-link">Deck Config &rarr; Budgets &rarr;</Link>
          </div>
        </div>
      </div>

      <p className="welcome-footer">
        Once agents are running, this page becomes your command center &mdash; agent status, costs, health, and alerts.
      </p>

      <div className="welcome-links">
        <Link href="/costs">Costs</Link>
        <Link href="/schedule">Schedule</Link>
        <Link href="/logs">Logs</Link>
        <Link href="/sessions">Sessions</Link>
        <Link href="/services">Services</Link>
      </div>
    </div>
  );
}
