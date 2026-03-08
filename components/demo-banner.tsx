"use client";

import { useEffect, useState } from "react";

export function DemoBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Don't show if user dismissed it
    if (localStorage.getItem("deck-demo-dismissed") === "1") return;

    fetch("/api/demo-status")
      .then((r) => r.json())
      .then((data) => {
        if (data.demo) setVisible(true);
      })
      .catch(() => {});
  }, []);

  if (!visible) return null;

  return (
    <div className="demo-banner">
      <span>
        Showing demo data. Run{" "}
        <code style={{ fontSize: "0.85em", padding: "1px 4px", background: "rgba(255,255,255,0.15)", borderRadius: 3 }}>
          pnpm backfill
        </code>{" "}
        to import your real data, or{" "}
        <a href="https://docs.openclaw.ai/configuration" target="_blank" rel="noopener">
          connect a gateway
        </a>{" "}
        for live monitoring.
      </span>
      <button
        onClick={() => {
          localStorage.setItem("deck-demo-dismissed", "1");
          setVisible(false);
        }}
        aria-label="Dismiss"
      >
        &times;
      </button>
    </div>
  );
}
