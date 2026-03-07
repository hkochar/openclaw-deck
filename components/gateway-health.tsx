"use client";

import { useEffect, useState, useCallback } from "react";

type HealthStatus = "ok" | "warn" | "offline" | "loading";

interface HealthData {
  status: HealthStatus;
  uptime: number;
  droppedEvents: number;
  activeLoops: number;
  loops: Array<{ agent: string; tool: string; count: number; since: number }>;
  memoryMB: number;
}

export function GatewayHealth() {
  const [health, setHealth] = useState<HealthData>({
    status: "loading", uptime: 0, droppedEvents: 0, activeLoops: 0, loops: [], memoryMB: 0,
  });
  const [popupOpen, setPopupOpen] = useState(false);

  const check = useCallback(async () => {
    try {
      const res = await fetch("/api/gateway-health");
      const data = await res.json();
      if (!data.ok && data.status === 0) {
        setHealth(h => ({ ...h, status: "offline" }));
      } else if (data.activeLoops > 0) {
        setHealth({
          status: "warn",
          uptime: data.uptime ?? 0,
          droppedEvents: data.droppedEvents ?? 0,
          activeLoops: data.activeLoops ?? 0,
          loops: data.loops ?? [],
          memoryMB: data.memoryMB ?? 0,
        });
      } else {
        setHealth({
          status: "ok",
          uptime: data.uptime ?? 0,
          droppedEvents: data.droppedEvents ?? 0,
          activeLoops: 0,
          loops: [],
          memoryMB: data.memoryMB ?? 0,
        });
      }
    } catch {
      setHealth(h => ({ ...h, status: "offline" }));
    }
  }, []);

  useEffect(() => {
    check();
    const interval = setInterval(check, 30_000);
    const onGatewayChange = () => { setTimeout(check, 2000); };
    window.addEventListener("gateway-changed", onGatewayChange);
    return () => { clearInterval(interval); window.removeEventListener("gateway-changed", onGatewayChange); };
  }, [check]);

  // Close popup on outside click
  useEffect(() => {
    if (!popupOpen) return;
    const close = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".gateway-health")) setPopupOpen(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [popupOpen]);

  const statusLabel = health.status === "loading" ? "..." : health.status === "ok" ? "Ok" : health.status === "warn" ? "Loop!" : "Offline";

  const title = health.status === "warn"
    ? `STUCK LOOP: ${health.loops.map(l => `${l.agent}/${l.tool} (${l.count}x)`).join(", ")}`
    : health.status === "ok"
      ? `Gateway up ${Math.floor(health.uptime / 60)}m | ${health.memoryMB}MB RAM${health.droppedEvents > 0 ? ` | ${health.droppedEvents} dropped events` : ""}`
      : "Gateway status";

  return (
    <div className="gateway-health" title={title}>
      <button
        className="gateway-health-tap"
        onClick={() => setPopupOpen(p => !p)}
        aria-label="Gateway status"
      >
        <span className={`gateway-health-dot gateway-health-dot--${health.status}`} />
        <span className="gateway-health-label">Gateway</span>
        <span className={`gateway-health-status gateway-health-status--${health.status}`}>
          {statusLabel}
        </span>
        {health.droppedEvents > 0 && health.status !== "offline" && (
          <span className="gateway-health-dropped">
            {health.droppedEvents} dropped
          </span>
        )}
      </button>

      {popupOpen && (
        <div className="gateway-health-popup">
          <div className="gateway-health-popup-row">
            <span>Status</span>
            <span className={`gateway-health-status--${health.status}`}>{statusLabel}</span>
          </div>
          {health.status !== "loading" && health.status !== "offline" && (
            <>
              <div className="gateway-health-popup-row">
                <span>Uptime</span>
                <span>{Math.floor(health.uptime / 60)}m</span>
              </div>
              <div className="gateway-health-popup-row">
                <span>Memory</span>
                <span>{health.memoryMB}MB</span>
              </div>
              {health.droppedEvents > 0 && (
                <div className="gateway-health-popup-row">
                  <span>Dropped</span>
                  <span style={{ color: "#f59e0b" }}>{health.droppedEvents} events</span>
                </div>
              )}
            </>
          )}
          {health.status === "warn" && health.loops.length > 0 && (
            <div className="gateway-health-popup-loops">
              <strong>Stuck Loops</strong>
              {health.loops.map((l, i) => (
                <div key={i}>{l.agent}/{l.tool} ({l.count}x)</div>
              ))}
            </div>
          )}
          {health.status === "offline" && (
            <div className="gateway-health-popup-offline">Gateway is unreachable</div>
          )}
        </div>
      )}
    </div>
  );
}
