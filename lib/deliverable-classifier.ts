/**
 * Deliverable Classifier — modular, extensible classification of agent tool events
 * into meaningful deliverables.
 *
 * Users can customize by editing the DEFAULT_RULES array or providing their own
 * rules to classifyEvent() and buildDeliverableGroups().
 *
 * A "deliverable" is something an agent produced — a file, a commit, a message sent.
 * Tool usage like reads, searches, and fetches are NOT deliverables.
 */

// ── Types ────────────────────────────────────────────────────────────

export interface ToolEvent {
  id: number;
  ts: number;
  agent: string;
  session: string;
  tool_name: string;
  tool_query: string | null;
  tool_target: string | null;
  detail: string | null;
}

export interface DeliverableItem {
  type: string;
  label: string;
  target: string | null;
  ts: number;
}

export interface DeliverableGroup {
  agent: string;
  session: string;
  groupKey: string;
  main: DeliverableItem;
  supporting: DeliverableItem[];
  itemCount: number;
  firstTs: number;
  lastTs: number;
  eventsMaxId: number;
}

export interface DeliverableRule {
  /** Tool name to match (e.g. "write", "exec", "message") */
  toolName: string;
  /** Optional filter — return true if this event matches the rule */
  match?: (event: ToolEvent) => boolean;
  /** Output type label (e.g. "file_written", "code_committed") */
  type: string;
  /** Generate display label from the event */
  label: (event: ToolEvent) => string;
  /** Priority for picking the main deliverable in a group (higher wins) */
  priority: number;
}

// ── Helper functions ─────────────────────────────────────────────────

/** Parse action from detail JSON (handles detail.params.action and detail.action) */
function parseAction(event: ToolEvent): string | null {
  if (!event.detail) return null;
  try {
    const d = JSON.parse(event.detail);
    return d.params?.action ?? d.action ?? null;
  } catch {
    return null;
  }
}

/** Extract message content from detail.params.message */
function parseMessage(event: ToolEvent): string | null {
  if (!event.detail) return null;
  try {
    const d = JSON.parse(event.detail);
    return d.params?.message ?? null;
  } catch {
    return null;
  }
}

/** Extract commit message from a git commit command string */
function extractCommitMsg(query: string | null): string | null {
  if (!query) return null;
  const m = query.match(/-m\s+["']([^"']+)["']/);
  return m ? m[1] : null;
}

/** Truncate string to max length, adding ellipsis */
function truncate(s: string | null, max: number): string {
  if (!s) return "";
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/** Shorten a file path for display */
export function shortPath(p: string | null): string {
  if (!p) return "file";
  const parts = p.split("/");
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : parts.join("/");
}

/** Check if a file path should be excluded */
function isIgnoredPath(p: string | null): boolean {
  return !!p && /node_modules|\.git\/|\/tmp\/|\.DS_Store/.test(p);
}

// ── Allowed message actions (everything else is infrastructure) ──────

const SEND_ACTIONS = new Set(["send", "thread-reply", "thread-create"]);

// ── Default Rules ────────────────────────────────────────────────────
// Edit this array to customize what counts as a deliverable.

export const DEFAULT_RULES: DeliverableRule[] = [
  {
    toolName: "message",
    match: (e) => {
      const action = parseAction(e);
      return action !== null && SEND_ACTIONS.has(action);
    },
    type: "message_sent",
    label: (e) => truncate(parseMessage(e), 80) || "message sent",
    priority: 5,
  },
  {
    toolName: "sessions_send",
    type: "message_sent",
    label: (e) => truncate(parseMessage(e), 80) || "agent message sent",
    priority: 5,
  },
  {
    toolName: "exec",
    match: (e) => /git\s+commit/.test(e.tool_query ?? ""),
    type: "code_committed",
    label: (e) => truncate(extractCommitMsg(e.tool_query), 80) || truncate(e.tool_query, 80) || "commit",
    priority: 4,
  },
  {
    toolName: "exec",
    match: (e) => /\b(vitest|jest|pytest|cargo\s+test|npm\s+test|pnpm\s+test|bun\s+test)\b/.test(e.tool_query ?? ""),
    type: "test_run",
    label: (e) => truncate(e.tool_query, 80) || "test run",
    priority: 3,
  },
  {
    toolName: "write",
    match: (e) => !isIgnoredPath(e.tool_target),
    type: "file_written",
    label: (e) => shortPath(e.tool_target),
    priority: 2,
  },
  {
    toolName: "edit",
    match: (e) => !isIgnoredPath(e.tool_target),
    type: "file_edited",
    label: (e) => shortPath(e.tool_target),
    priority: 1,
  },
];

// ── Classification ───────────────────────────────────────────────────

/**
 * Classify a single tool event into a deliverable item.
 * Returns null if the event doesn't match any rule.
 *
 * Rules are evaluated in order — first match wins.
 * Pass custom rules to override defaults.
 */
export function classifyEvent(
  event: ToolEvent,
  rules: DeliverableRule[] = DEFAULT_RULES,
): (DeliverableItem & { priority: number }) | null {
  for (const rule of rules) {
    if (event.tool_name !== rule.toolName) continue;
    if (rule.match && !rule.match(event)) continue;
    return {
      type: rule.type,
      label: rule.label(event),
      target: event.tool_target,
      ts: event.ts,
      priority: rule.priority,
    };
  }
  return null;
}

/** Get the set of tool names referenced by the rules (for SQL filtering) */
export function ruleToolNames(rules: DeliverableRule[] = DEFAULT_RULES): string[] {
  return [...new Set(rules.map((r) => r.toolName))];
}

// ── Grouping ─────────────────────────────────────────────────────────

/** Time gap for clustering events into the same deliverable group */
export const CLUSTER_GAP_MS = 10 * 60_000;

/**
 * Build deliverable groups from a list of raw tool events.
 * Events should be sorted by ts ASC for correct clustering.
 */
export function buildDeliverableGroups(
  events: ToolEvent[],
  rules: DeliverableRule[] = DEFAULT_RULES,
  gapMs: number = CLUSTER_GAP_MS,
): DeliverableGroup[] {
  // Classify all events
  const items: Array<DeliverableItem & { priority: number; agent: string; session: string; eventId: number }> = [];
  for (const event of events) {
    const item = classifyEvent(event, rules);
    if (item) {
      items.push({ ...item, agent: event.agent, session: event.session, eventId: event.id });
    }
  }
  if (items.length === 0) return [];

  // Sort by agent, session, ts for clustering
  items.sort((a, b) => {
    if (a.agent !== b.agent) return a.agent.localeCompare(b.agent);
    if (a.session !== b.session) return a.session.localeCompare(b.session);
    return a.ts - b.ts;
  });

  // Cluster by agent + session + time gap
  const groups: DeliverableGroup[] = [];
  let cluster = [items[0]];

  for (let i = 1; i < items.length; i++) {
    const prev = items[i - 1], curr = items[i];
    if (curr.agent === prev.agent && curr.session === prev.session && curr.ts - prev.ts <= gapMs) {
      cluster.push(curr);
    } else {
      groups.push(finalizeGroup(cluster));
      cluster = [curr];
    }
  }
  groups.push(finalizeGroup(cluster));

  return groups;
}

function finalizeGroup(
  cluster: Array<DeliverableItem & { priority: number; agent: string; session: string; eventId: number }>,
): DeliverableGroup {
  // Pick main by highest priority, break ties by latest ts
  let mainIdx = 0;
  for (let i = 1; i < cluster.length; i++) {
    if (
      cluster[i].priority > cluster[mainIdx].priority ||
      (cluster[i].priority === cluster[mainIdx].priority && cluster[i].ts > cluster[mainIdx].ts)
    ) {
      mainIdx = i;
    }
  }
  const main = cluster[mainIdx];

  // Dedup supporting by target/key (keep latest)
  const seen = new Set<string>();
  if (main.target) seen.add(main.target);
  const supporting: DeliverableItem[] = [];
  for (let i = cluster.length - 1; i >= 0; i--) {
    if (i === mainIdx) continue;
    const it = cluster[i];
    const key = it.target ?? `${it.type}:${it.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    supporting.push({ type: it.type, label: it.label, target: it.target, ts: it.ts });
  }
  supporting.reverse();

  const firstTs = Math.min(...cluster.map((c) => c.ts));
  const lastTs = Math.max(...cluster.map((c) => c.ts));
  const maxId = Math.max(...cluster.map((c) => c.eventId));

  return {
    agent: main.agent,
    session: main.session,
    groupKey: `${main.agent}:${main.session.slice(-12)}:${firstTs}`,
    main: { type: main.type, label: main.label, target: main.target, ts: main.ts },
    supporting,
    itemCount: 1 + supporting.length,
    firstTs,
    lastTs,
    eventsMaxId: maxId,
  };
}
