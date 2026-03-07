interface Service {
  label: string;
  name: string;
  running: boolean;
  status: string;
  startInterval?: number;
}

interface HealthData {
  ok: boolean;
  uptime: number;
  droppedEvents: number;
  activeLoops: number;
  loops: { agent: string; tool: string; count: number }[];
  poller?: { running: boolean; lastPollMs: number; filesTracked: number };
}

interface CronJob {
  id: string;
  name: string;
  consecutiveErrors: number;
}

export interface SystemStatsData {
  memory: { usedPercent: number; totalGb: number; usedGb: number } | null;
  cpu: { load1m: number; cores: number; percent: number } | null;
  disk: { usedPercent: number; totalGb: number; usedGb: number; freeGb: number } | null;
}

export interface ChannelStatusData {
  id: string;
  label: string;
  configured: boolean;
  running: boolean;
  lastError: string | null;
  accounts: {
    accountId: string;
    name?: string;
    configured: boolean;
    running: boolean;
    lastError: string | null;
    lastStartAt: number | null;
  }[];
}

interface SystemHealthProps {
  services: Service[];
  health: HealthData | null;
  crons: CronJob[];
  stats?: SystemStatsData | null;
  channels?: ChannelStatusData[] | null;
}

function timeAgo(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

export function SystemHealth({ services, health, crons, stats, channels }: SystemHealthProps) {
  const failedCrons = crons.filter((c) => c.consecutiveErrors >= 2).length;

  return (
    <section className="system-health" role="region" aria-label="System Health">
      <h3 className="section-heading">System Health</h3>

      <div className="system-health-services">
        {services.map((svc) => (
          <div key={svc.label} className="system-health-row">
            <span className={`system-health-dot system-health-dot--${svc.running || svc.startInterval ? "ok" : "error"}`} />
            <span className="system-health-name">{svc.name}</span>
            <span className="system-health-status">{svc.running ? "running" : svc.startInterval ? `every ${Math.round(svc.startInterval / 60)}m` : "stopped"}</span>
          </div>
        ))}
        {services.length === 0 && (
          <div className="muted" style={{ fontSize: "0.75rem", padding: "0.25rem 0" }}>No services found</div>
        )}
      </div>

      {/* Channels & Plugin */}
      {(channels || health?.poller) && (
        <div className="system-health-connections">
          {channels && channels.map((ch) => {
            const configuredAccounts = ch.accounts.filter((a) => a.configured);
            const runningAccounts = configuredAccounts.filter((a) => a.running);
            const allRunning = configuredAccounts.length > 0 && runningAccounts.length === configuredAccounts.length;
            const someRunning = runningAccounts.length > 0;
            const hasError = configuredAccounts.some((a) => a.lastError);
            const status = configuredAccounts.length === 0
              ? "unconfigured"
              : allRunning ? "ok" : someRunning ? "partial" : "error";
            const dotClass = status === "ok" ? "ok" : status === "partial" ? "warn" : status === "error" ? "error" : "muted";
            const statusText = configuredAccounts.length === 0
              ? "not configured"
              : allRunning
                ? `${runningAccounts.length} connected`
                : someRunning
                  ? `${runningAccounts.length}/${configuredAccounts.length} connected`
                  : hasError
                    ? configuredAccounts.find((a) => a.lastError)?.lastError ?? "disconnected"
                    : "disconnected";

            return (
              <div key={ch.id} className="system-health-row">
                <span className={`system-health-dot system-health-dot--${dotClass}`} />
                <span className="system-health-name">{ch.label}</span>
                <span className="system-health-status">{statusText}</span>
              </div>
            );
          })}

          {health?.poller && (
            <div className="system-health-row">
              <span className={`system-health-dot system-health-dot--${health.poller.running ? "ok" : "error"}`} />
              <span className="system-health-name">Plugin</span>
              <span className="system-health-status">
                {health.poller.running
                  ? `tracking ${health.poller.filesTracked} files`
                  : "stopped"}
                {health.poller.lastPollMs > 0 && (
                  <span title={new Date(health.poller.lastPollMs).toLocaleString()}> · {timeAgo(health.poller.lastPollMs)}</span>
                )}
              </span>
            </div>
          )}
        </div>
      )}

      {stats && (
        <div className="system-health-resources">
          {stats.memory && (
            <ResourceBar
              label="Memory"
              percent={stats.memory.usedPercent}
              detail={`${stats.memory.usedGb} / ${stats.memory.totalGb} GB`}
            />
          )}
          {stats.cpu && (
            <ResourceBar
              label="CPU"
              percent={Math.min(stats.cpu.percent, 100)}
              detail={`${stats.cpu.load1m.toFixed(1)} load · ${stats.cpu.cores} cores`}
            />
          )}
          {stats.disk && (
            <ResourceBar
              label="Disk"
              percent={stats.disk.usedPercent}
              detail={`${stats.disk.freeGb} GB free`}
            />
          )}
        </div>
      )}

      <div className="system-health-metrics">
        <HealthMetric
          label="Stuck Loops"
          value={health?.activeLoops ?? 0}
          danger={health ? health.activeLoops > 0 : false}
        />
        <HealthMetric
          label="Dropped Events"
          value={health?.droppedEvents ?? 0}
          danger={health ? health.droppedEvents > 0 : false}
        />
        <HealthMetric
          label="Cron Failures"
          value={failedCrons}
          danger={failedCrons > 0}
          href="/schedule"
        />
      </div>
    </section>
  );
}

function ResourceBar({ label, percent, detail }: { label: string; percent: number; detail: string }) {
  const level = percent >= 90 ? "critical" : percent >= 75 ? "warning" : "ok";
  return (
    <div className="sys-resource-bar" title={detail}>
      <div className="sys-resource-bar-header">
        <span className="sys-resource-bar-label">{label}</span>
        <span className={`sys-resource-bar-value sys-resource-bar-value--${level}`}>{percent}%</span>
      </div>
      <div className="sys-resource-bar-track">
        <div
          className={`sys-resource-bar-fill sys-resource-bar-fill--${level}`}
          style={{ width: `${Math.min(percent, 100)}%` }}
        />
      </div>
      <span className="sys-resource-bar-detail">{detail}</span>
    </div>
  );
}

function HealthMetric({ label, value, danger, href }: { label: string; value: number; danger: boolean; href?: string }) {
  const content = (
    <div className="system-health-metric">
      <span className="system-health-metric-label">{label}</span>
      <span className={`system-health-metric-value${danger ? " system-health-metric-value--danger" : ""}`}>
        {value}
      </span>
    </div>
  );
  if (href) return <a href={href} style={{ textDecoration: "none", color: "inherit" }}>{content}</a>;
  return content;
}
