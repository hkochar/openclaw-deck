"use client";

import { useEffect, useState } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [restarting, setRestarting] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    console.error("Global error boundary caught:", error);
  }, [error]);

  async function handleRestartAll() {
    setRestarting(true);
    setResult(null);
    try {
      const res = await fetch("/api/service-control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "restart-all", includeGateway: false }),
      });
      const data = await res.json();
      if (data.ok) {
        setResult("Services restarting. Reloading in 8 seconds...");
        setTimeout(() => window.location.reload(), 8000);
      } else {
        setResult(`Restart failed: ${JSON.stringify(data.steps?.filter((s: { ok: boolean }) => !s.ok))}`);
        setRestarting(false);
      }
    } catch (e) {
      setResult(`Request failed: ${e instanceof Error ? e.message : String(e)}`);
      setRestarting(false);
    }
  }

  return (
    <div className="error-boundary">
      <div className="error-boundary-card">
        <h1>Deck Error</h1>
        <p className="error-boundary-msg">
          {error.message || "An unexpected error occurred."}
        </p>
        {error.digest && (
          <p className="error-boundary-digest">Error ID: {error.digest}</p>
        )}
        <div className="error-boundary-actions">
          <button onClick={reset} className="error-boundary-btn">
            Try Again
          </button>
          <button
            onClick={handleRestartAll}
            disabled={restarting}
            className="error-boundary-btn error-boundary-btn--restart"
          >
            {restarting ? "Restarting..." : "Restart All Services"}
          </button>
        </div>
        {result && <p className="error-boundary-result">{result}</p>}
      </div>
    </div>
  );
}
