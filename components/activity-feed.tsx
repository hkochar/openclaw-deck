"use client";

import { useState } from "react";

interface Activity {
  _id: string;
  type: string;
  message: string;
  timestamp: number;
  agent?: {
    name: string;
    emoji: string;
  } | null;
  task?: {
    title: string;
  } | null;
  actionType?: string;
  artifacts?: string[];
  decisions?: string[];
  blockers?: string[];
  workStatus?: string;
}

const PAGE_SIZE = 20;

const STATUS_ICONS: Record<string, string> = {
  started: "▶",
  progressed: "●",
  completed: "✓",
  blocked: "⊘",
  failed: "✗",
};

export function ActivityFeed({ activities }: { activities: Activity[] }) {
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  if (!activities || activities.length === 0) {
    return (
      <div style={{ padding: "2rem", textAlign: "center", color: "#666" }} role="status">
        No activity yet
      </div>
    );
  }

  const visible = activities.slice(0, visibleCount);
  const hasMore = visibleCount < activities.length;

  function toggleExpand(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="activity-feed" role="feed" aria-label="Activity feed">
      {visible.map((activity) => {
        const hasDetails = activity.artifacts?.length || activity.decisions?.length || activity.blockers?.length;
        const isExpanded = expandedIds.has(activity._id);
        const isWorkLog = activity.type === "work_logged";

        return (
          <article
            key={activity._id}
            className={`activity-item${isWorkLog ? " activity-item--work" : ""}${hasDetails ? " activity-item--expandable" : ""}`}
            aria-label={activity.message}
            onClick={() => hasDetails && toggleExpand(activity._id)}
          >
            <div className="activity-emoji" role="img" aria-label={activity.agent?.name ?? "System"}>
              {activity.agent?.emoji || "📌"}
            </div>
            <div className="activity-content">
              {activity.agent?.name && (
                <div className="activity-agent-name">{activity.agent.name}</div>
              )}
              <div className="activity-message">
                {isWorkLog && activity.workStatus && (
                  <span className={`activity-work-status activity-work-status--${activity.workStatus}`}>
                    {STATUS_ICONS[activity.workStatus] ?? "●"}
                  </span>
                )}
                {isWorkLog && activity.actionType && (
                  <span className="activity-action-type">{activity.actionType}</span>
                )}
                {activity.message}
                {hasDetails && (
                  <span className="activity-expand-hint">{isExpanded ? " ▼" : " ▶"}</span>
                )}
              </div>
              {isExpanded && hasDetails && (
                <div className="activity-details">
                  {activity.artifacts && activity.artifacts.length > 0 && (
                    <div className="activity-detail-group">
                      <span className="activity-detail-label">Artifacts</span>
                      {activity.artifacts.map((a, i) => (
                        <span key={i} className="activity-artifact">{a}</span>
                      ))}
                    </div>
                  )}
                  {activity.decisions && activity.decisions.length > 0 && (
                    <div className="activity-detail-group">
                      <span className="activity-detail-label">Decisions</span>
                      {activity.decisions.map((d, i) => (
                        <div key={i} className="activity-decision">{d}</div>
                      ))}
                    </div>
                  )}
                  {activity.blockers && activity.blockers.length > 0 && (
                    <div className="activity-detail-group">
                      <span className="activity-detail-label">Blockers</span>
                      {activity.blockers.map((b, i) => (
                        <div key={i} className="activity-blocker">{b}</div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <div className="activity-time" aria-label={`Time: ${formatTimestamp(activity.timestamp)}`}>
                {formatTimestamp(activity.timestamp)}
              </div>
            </div>
          </article>
        );
      })}
      {hasMore && (
        <button
          className="activity-load-more"
          onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
          aria-label={`Load more activities (${activities.length - visibleCount} remaining)`}
        >
          Load more ({activities.length - visibleCount} remaining)
        </button>
      )}
    </div>
  );
}

function formatTimestamp(ts: number): string {
  const now = Date.now();
  const diff = now - ts;

  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}
