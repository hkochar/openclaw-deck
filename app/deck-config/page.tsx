"use client";

import { useEffect, useState, useCallback } from "react";

interface AgentEntry {
  id: string;
  key: string;
  name: string;
  role: string;
  emoji: string;
  discordChannelId: string;
  agentDir: string;
}

interface DashboardPrefs {
  hiddenTabs?: string[];
  showWalkthrough?: boolean;
}

interface DeckConfig {
  agents: AgentEntry[];
  systemChannels: Record<string, string>;
  pluginChannels: Record<string, string>;
  logChannels: Record<string, string>;
  serviceUrls: Record<string, string>;
  dashboard: DashboardPrefs;
  opsBotCommands: Record<string, boolean>;
  sessionKeys: Record<string, string>;
  agentDirs: Record<string, string>;
}

type SaveStatus = "idle" | "saving" | "saved" | "error";

type ChannelSection = "systemChannels" | "pluginChannels" | "logChannels";

function isSnowflake(s: string): boolean {
  return /^\d{10,25}$/.test(s.trim());
}

/** Check if a channel value is valid: bare snowflake OR platform:id format. */
function isValidChannelId(s: string): boolean {
  const trimmed = s.trim();
  if (!trimmed) return false;
  // Bare snowflake (Discord default)
  if (isSnowflake(trimmed)) return true;
  // Platform-prefixed: discord:123, slack:C0ABC, telegram:-100123
  const match = trimmed.match(/^(discord|slack|telegram):(.+)$/);
  if (match) {
    const id = match[2];
    if (match[1] === "discord") return isSnowflake(id);
    return id.length > 0;
  }
  return false;
}

function toKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// ── Provider usage text parser ───────────────────────────────────────────────

interface ParsedCalibration {
  plan?: string;
  windows: Array<{ id: string; pct: number; resetAt?: string; note?: string }>;
}

/**
 * Parse provider usage text. Handles two formats:
 *
 * Percentage format (Anthropic):
 *   "Current session\n12% used\nResets in 2 hr 57 min\nWeekly limits\nAll models\n2% used\nResets Thu 9:59 PM"
 *
 * Absolute format:
 *   "23 / 45 messages" or "23/45"
 */
function parseProviderUsageText(text: string): ParsedCalibration {
  const result: ParsedCalibration = { windows: [] };
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  // Detect plan tier
  const planMatch = text.match(/\b(Max|Pro|Free|Team|Enterprise)\b/i);
  if (planMatch) result.plan = planMatch[1];

  // Track which "section" we're in based on header lines
  let currentSection = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lower = line.toLowerCase();

    // Detect section headers
    if (/current\s+session/i.test(line)) { currentSection = "5h-rolling"; continue; }
    if (/weekly/i.test(lower)) { currentSection = "weekly"; continue; }
    if (/daily/i.test(lower)) { currentSection = "daily"; continue; }
    if (/monthly/i.test(lower)) { currentSection = "monthly"; continue; }

    // Match "12% used" pattern
    const pctMatch = line.match(/(\d+(?:\.\d+)?)\s*%\s*used/i);
    if (pctMatch && currentSection) {
      const pct = parseFloat(pctMatch[1]);

      // Look ahead for reset time
      let resetAt: string | undefined;
      let note: string | undefined;
      for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
        const ahead = lines[j];
        // "Resets in 2 hr 57 min"
        const hmMatch = ahead.match(/resets?\s+in\s+(\d+)\s*hr?\s*(?:(\d+)\s*min)?/i);
        if (hmMatch) {
          const hours = parseInt(hmMatch[1], 10);
          const mins = hmMatch[2] ? parseInt(hmMatch[2], 10) : 0;
          resetAt = new Date(Date.now() + hours * 3600000 + mins * 60000).toISOString();
          note = ahead;
          break;
        }
        // "Resets Thu 9:59 PM"
        const dayTimeMatch = ahead.match(/resets?\s+(mon|tue|wed|thu|fri|sat|sun)\w*\s+(\d{1,2}):(\d{2})\s*(am|pm)/i);
        if (dayTimeMatch) {
          const dayAbbr = dayTimeMatch[1].toLowerCase().slice(0, 3);
          const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
          const targetDay = days.indexOf(dayAbbr);
          let hour = parseInt(dayTimeMatch[2], 10);
          const min = parseInt(dayTimeMatch[3], 10);
          const ampm = dayTimeMatch[4].toLowerCase();
          if (ampm === "pm" && hour < 12) hour += 12;
          if (ampm === "am" && hour === 12) hour = 0;
          const now = new Date();
          let daysUntil = targetDay - now.getDay();
          if (daysUntil <= 0) daysUntil += 7;
          const resetDate = new Date(now);
          resetDate.setDate(resetDate.getDate() + daysUntil);
          resetDate.setHours(hour, min, 0, 0);
          resetAt = resetDate.toISOString();
          note = ahead;
          break;
        }
      }

      result.windows.push({ id: currentSection, pct, resetAt, note });
      currentSection = ""; // consumed
      continue;
    }

    // Fallback: match "23 / 45" absolute format
    const absMatch = line.match(/(\d[\d,]*(?:\.\d+)?)\s*\/\s*(\d[\d,]*(?:\.\d+)?)/);
    if (absMatch) {
      const used = parseFloat(absMatch[1].replace(/,/g, ""));
      const limit = parseFloat(absMatch[2].replace(/,/g, ""));
      if (!isNaN(used) && !isNaN(limit) && limit > 0) {
        const id = currentSection || "unknown";
        result.windows.push({ id, pct: Math.round((used / limit) * 100) });
        currentSection = "";
      }
    }
  }

  return result;
}

// ── Sentinel check metadata ──────────────────────────────────────────────────

interface CheckParamDef {
  key: string;
  label: string;
  type: "number" | "boolean" | "string";
  topLevel?: boolean; // true = config root key, false = nested in checks.X
}

const SENTINEL_CHECKS: Record<string, {
  label: string;
  description: string;
  params?: CheckParamDef[];
}> = {
  working_md: {
    label: "Working.md Freshness",
    description: "Alerts when WORKING.md hasn't been updated recently",
    params: [
      { key: "working_md_max_age_hours", label: "Max age (hours)", type: "number", topLevel: true },
    ],
  },
  launchd_services: {
    label: "LaunchAgent Services",
    description: "Monitors and auto-restarts LaunchAgent services",
    params: [
      { key: "auto_restart", label: "Auto-restart", type: "boolean" },
    ],
  },
  port_conflicts: {
    label: "Port Conflicts",
    description: "Detects and kills duplicate port listeners",
    params: [
      { key: "auto_kill", label: "Auto-kill stale processes", type: "boolean" },
    ],
  },
  dashboard_health: {
    label: "Dashboard Health",
    description: "HTTP probe for Deck dashboard",
    params: [
      { key: "url", label: "URL", type: "string" },
    ],
  },
  gateway_health: {
    label: "Gateway Health",
    description: "Pings gateway and validates config on failure",
    params: [
      { key: "gateway_health_timeout_seconds", label: "Timeout (seconds)", type: "number", topLevel: true },
    ],
  },
  ghost_crons: {
    label: "Ghost Cron Sessions",
    description: "Detects orphaned cron sessions after job deletion",
  },
  cron_health: {
    label: "Cron Health",
    description: "Flags cron jobs with consecutive errors above threshold",
    params: [
      { key: "cron_consecutive_error_threshold", label: "Error threshold", type: "number", topLevel: true },
    ],
  },
  security_audit: {
    label: "Security Audit",
    description: "Scans for security issues (stub)",
  },
  system_resources: {
    label: "System Resources",
    description: "Monitors CPU load, memory, and disk usage",
    params: [
      { key: "memory_percent", label: "Memory threshold (%)", type: "number" },
      { key: "disk_percent", label: "Disk threshold (%)", type: "number" },
      { key: "cpu_load_multiplier", label: "CPU load multiplier (× cores)", type: "number" },
      { key: "disk_path", label: "Disk path", type: "string" },
    ],
  },
  plugin_health: {
    label: "Plugin Health",
    description: "Detects plugin failures — stale poller, missing events, plugin not loaded. Event freshness only checked during active hours.",
    params: [
      { key: "stale_poll_minutes", label: "Stale poll threshold (min)", type: "number" },
      { key: "stale_events_minutes", label: "Stale events threshold (min)", type: "number" },
      { key: "active_hours_start", label: "Active hours start (0-23)", type: "number" },
      { key: "active_hours_end", label: "Active hours end (0-23)", type: "number" },
    ],
  },
  context_pressure: {
    label: "Context Pressure",
    description: "Alerts when any session's context window fill exceeds the threshold. Checks are skipped outside active hours. 30-min cooldown per session.",
    params: [
      { key: "context_threshold_percent", label: "Context threshold (%)", type: "number" },
      { key: "active_hours_start", label: "Active hours start (0-23)", type: "number" },
      { key: "active_hours_end", label: "Active hours end (0-23)", type: "number" },
    ],
  },
};

// ── Add Agent Modal ─────────────────────────────────────────────────────────

function AddAgentModal({ existingKeys, onAdd, onClose }: {
  existingKeys: Set<string>;
  onAdd: (agent: AgentEntry) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [keyTouched, setKeyTouched] = useState(false);
  const [id, setId] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  const [emoji, setEmoji] = useState("🤖");
  const [discordChannelId, setDiscordChannelId] = useState("");
  const [role, setRole] = useState("");
  const [agentDir, setAgentDir] = useState("");

  const derivedKey = toKey(name);
  const effectiveKey = keyTouched ? key : derivedKey;
  const effectiveId = idTouched ? id : effectiveKey;

  const errors: string[] = [];
  if (!name.trim()) errors.push("Name is required");
  if (!effectiveKey) errors.push("Key is required");
  if (existingKeys.has(effectiveKey)) errors.push(`Key "${effectiveKey}" already exists`);
  if (!discordChannelId.trim()) errors.push("Discord Channel ID is required");
  else if (!isSnowflake(discordChannelId)) errors.push("Discord Channel ID must be a numeric snowflake");

  function handleSubmit() {
    if (errors.length > 0) return;
    onAdd({
      id: effectiveId || effectiveKey,
      key: effectiveKey,
      name: name.trim(),
      role: role.trim(),
      emoji: emoji.trim() || "🤖",
      discordChannelId: discordChannelId.trim(),
      agentDir: agentDir.trim(),
    });
  }

  return (
    <div className="mcc-modal-overlay" onClick={onClose}>
      <div className="mcc-modal" onClick={(e) => e.stopPropagation()}>
        <div className="mcc-modal-header">
          <h3>Add Agent</h3>
          <button className="mcc-modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="mcc-modal-body">
          <div className="mcc-field">
            <label className="mcc-label">Name <span className="mcc-required">*</span></label>
            <input
              className="mcc-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Scout"
              autoFocus
            />
          </div>
          <div className="mcc-field">
            <label className="mcc-label">Key <span className="mcc-hint">(auto-derived from name)</span></label>
            <input
              className="mcc-input mcc-input--mono"
              value={keyTouched ? key : derivedKey}
              onChange={(e) => { setKey(e.target.value); setKeyTouched(true); }}
              placeholder="auto-derived"
            />
          </div>
          <div className="mcc-field">
            <label className="mcc-label">ID <span className="mcc-hint">(defaults to key)</span></label>
            <input
              className="mcc-input mcc-input--mono"
              value={idTouched ? id : effectiveKey}
              onChange={(e) => { setId(e.target.value); setIdTouched(true); }}
              placeholder="auto-derived"
            />
          </div>
          <div className="mcc-field">
            <label className="mcc-label">Emoji <span className="mcc-hint">(optional)</span></label>
            <input
              className="mcc-input mcc-input--emoji"
              value={emoji}
              onChange={(e) => setEmoji(e.target.value)}
            />
          </div>
          <div className="mcc-field">
            <label className="mcc-label">Discord Channel ID <span className="mcc-required">*</span></label>
            <input
              className="mcc-input mcc-input--mono"
              value={discordChannelId}
              onChange={(e) => setDiscordChannelId(e.target.value)}
              placeholder="e.g. 1000000000000000001"
            />
          </div>
          <div className="mcc-field">
            <label className="mcc-label">Role <span className="mcc-hint">(optional)</span></label>
            <input
              className="mcc-input"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder="e.g. Research & Intelligence"
            />
          </div>
          <div className="mcc-field">
            <label className="mcc-label">Agent Dir <span className="mcc-hint">(optional)</span></label>
            <input
              className="mcc-input mcc-input--mono"
              value={agentDir}
              onChange={(e) => setAgentDir(e.target.value)}
              placeholder="e.g. agents/research"
            />
          </div>
          {errors.length > 0 && name.trim() && (
            <div className="mcc-modal-errors">
              {errors.map((e, i) => <div key={i}>{e}</div>)}
            </div>
          )}
        </div>
        <div className="mcc-modal-footer">
          <button className="mcc-btn" onClick={onClose}>Cancel</button>
          <button className="mcc-btn mcc-btn--primary" onClick={handleSubmit} disabled={errors.length > 0}>Add Agent</button>
        </div>
      </div>
    </div>
  );
}

// ── Add Channel Modal ───────────────────────────────────────────────────────

function AddChannelModal({ existingNames, onAdd, onClose }: {
  existingNames: Set<string>;
  onAdd: (name: string, channelId: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [channelId, setChannelId] = useState("");

  const derivedName = name.trim().toLowerCase().replace(/^#/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  const errors: string[] = [];
  if (!derivedName) errors.push("Channel name is required");
  if (existingNames.has(derivedName)) errors.push(`Channel "${derivedName}" already exists`);
  if (!channelId.trim()) errors.push("Discord Channel ID is required");
  else if (!isSnowflake(channelId)) errors.push("Discord Channel ID must be a numeric snowflake");

  function handleSubmit() {
    if (errors.length > 0) return;
    onAdd(derivedName, channelId.trim());
  }

  return (
    <div className="mcc-modal-overlay" onClick={onClose}>
      <div className="mcc-modal mcc-modal--sm" onClick={(e) => e.stopPropagation()}>
        <div className="mcc-modal-header">
          <h3>Add Shared Channel</h3>
          <button className="mcc-modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="mcc-modal-body">
          <div className="mcc-field">
            <label className="mcc-label">Channel Name <span className="mcc-required">*</span></label>
            <input
              className="mcc-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. my-channel"
              autoFocus
            />
            {derivedName && derivedName !== name.trim() && (
              <span className="mcc-field-hint">Will be saved as: #{derivedName}</span>
            )}
          </div>
          <div className="mcc-field">
            <label className="mcc-label">Discord Channel ID <span className="mcc-required">*</span></label>
            <input
              className="mcc-input mcc-input--mono"
              value={channelId}
              onChange={(e) => setChannelId(e.target.value)}
              placeholder="e.g. 1000000000000000002"
            />
          </div>
          {errors.length > 0 && name.trim() && (
            <div className="mcc-modal-errors">
              {errors.map((e, i) => <div key={i}>{e}</div>)}
            </div>
          )}
        </div>
        <div className="mcc-modal-footer">
          <button className="mcc-btn" onClick={onClose}>Cancel</button>
          <button className="mcc-btn mcc-btn--primary" onClick={handleSubmit} disabled={errors.length > 0}>Add Channel</button>
        </div>
      </div>
    </div>
  );
}

// ── Env var types ───────────────────────────────────────────────────────────

interface EnvVarStatus {
  key: string;
  category: string;
  description: string;
  required: boolean;
  isSet: boolean;
  preview: string;
  source: string;
}

interface GitIdentity {
  name: string;
  email: string;
  isSet: boolean;
}

const SERVICE_RESTART_LABELS: Record<string, string> = {
  gateway: "OpenClaw Gateway",
  "ops-bot": "Ops Bot",
  "openclaw-deck": "Deck",
};

// ── Main Page ───────────────────────────────────────────────────────────────

export default function DeckConfigPage() {
  const [config, setConfig] = useState<DeckConfig | null>(null);
  const [original, setOriginal] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [saveErrors, setSaveErrors] = useState<string[]>([]);
  const [showAddAgent, setShowAddAgent] = useState(false);
  const [showAddChannel, setShowAddChannel] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
  const [restartBanner, setRestartBanner] = useState<string[]>([]);
  const [restartingService, setRestartingService] = useState<string | null>(null);
  // Alert routing state (hoisted from alerts tab IIFE so hooks are top-level)
  const [alertPlatforms, setAlertPlatforms] = useState<Array<{ id: string; label: string; available: boolean }>>([]);
  const [alertResolvingChannel, setAlertResolvingChannel] = useState(false);
  const [alertNewChannelId, setAlertNewChannelId] = useState("");
  const [alertResolveError, setAlertResolveError] = useState("");
  // Hash-synced tabs: #edit.agents, #edit.sentinel, #source.agents-json, etc.
  type ViewMode = "edit" | "source";
  type EditTab = "agents" | "channels" | "infra" | "sentinel" | "dashboard" | "budgets" | "providers" | "replay" | "alerts";
  type SourceTab = "config/deck-agents.json" | "config/deck-config.json" | "sentinel/deck-sentinel.json";

  const EDIT_TABS: EditTab[] = ["budgets", "alerts", "agents", "channels", "providers", "infra", "sentinel", "dashboard", "replay"];
  const SOURCE_MAP: Record<string, SourceTab> = {
    "agents-json": "config/deck-agents.json",
    "config-json": "config/deck-config.json",
    "sentinel-json": "sentinel/deck-sentinel.json",
  };
  const SOURCE_MAP_REV: Record<string, string> = Object.fromEntries(
    Object.entries(SOURCE_MAP).map(([k, v]) => [v, k])
  );

  function parseHash(): { vm: ViewMode; et: EditTab; st: SourceTab; field?: string } {
    if (typeof window === "undefined") return { vm: "edit", et: "budgets", st: "config/deck-config.json" };
    const h = window.location.hash.slice(1);
    const [first, second, ...rest] = h.split(".");
    const vm: ViewMode = first === "source" ? "source" : "edit";
    const et: EditTab = EDIT_TABS.includes(second as EditTab) ? (second as EditTab) : "budgets";
    const st: SourceTab = SOURCE_MAP[second] ?? "config/deck-config.json";
    const field = rest.length ? rest.join(".") : undefined;
    return { vm, et, st, field };
  }

  const initial = parseHash();
  const [viewMode, setViewModeRaw] = useState<ViewMode>(initial.vm);
  const [activeTab, setActiveTabRaw] = useState<EditTab>(initial.et);
  const [sourceTab, setSourceTabRaw] = useState<SourceTab>(initial.st);

  function updateHash(vm: ViewMode, et: EditTab, st: SourceTab) {
    const sub = vm === "source" ? SOURCE_MAP_REV[st] || "agents-json" : et;
    history.replaceState(null, "", `#${vm}.${sub}`);
  }
  function setViewMode(vm: ViewMode) { setViewModeRaw(vm); updateHash(vm, activeTab, sourceTab); }
  function setActiveTab(et: EditTab) { setActiveTabRaw(et); updateHash(viewMode, et, sourceTab); }
  function setSourceTab(st: SourceTab) { setSourceTabRaw(st); updateHash(viewMode, activeTab, st); }

  // Sync from external hash changes (back/forward)
  useEffect(() => {
    const handler = () => {
      const { vm, et, st, field } = parseHash();
      setViewModeRaw(vm);
      setActiveTabRaw(et);
      setSourceTabRaw(st);
      if (field) scrollToField(field);
    };
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  // Scroll to a specific config field and highlight it
  function scrollToField(fieldId: string) {
    // Retry — element may not exist yet (async config fetch + conditional tab render)
    let attempt = 0;
    const tryScroll = () => {
      const el = document.getElementById(`cfg-${fieldId}`);
      if (!el) {
        if (attempt++ < 20) setTimeout(tryScroll, 250);
        return;
      }
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("mcc-highlight");
      setTimeout(() => el.classList.remove("mcc-highlight"), 6000);
    };
    setTimeout(tryScroll, 100);
  }

  // On initial load, scroll to field if specified in hash
  useEffect(() => {
    const { field } = parseHash();
    if (field) scrollToField(field);
  }, []);

  // Auto-dismiss toast
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);
  const [envVars, setEnvVars] = useState<EnvVarStatus[]>([]);
  const [gitIdentity, setGitIdentity] = useState<Record<string, GitIdentity>>({});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [sentinelConfig, setSentinelConfig] = useState<Record<string, any> | null>(null);
  const [sentinelOriginal, setSentinelOriginal] = useState<string>("");
  const [sentinelSaveStatus, setSentinelSaveStatus] = useState<SaveStatus>("idle");
  const [sentinelSaveErrors, setSentinelSaveErrors] = useState<string[]>([]);

  // Source tab state
  interface GitCommit { sha: string; short: string; date: string; message: string; }
  interface DiffLine { type: "add" | "del" | "ctx" | "hdr"; content: string; oldLine?: number; newLine?: number; }
  const sourceRepo = sourceTab.startsWith("sentinel/") ? "" : "mc"; // sentinel is in workspace repo
  const [jsonContent, setJsonContent] = useState("");
  const [jsonOriginal, setJsonOriginal] = useState("");
  const [jsonCommits, setJsonCommits] = useState<GitCommit[]>([]);
  const [jsonPreviewSha, setJsonPreviewSha] = useState<string | null>(null);
  const [jsonPreviewLabel, setJsonPreviewLabel] = useState("");
  const [jsonShowDiff, setJsonShowDiff] = useState(false);
  const [jsonDiffFrom, setJsonDiffFrom] = useState("");
  const [jsonDiffTo, setJsonDiffTo] = useState("working");
  const [jsonDiffLines, setJsonDiffLines] = useState<DiffLine[]>([]);
  const [jsonDiffLoading, setJsonDiffLoading] = useState(false);
  const [jsonConfirmRestore, setJsonConfirmRestore] = useState(false);
  const [jsonRestoreStatus, setJsonRestoreStatus] = useState<"idle" | "restoring" | "restored">("idle");

  const loadConfig = useCallback(() => {
    fetch("/api/deck-config")
      .then((r) => r.json())
      .then((data) => {
        setConfig(data);
        setOriginal(JSON.stringify({ agents: data.agents, systemChannels: data.systemChannels, pluginChannels: data.pluginChannels, logChannels: data.logChannels, serviceUrls: data.serviceUrls, dashboard: data.dashboard ?? {}, opsBotCommands: data.opsBotCommands, budgets: data.budgets ?? {}, modelPricing: data.modelPricing ?? {}, throttleChain: data.throttleChain ?? [], providerKeys: data.providerKeys ?? {}, providerLimits: data.providerLimits ?? {}, providerCalibration: data.providerCalibration ?? {}, sessionGuardrails: data.sessionGuardrails ?? data.replayAlerts ?? {}, replayUI: data.replayUI ?? {} }));
        setSaveStatus("idle");
        setSaveErrors([]);
      })
      .catch((e) => setError(e.message));
    fetch("/api/deck-config/env")
      .then((r) => r.json())
      .then((data) => {
        setEnvVars(data.vars ?? []);
        if (data.git) setGitIdentity(data.git);
      })
      .catch(() => {});
    fetch("/api/sentinel-config")
      .then((r) => r.json())
      .then((data) => {
        if (data.ok === false) return; // 404
        setSentinelConfig(data);
        setSentinelOriginal(JSON.stringify(data));
        setSentinelSaveStatus("idle");
        setSentinelSaveErrors([]);
      })
      .catch(() => {});
  }, []);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  // Load raw file content and git history for JSON tab
  useEffect(() => {
    if (viewMode !== "source") return;
    fetch(`/api/deck-config/raw?file=${encodeURIComponent(sourceTab)}`)
      .then(r => r.json())
      .then(data => {
        if (data.ok) {
          const formatted = JSON.stringify(JSON.parse(data.content), null, 2);
          setJsonContent(formatted);
          setJsonOriginal(formatted);
          setJsonPreviewSha(null);
          setJsonPreviewLabel("");
          setJsonShowDiff(false);
          setJsonConfirmRestore(false);
        }
      })
      .catch(() => {});
    fetch(`/api/git-file?action=log&file=${encodeURIComponent(sourceTab)}${sourceRepo ? `&repo=${sourceRepo}` : ""}&limit=50`)
      .then(r => r.json())
      .then(data => {
        if (data.ok && data.commits?.length) {
          setJsonCommits(data.commits);
          setJsonDiffFrom(data.commits[0].sha);
        } else {
          setJsonCommits([]);
        }
      })
      .catch(() => setJsonCommits([]));
  }, [viewMode, sourceTab, sourceRepo]);

  // Load diff for JSON tab
  useEffect(() => {
    if (!jsonShowDiff || !jsonDiffFrom) { setJsonDiffLines([]); return; }
    setJsonDiffLoading(true);
    const toParam = jsonDiffTo === "working" ? "" : `&to=${jsonDiffTo}`;
    fetch(`/api/git-file?action=diff&file=${encodeURIComponent(sourceTab)}${sourceRepo ? `&repo=${sourceRepo}` : ""}&from=${jsonDiffFrom}${toParam}`)
      .then(r => r.json())
      .then(data => { if (data.ok) setJsonDiffLines(data.lines ?? []); })
      .catch(() => setJsonDiffLines([]))
      .finally(() => setJsonDiffLoading(false));
  }, [jsonShowDiff, jsonDiffFrom, jsonDiffTo, sourceTab, sourceRepo]);

  // Fetch alert platforms on mount (hoisted from alerts tab)
  useEffect(() => {
    fetch("/api/alert-platforms")
      .then((r) => r.json())
      .then((d) => {
        setAlertPlatforms(d.platforms ?? []);
      })
      .catch(() => {});
  }, []);

  function jsonRelativeTime(ts: string): string {
    const ms = Date.now() - new Date(ts).getTime();
    if (ms < 60_000) return "just now";
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
    if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
    return `${Math.floor(ms / 86_400_000)}d ago`;
  }

  async function jsonPreview(sha: string, label: string) {
    try {
      const res = await fetch(`/api/git-file?action=show&file=${encodeURIComponent(sourceTab)}${sourceRepo ? `&repo=${sourceRepo}` : ""}&sha=${sha}`);
      const data = await res.json();
      if (data.ok) {
        try { setJsonContent(JSON.stringify(JSON.parse(data.content), null, 2)); } catch { setJsonContent(data.content); }
        setJsonPreviewSha(sha);
        setJsonPreviewLabel(label);
        setJsonShowDiff(false);
        setJsonConfirmRestore(false);
      }
    } catch {}
  }

  function jsonDiscard() {
    setJsonContent(jsonOriginal);
    setJsonPreviewSha(null);
    setJsonPreviewLabel("");
    setJsonShowDiff(false);
    setJsonConfirmRestore(false);
  }

  async function jsonRestore() {
    setJsonRestoreStatus("restoring");
    try {
      const res = await fetch("/api/deck-config/raw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: sourceTab, content: jsonContent }),
      });
      const data = await res.json();
      if (data.ok) {
        setJsonOriginal(jsonContent);
        setJsonPreviewSha(null);
        setJsonPreviewLabel("");
        setJsonRestoreStatus("restored");
        setToast({ message: `Restored ${sourceTab.split("/").pop()}`, type: "success" });
        loadConfig(); // reload form state too
        setTimeout(() => setJsonRestoreStatus("idle"), 2000);
      } else {
        setToast({ message: `Restore failed: ${data.error || "Unknown error"}`, type: "error" });
        setJsonRestoreStatus("idle");
      }
    } catch (e) {
      setToast({ message: `Restore failed: ${e instanceof Error ? e.message : e}`, type: "error" });
      setJsonRestoreStatus("idle");
    }
    setJsonConfirmRestore(false);
  }

  if (error) return <div className="mcc-page"><p style={{ color: "#ef4444" }}>Error: {error}</p></div>;
  if (!config) return <div className="mcc-page"><p style={{ color: "var(--text-muted)" }}>Loading...</p></div>;

  const cfgAny = config as unknown as Record<string, unknown>;
  const currentJson = JSON.stringify({ agents: config.agents, systemChannels: config.systemChannels, pluginChannels: config.pluginChannels, logChannels: config.logChannels, serviceUrls: config.serviceUrls, dashboard: config.dashboard ?? {}, opsBotCommands: config.opsBotCommands, budgets: cfgAny.budgets ?? {}, modelPricing: cfgAny.modelPricing ?? {}, throttleChain: cfgAny.throttleChain ?? [], providerKeys: cfgAny.providerKeys ?? {}, providerLimits: cfgAny.providerLimits ?? {}, providerCalibration: cfgAny.providerCalibration ?? {}, sessionGuardrails: cfgAny.sessionGuardrails ?? {}, replayUI: cfgAny.replayUI ?? {} });
  const isDirty = currentJson !== original;

  // Client-side validation
  const clientErrors: string[] = [];
  for (const a of config.agents) {
    const label = a.key || `new-agent-${config.agents.indexOf(a)}`;
    if (!a.key.trim()) clientErrors.push(`${label}: key is empty`);
    if (!a.name.trim()) clientErrors.push(`${label}: name is empty`);
    if (!a.emoji.trim()) clientErrors.push(`${label}: emoji is empty`);
    if (!a.id.trim()) clientErrors.push(`${label}: id is empty`);
    if (a.discordChannelId && !isSnowflake(a.discordChannelId)) clientErrors.push(`${label}: invalid channel ID`);
    if (!a.discordChannelId.trim()) clientErrors.push(`${label}: channel ID is empty`);
  }
  // Locked channel sections: warn if empty but don't block save
  const channelWarnings: string[] = [];
  for (const section of ["systemChannels", "pluginChannels"] as const) {
    for (const [name, id] of Object.entries(config[section])) {
      if (!id.trim()) {
        channelWarnings.push(`#${name.replace(/([A-Z])/g, "-$1").toLowerCase()}`);
      } else if (!isValidChannelId(id)) {
        clientErrors.push(`${section} #${name}: invalid channel ID (use discord:ID, slack:ID, or telegram:ID)`);
      }
    }
  }
  // Log channels: must have valid IDs
  for (const [name, id] of Object.entries(config.logChannels)) {
    if (!id.trim() || !isValidChannelId(id)) clientErrors.push(`Log #${name}: invalid channel ID`);
  }
  // Service URLs: must be valid http(s) URLs if non-empty
  for (const [name, url] of Object.entries(config.serviceUrls ?? {})) {
    if (url && url.trim() && !/^https?:\/\/.+/.test(url.trim())) {
      clientErrors.push(`Service URL "${name}": must start with http:// or https://`);
    }
  }

  const canSave = isDirty && clientErrors.length === 0;

  function updateAgent(idx: number, field: keyof AgentEntry, value: string) {
    if (!config) return;
    const agents = [...config.agents];
    agents[idx] = { ...agents[idx], [field]: value };
    setConfig({ ...config, agents });
    setSaveStatus("idle");
  }

  function addAgent(agent: AgentEntry) {
    if (!config) return;
    setConfig({ ...config, agents: [...config.agents, agent] });
    setSaveStatus("idle");
    setShowAddAgent(false);
  }

  function deleteAgent(idx: number) {
    if (!config || config.agents.length <= 1) return;
    const name = config.agents[idx]?.name || "this agent";
    if (!window.confirm(`Remove ${name}? This won't take effect until you Save.`)) return;
    const agents = config.agents.filter((_, i) => i !== idx);
    setConfig({ ...config, agents });
    setSaveStatus("idle");
  }

  function updateChannel(section: ChannelSection, key: string, value: string) {
    if (!config) return;
    setConfig({ ...config, [section]: { ...config[section], [key]: value } });
    setSaveStatus("idle");
  }

  function updateServiceUrl(key: string, value: string) {
    if (!config) return;
    setConfig({ ...config, serviceUrls: { ...config.serviceUrls, [key]: value } });
    setSaveStatus("idle");
  }

  function addLogChannel(name: string, channelId: string) {
    if (!config) return;
    setConfig({ ...config, logChannels: { ...config.logChannels, [name]: channelId } });
    setSaveStatus("idle");
    setShowAddChannel(false);
  }

  function deleteLogChannel(key: string) {
    if (!config) return;
    const rest = Object.fromEntries(Object.entries(config.logChannels).filter(([k]) => k !== key));
    setConfig({ ...config, logChannels: rest });
    setSaveStatus("idle");
  }

  function handleDiscard() {
    loadConfig();
  }

  async function handleSave() {
    if (!config) return;
    setSaveStatus("saving");
    setSaveErrors([]);
    try {
      const res = await fetch("/api/deck-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agents: config.agents,
          systemChannels: config.systemChannels,
          pluginChannels: config.pluginChannels,
          logChannels: config.logChannels,
          serviceUrls: config.serviceUrls,
          dashboard: config.dashboard,
          opsBotCommands: config.opsBotCommands,
          budgets: (config as unknown as Record<string, unknown>).budgets ?? {},
          modelPricing: (config as unknown as Record<string, unknown>).modelPricing ?? {},
          throttleChain: (config as unknown as Record<string, unknown>).throttleChain ?? [],
          providerKeys: (config as unknown as Record<string, unknown>).providerKeys ?? {},
          providerLimits: (config as unknown as Record<string, unknown>).providerLimits ?? {},
          providerCalibration: (config as unknown as Record<string, unknown>).providerCalibration ?? {},
          sessionGuardrails: (config as unknown as Record<string, unknown>).sessionGuardrails ?? {},
          replayUI: (config as unknown as Record<string, unknown>).replayUI ?? {},
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setSaveStatus("saved");
        setOriginal(JSON.stringify({ agents: config.agents, systemChannels: config.systemChannels, pluginChannels: config.pluginChannels, logChannels: config.logChannels, serviceUrls: config.serviceUrls, dashboard: config.dashboard ?? {}, opsBotCommands: config.opsBotCommands, budgets: (config as unknown as Record<string, unknown>).budgets ?? {}, modelPricing: (config as unknown as Record<string, unknown>).modelPricing ?? {}, throttleChain: (config as unknown as Record<string, unknown>).throttleChain ?? [], providerKeys: (config as unknown as Record<string, unknown>).providerKeys ?? {}, providerLimits: (config as unknown as Record<string, unknown>).providerLimits ?? {}, providerCalibration: (config as unknown as Record<string, unknown>).providerCalibration ?? {}, sessionGuardrails: (config as unknown as Record<string, unknown>).sessionGuardrails ?? {}, replayUI: (config as unknown as Record<string, unknown>).replayUI ?? {} }));
        // Show restart banner if services need restarting
        const restarts: string[] = data.restarts || [];
        if (restarts.length > 0) {
          setRestartBanner(restarts);
          setToast({ message: "Config saved — some services need a restart", type: "success" });
        } else {
          setRestartBanner([]);
          setToast({ message: "Config saved successfully", type: "success" });
        }
        setTimeout(() => setSaveStatus("idle"), 2000);
      } else {
        setSaveStatus("error");
        setSaveErrors(data.errors || ["Save failed"]);
        setToast({ message: `Save failed: ${(data.errors || ["Unknown error"]).join(", ")}`, type: "error" });
      }
    } catch (e) {
      setSaveStatus("error");
      const msg = e instanceof Error ? e.message : String(e);
      setSaveErrors([msg]);
      setToast({ message: `Save failed: ${msg}`, type: "error" });
    }
  }

  // ── Ops-bot command helpers ──────────────────────────────────────────────
  function updateOpsBotCommand(cmd: string, enabled: boolean) {
    if (!config) return;
    setConfig({ ...config, opsBotCommands: { ...config.opsBotCommands, [cmd]: enabled } });
    setSaveStatus("idle");
  }

  // ── Sentinel helpers ──────────────────────────────────────────────────────
  const sentinelDirty = sentinelConfig ? JSON.stringify(sentinelConfig) !== sentinelOriginal : false;

  function updateSentinelCheck(checkName: string, field: string, value: unknown) {
    if (!sentinelConfig) return;
    const checks = { ...sentinelConfig.checks };
    checks[checkName] = { ...checks[checkName], [field]: value };
    setSentinelConfig({ ...sentinelConfig, checks });
    setSentinelSaveStatus("idle");
  }

  function updateSentinelTopLevel(key: string, value: unknown) {
    if (!sentinelConfig) return;
    setSentinelConfig({ ...sentinelConfig, [key]: value });
    setSentinelSaveStatus("idle");
  }

  async function handleSentinelSave() {
    if (!sentinelConfig) return;
    setSentinelSaveStatus("saving");
    setSentinelSaveErrors([]);
    try {
      const res = await fetch("/api/sentinel-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sentinelConfig),
      });
      const data = await res.json();
      if (data.ok) {
        setSentinelSaveStatus("saved");
        setSentinelOriginal(JSON.stringify(sentinelConfig));
        setToast({ message: "Sentinel config saved. Changes take effect next loop cycle.", type: "success" });
        setTimeout(() => setSentinelSaveStatus("idle"), 2000);
      } else {
        setSentinelSaveStatus("error");
        setSentinelSaveErrors(data.errors || ["Save failed"]);
        setToast({ message: `Sentinel save failed: ${(data.errors || ["Unknown error"]).join(", ")}`, type: "error" });
      }
    } catch (e) {
      setSentinelSaveStatus("error");
      const msg = e instanceof Error ? e.message : String(e);
      setSentinelSaveErrors([msg]);
      setToast({ message: `Sentinel save failed: ${msg}`, type: "error" });
    }
  }

  function handleSentinelDiscard() {
    if (!sentinelOriginal) return;
    setSentinelConfig(JSON.parse(sentinelOriginal));
    setSentinelSaveStatus("idle");
    setSentinelSaveErrors([]);
  }

  // ── Service restart from banner ────────────────────────────────────────
  async function handleRestartService(svc: string) {
    const labelMap: Record<string, string> = {
      gateway: "ai.openclaw.gateway",
      "ops-bot": "ai.openclaw.ops-bot",
      deck: "ai.openclaw.deck",
      sentinel: "ai.openclaw.sentinel",
    };
    setRestartingService(svc);
    try {
      const res = await fetch("/api/service-control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: labelMap[svc] || svc, action: "restart" }),
      });
      const data = await res.json();
      if (data.ok) {
        setToast({ message: `${SERVICE_RESTART_LABELS[svc] || svc} restarted`, type: "success" });
        setRestartBanner((prev) => prev.filter((s) => s !== svc));
        window.dispatchEvent(new Event("gateway-changed"));
      } else {
        setToast({ message: `Restart failed: ${data.output || data.error}`, type: "error" });
      }
    } catch (e) {
      setToast({ message: `Restart failed: ${e instanceof Error ? e.message : e}`, type: "error" });
    } finally {
      setRestartingService(null);
    }
  }

  const existingAgentKeys = new Set(config.agents.map((a) => a.key));
  const existingChannelNames = new Set([
    ...Object.keys(config.systemChannels),
    ...Object.keys(config.pluginChannels),
    ...Object.keys(config.logChannels),
  ]);

  const mcTab = viewMode === "edit" && activeTab !== "sentinel" && activeTab !== "dashboard";

  return (
    <div className="mcc-page">
      <div className="mcc-header">
        <h2>Deck Config</h2>
        <p className="mcc-subtitle">Dashboard configuration &mdash; agents, channels &amp; services</p>
      </div>

      {/* View mode toggle */}
      <div className="cfg-toolbar" style={{ marginBottom: 0 }}>
        <div className="ds-tabs" style={{ marginBottom: 0 }}>
          <button className={`ds-tab${viewMode === "edit" ? " active" : ""}`} onClick={() => setViewMode("edit")}>Edit</button>
          <button className={`ds-tab${viewMode === "source" ? " active" : ""}`} onClick={() => setViewMode("source")}>Source</button>
        </div>
      </div>

      {/* Edit sub-tabs */}
      {viewMode === "edit" && (
        <div className="ds-tabs">
          {([
            { id: "budgets" as const, label: "Budgets" },
            { id: "alerts" as const, label: "Alerts" },
            { id: "agents" as const, label: "Agents" },
            { id: "channels" as const, label: "Channels" },
            { id: "providers" as const, label: "Providers" },
            { id: "infra" as const, label: "Infrastructure" },
            { id: "sentinel" as const, label: "Sentinel" },
            { id: "dashboard" as const, label: "Dashboard" },
            { id: "replay" as const, label: "Replay" },
          ]).map((t) => (
            <button
              key={t.id}
              className={`ds-tab${activeTab === t.id ? " active" : ""}`}
              onClick={() => setActiveTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {/* Source sub-tabs */}
      {viewMode === "source" && (
        <div className="ds-tabs">
          {([
            { id: "config/deck-agents.json" as const, label: "deck-agents.json" },
            { id: "config/deck-config.json" as const, label: "deck-config.json" },
            { id: "sentinel/deck-sentinel.json" as const, label: "deck-sentinel.json" },
          ]).map((t) => (
            <button
              key={t.id}
              className={`ds-tab${sourceTab === t.id ? " active" : ""}`}
              onClick={() => setSourceTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {/* Deck config toolbar (tabs 1–3) */}
      {mcTab && (
        <div className="mcc-toolbar">
          <div className="mcc-status">
            {clientErrors.length > 0 && (
              <span className="mcc-status-badge mcc-status-badge--error">{clientErrors.length} validation error{clientErrors.length > 1 ? "s" : ""}</span>
            )}
            {isDirty && clientErrors.length === 0 && (
              <span className="mcc-status-badge mcc-status-badge--dirty">Unsaved changes</span>
            )}
            {saveStatus === "saved" && (
              <span className="mcc-status-badge mcc-status-badge--ok">Saved</span>
            )}
          </div>
          {isDirty && (
            <div className="mcc-actions">
              <button className="mcc-btn" onClick={handleDiscard}>Discard</button>
              <button className="mcc-btn mcc-btn--primary" onClick={handleSave} disabled={clientErrors.length > 0 || saveStatus === "saving"}>
                {saveStatus === "saving" ? "Saving..." : "Save"}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Deck save errors (tabs 1–3) */}
      {mcTab && saveErrors.length > 0 && (
        <div className="mcc-error-bar">
          {saveErrors.map((e, i) => <div key={i}>{e}</div>)}
        </div>
      )}

      {/* Client validation errors (tabs 1–3) */}
      {mcTab && clientErrors.length > 0 && isDirty && (
        <div className="mcc-error-bar mcc-error-bar--warn">
          {clientErrors.map((e, i) => <div key={i}>{e}</div>)}
        </div>
      )}

      {/* Restart banner (any tab) */}
      {restartBanner.length > 0 && (
        <div className="mcc-restart-banner">
          <div className="mcc-restart-banner-text">
            <strong>Restart required:</strong> The following services need a restart for changes to take effect:
          </div>
          <div className="mcc-restart-banner-services">
            {restartBanner.map((svc) => {
              const label = SERVICE_RESTART_LABELS[svc] || svc;
              const restarting = restartingService === svc;
              const isGateway = svc === "gateway";
              return (
                <div key={svc} className="mcc-restart-banner-item">
                  <span>{label}</span>
                  {isGateway ? (
                    <button
                      className="mcc-btn mcc-btn--sm"
                      onClick={async () => {
                        setRestartingService(svc);
                        try {
                          const res = await fetch("/api/service-control", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ action: "apply-config-safely", reason: "Deck Config change" }),
                          });
                          const data = await res.json();
                          if (data.ok) {
                            setToast({ message: "Gateway restarted safely — healthy", type: "success" });
                            setRestartBanner((prev) => prev.filter((s) => s !== svc));
                          } else {
                            setToast({ message: data.rolledBack ? "Rolled back to last good config" : `Apply failed: ${data.error}`, type: "error" });
                          }
                          window.dispatchEvent(new Event("gateway-changed"));
                        } catch (e) {
                          setToast({ message: `Apply failed: ${e instanceof Error ? e.message : e}`, type: "error" });
                        } finally {
                          setRestartingService(null);
                        }
                      }}
                      disabled={!!restartingService}
                    >
                      {restarting ? "Applying..." : "Restart Safely"}
                    </button>
                  ) : (
                    <button
                      className="mcc-btn mcc-btn--sm"
                      onClick={() => handleRestartService(svc)}
                      disabled={!!restartingService}
                    >
                      {restarting ? "Restarting..." : "Restart"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <button
            className="mcc-restart-banner-dismiss"
            onClick={() => setRestartBanner([])}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════════
         TAB: Agents
         ════════════════════════════════════════════════════════════════════════ */}
      {viewMode === "edit" && activeTab === "agents" && (
        <>
          <div className="mcc-file-group">
            <div className="mcc-file-group-header">
              <code className="mcc-file-group-path">config/deck-agents.json</code>
            </div>
          </div>
          <div className="mcc-restart-note">Agent changes require a gateway restart to take effect.</div>

          <section className="mcc-section">
            <div className="mcc-section-header">
              <h3 className="mcc-section-title">Agents</h3>
              <button className="mcc-btn mcc-add-btn" onClick={() => setShowAddAgent(true)}>+ Add Agent</button>
            </div>
            <div className="mcc-table-wrap">
              <table className="mcc-table">
                <thead>
                  <tr>
                    <th>Emoji</th>
                    <th>Key</th>
                    <th>Name</th>
                    <th>ID</th>
                    <th>Role</th>
                    <th>Discord Channel ID</th>
                    <th>Agent Dir</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {config.agents.map((a, i) => (
                    <tr key={i} className="mcc-row">
                      <td data-label="Emoji">
                        <input
                          className={`mcc-input mcc-input--emoji${!a.emoji.trim() ? " mcc-input--error" : ""}`}
                          value={a.emoji}
                          onChange={(e) => updateAgent(i, "emoji", e.target.value)}
                        />
                      </td>
                      <td data-label="Key">
                        <input
                          className={`mcc-input mcc-input--sm${!a.key.trim() ? " mcc-input--error" : ""}`}
                          value={a.key}
                          onChange={(e) => updateAgent(i, "key", e.target.value)}
                          placeholder="key"
                        />
                      </td>
                      <td data-label="Name">
                        <input
                          className={`mcc-input${!a.name.trim() ? " mcc-input--error" : ""}`}
                          value={a.name}
                          onChange={(e) => updateAgent(i, "name", e.target.value)}
                          placeholder="Name"
                        />
                      </td>
                      <td data-label="ID">
                        <input
                          className={`mcc-input mcc-input--sm${!a.id.trim() ? " mcc-input--error" : ""}`}
                          value={a.id}
                          onChange={(e) => updateAgent(i, "id", e.target.value)}
                          placeholder="id"
                        />
                      </td>
                      <td data-label="Role">
                        <input
                          className="mcc-input"
                          value={a.role}
                          onChange={(e) => updateAgent(i, "role", e.target.value)}
                          placeholder="Role"
                        />
                      </td>
                      <td data-label="Channel ID" style={{ gridColumn: "1 / -1" }}>
                        <input
                          className={`mcc-input mcc-input--mono${!a.discordChannelId.trim() || !isSnowflake(a.discordChannelId) ? " mcc-input--error" : ""}`}
                          value={a.discordChannelId}
                          onChange={(e) => updateAgent(i, "discordChannelId", e.target.value)}
                          placeholder="Channel ID"
                        />
                      </td>
                      <td data-label="Agent Dir" style={{ gridColumn: "1 / -1" }}>
                        <input
                          className="mcc-input mcc-input--mono"
                          value={a.agentDir}
                          onChange={(e) => updateAgent(i, "agentDir", e.target.value)}
                          placeholder="(workspace root)"
                        />
                      </td>
                      <td className="mcc-delete-cell">
                        <button
                          className="mcc-btn mcc-btn--danger mcc-btn--sm"
                          onClick={() => deleteAgent(i)}
                          disabled={config.agents.length <= 1}
                          title={config.agents.length <= 1 ? "At least one agent required" : `Remove ${a.name || "agent"}`}
                        >Delete</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {/* ════════════════════════════════════════════════════════════════════════
         TAB: Channels
         ════════════════════════════════════════════════════════════════════════ */}
      {viewMode === "edit" && activeTab === "channels" && (
        <>
          <div className="mcc-file-group">
            <div className="mcc-file-group-header">
              <code className="mcc-file-group-path">config/deck-agents.json</code>
            </div>
          </div>
          <div className="mcc-restart-note">Channel changes require a gateway restart to take effect.</div>

          {/* Channel warning */}
          {channelWarnings.length > 0 && (
            <div className="mcc-warning-bar">
              Missing channel IDs: {channelWarnings.join(", ")} &mdash; Notifications will not work until configured.
            </div>
          )}

          {/* Locked channel sections (system, task, plugin) */}
          {([
            { key: "systemChannels" as const, title: "System Channels", note: "Gateway status & monitoring" },
            { key: "pluginChannels" as const, title: "Plugin Channels", note: "Drift alerts & agent messaging" },
          ]).map(({ key, title, note }) => (
            <section key={key} className="mcc-section">
              <div className="mcc-section-header">
                <h3 className="mcc-section-title">{title}</h3>
                <span className="mcc-section-note">{note} &mdash; cannot be removed</span>
              </div>
              <div className="mcc-table-wrap">
                <table className="mcc-table mcc-table--kv">
                  <thead>
                    <tr>
                      <th>Channel</th>
                      <th>ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(config[key]).map(([name, id]) => (
                      <tr key={name} className="mcc-row">
                        <td data-label="Channel" className="mcc-channel-name">#{name.replace(/([A-Z])/g, "-$1").toLowerCase()}</td>
                        <td data-label="ID">
                          <input
                            className={`mcc-input mcc-input--mono${id.trim() && !isValidChannelId(id) ? " mcc-input--error" : ""}${!id.trim() ? " mcc-input--warn" : ""}`}
                            value={id}
                            onChange={(e) => updateChannel(key, name, e.target.value)}
                            placeholder="discord:123… or slack:C0ABC… or telegram:-100…"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}

          {/* Log Channels (user-managed, add/remove allowed) */}
          <section className="mcc-section">
            <div className="mcc-section-header">
              <h3 className="mcc-section-title">Log Channels</h3>
              <button className="mcc-btn mcc-add-btn" onClick={() => setShowAddChannel(true)}>+ Add Channel</button>
            </div>
            <span className="mcc-section-note" style={{ marginTop: -8, marginBottom: 8, display: "block" }}>Channel name resolution for logs &mdash; can be added or removed</span>
            <div className="mcc-table-wrap">
              <table className="mcc-table mcc-table--kv">
                <thead>
                  <tr>
                    <th style={{ width: 30 }}></th>
                    <th>Channel</th>
                    <th>ID</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(config.logChannels).map(([name, id]) => (
                    <tr key={name} className="mcc-row">
                      <td>
                        <button className="mcc-delete-btn" onClick={() => deleteLogChannel(name)} title={`Remove #${name}`}>&times;</button>
                      </td>
                      <td data-label="Channel" className="mcc-channel-name">#{name}</td>
                      <td data-label="ID">
                        <input
                          className={`mcc-input mcc-input--mono${!id.trim() || !isSnowflake(id) ? " mcc-input--error" : ""}`}
                          value={id}
                          onChange={(e) => updateChannel("logChannels", name, e.target.value)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {/* ════════════════════════════════════════════════════════════════════════
         TAB: Infrastructure
         ════════════════════════════════════════════════════════════════════════ */}
      {viewMode === "edit" && activeTab === "infra" && (
        <>
          {/* Service URLs */}
          {config.serviceUrls && Object.keys(config.serviceUrls).length > 0 && (
            <>
              <div className="mcc-file-group">
                <div className="mcc-file-group-header">
                  <code className="mcc-file-group-path">config/deck-config.json</code>
                </div>
              </div>
              <section className="mcc-section">
                <div className="mcc-section-header">
                  <h3 className="mcc-section-title">Service URLs</h3>
                  <span className="mcc-section-note">Endpoints used by API routes &mdash; env vars override if set</span>
                </div>
                <div className="mcc-table-wrap">
                  <table className="mcc-table mcc-table--kv">
                    <thead>
                      <tr>
                        <th>Service</th>
                        <th>URL</th>
                        <th>Env Override</th>
                      </tr>
                    </thead>
                    <tbody>
                      {([
                        { key: "gateway", label: "Gateway (openclaw)", envVar: "OPENCLAW_GATEWAY_URL" },
                        { key: "deckDashboard", label: "Deck Dashboard", envVar: "DECK_URL" },
                      ] as const).map(({ key, label, envVar }) => (
                        <tr key={key} className="mcc-row">
                          <td data-label="Service" className="mcc-channel-name">{label}</td>
                          <td data-label="URL">
                            <input
                              className={`mcc-input mcc-input--mono${(config.serviceUrls[key] ?? "").trim() && !/^https?:\/\/.+/.test((config.serviceUrls[key] ?? "").trim()) ? " mcc-input--error" : ""}`}
                              value={config.serviceUrls[key] ?? ""}
                              onChange={(e) => updateServiceUrl(key, e.target.value)}
                              placeholder="http://localhost:..."
                            />
                          </td>
                          <td data-label="Env Override" className="mcc-env-desc"><code>{envVar}</code></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}

          {/* Ops Bot Commands */}
          {config.opsBotCommands && Object.keys(config.opsBotCommands).length > 0 && (
            <section className="mcc-section">
              <div className="mcc-section-header">
                <h3 className="mcc-section-title">Ops Bot Commands</h3>
                <span className="mcc-section-note">Discord bot command permissions &mdash; disabled commands reply &quot;Command disabled by admin&quot;</span>
              </div>
              <div className="mcc-restart-note">Changes take effect immediately &mdash; ops-bot reads permissions on every command.</div>
              <div className="mcc-check-grid">
                {([
                  { cmd: "status", label: "!status", desc: "Quick health check (gateway, config, services)" },
                  { cmd: "doctor", label: "!doctor", desc: "Run openclaw doctor diagnostics" },
                  { cmd: "openclaw-gw", label: "!openclaw-gw", desc: "Start / stop / restart the gateway" },
                  { cmd: "nextjs", label: "!nextjs", desc: "Manage Deck frontend service (status, start, stop, restart, logs)" },
                  { cmd: "ops-bot", label: "!ops-bot", desc: "Manage ops-bot itself (status, restart, logs)" },
                  { cmd: "restart-all", label: "!restart-all", desc: "Restart all Deck services", destructive: true },
                  { cmd: "revert-config", label: "!revert-config", desc: "Revert openclaw.json to last git commit", destructive: true },
                  { cmd: "help", label: "!help", desc: "Show help message" },
                ] as { cmd: string; label: string; desc: string; destructive?: boolean }[]).map(({ cmd, label, desc, destructive }) => {
                  const enabled = config.opsBotCommands[cmd] ?? false;
                  return (
                    <div key={cmd} className={`mcc-check-card${enabled ? "" : " mcc-check-card--disabled"}`}>
                      <div className="mcc-check-header">
                        <div>
                          <code style={{ fontSize: "13px", fontWeight: 700 }}>{label}</code>
                          {destructive && (
                            <span style={{
                              marginLeft: "8px",
                              fontSize: "10px",
                              fontWeight: 700,
                              color: "#f87171",
                              background: "rgba(239,68,68,0.12)",
                              border: "1px solid rgba(239,68,68,0.3)",
                              borderRadius: "4px",
                              padding: "1px 6px",
                              textTransform: "uppercase",
                            }}>destructive</span>
                          )}
                        </div>
                        <label className="mcc-toggle">
                          <input
                            type="checkbox"
                            checked={enabled}
                            onChange={(e) => updateOpsBotCommand(cmd, e.target.checked)}
                          />
                          <span className="mcc-toggle-slider" />
                        </label>
                      </div>
                      <p className="mcc-check-desc">{desc}</p>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Environment Variables — grouped by source file */}
          {envVars.length > 0 && (
            <div className="mcc-env-legend">
              <span className="mcc-env-legend-item"><span className="mcc-env-dot mcc-env-dot--ok" /> Set</span>
              <span className="mcc-env-legend-item"><span className="mcc-env-dot mcc-env-dot--error" /> Required, missing</span>
              <span className="mcc-env-legend-item"><span className="mcc-env-dot mcc-env-dot--warn" /> Optional, not set</span>
              <span className="mcc-env-legend-item"><span className="mcc-required">*</span> Required</span>
            </div>
          )}
          {(() => {
            const sources = [...new Set(envVars.map((v) => v.source))];
            const missingRequired = envVars.filter((v) => v.required && !v.isSet);
            return sources.map((source) => {
              const vars = envVars.filter((v) => v.source === source);
              if (vars.length === 0) return null;
              const categories = [...new Set(vars.map((v) => v.category))];
              const sourceMissing = missingRequired.filter((v) => v.source === source);
              return (
                <div key={source}>
                  <div className="mcc-file-group">
                    <div className="mcc-file-group-header">
                      <code className="mcc-file-group-path">{source}</code>
                      <span className="mcc-section-note">read-only</span>
                    </div>
                  </div>
                  <section className="mcc-section">
                    <div className="mcc-section-header">
                      <h3 className="mcc-section-title">Secrets &amp; Tokens</h3>
                      <span className="mcc-section-note">Set directly in <code>{source}</code></span>
                    </div>
                    {sourceMissing.length > 0 && (
                      <div className="mcc-warning-bar">
                        {sourceMissing.length} required variable{sourceMissing.length > 1 ? "s" : ""} not set: {sourceMissing.map((v) => v.key).join(", ")}
                      </div>
                    )}
                    {categories.map((cat) => (
                      <div key={cat} className="mcc-env-group">
                        <h4 className="mcc-env-category">{cat}</h4>
                        <div className="mcc-table-wrap">
                          <table className="mcc-table mcc-table--env">
                            <thead>
                              <tr>
                                <th>Variable</th>
                                <th>Status</th>
                                <th>Description</th>
                              </tr>
                            </thead>
                            <tbody>
                              {vars.filter((v) => v.category === cat).map((v) => (
                                <tr key={v.key} className="mcc-row">
                                  <td data-label="Variable" className="mcc-env-key">
                                    <code>{v.key}</code>
                                    {v.required && <span className="mcc-required"> *</span>}
                                  </td>
                                  <td data-label="Status">
                                    {v.isSet ? (
                                      <span className="mcc-env-set">
                                        <span className="mcc-env-dot mcc-env-dot--ok" />
                                        <code className="mcc-env-preview">{v.preview}</code>
                                      </span>
                                    ) : (
                                      <span className="mcc-env-set">
                                        <span className={`mcc-env-dot ${v.required ? "mcc-env-dot--error" : "mcc-env-dot--warn"}`} />
                                        <span className="mcc-env-notset">{v.required ? "Missing" : "Not set"}</span>
                                      </span>
                                    )}
                                  </td>
                                  <td data-label="Description" className="mcc-env-desc">{v.description}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    ))}
                  </section>
                </div>
              );
            });
          })()}

          {/* Git Identity */}
          {Object.keys(gitIdentity).length > 0 && (
            <section className="mcc-section">
              <div className="mcc-section-header">
                <h3 className="mcc-section-title">Git Identity</h3>
                <span className="mcc-section-note">Used for auto-committing config changes &mdash; run <code>git config user.name</code> / <code>git config user.email</code> to set</span>
              </div>
              <div className="mcc-table-wrap">
                <table className="mcc-table mcc-table--kv">
                  <thead>
                    <tr>
                      <th>Repo</th>
                      <th>Identity</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {([
                      { key: "workspace", label: "Workspace (hq)" },
                      { key: "deck-dashboard", label: "Deck Dashboard" },
                    ] as const).map(({ key, label }) => {
                      const git = gitIdentity[key];
                      if (!git) return null;
                      return (
                        <tr key={key} className="mcc-row">
                          <td data-label="Repo" className="mcc-channel-name">{label}</td>
                          <td data-label="Identity">
                            {git.isSet ? (
                              <code className="mcc-env-preview">{git.name} &lt;{git.email}&gt;</code>
                            ) : (
                              <span className="mcc-env-notset">Not configured</span>
                            )}
                          </td>
                          <td data-label="Status">
                            <span className="mcc-env-set">
                              <span className={`mcc-env-dot ${git.isSet ? "mcc-env-dot--ok" : "mcc-env-dot--error"}`} />
                              {git.isSet ? "Configured" : "Missing — commits will use bot identity"}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}

      {/* ════════════════════════════════════════════════════════════════════════
         TAB: Providers
         ════════════════════════════════════════════════════════════════════════ */}
      {viewMode === "edit" && activeTab === "providers" && (() => {
        const pricing = (config as unknown as Record<string, unknown>).modelPricing as Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> | undefined ?? {};
        const chain = ((config as unknown as Record<string, unknown>).throttleChain as string[] | undefined) ?? ["opus", "sonnet", "haiku"];
        const provLimits = ((config as unknown as Record<string, unknown>).providerLimits ?? {}) as Record<string, { windows: Array<Record<string, unknown>> }>;
        const provCalibration = (cfgAny.providerCalibration ?? {}) as Record<string, { lastUpdated: string; rawText: string; parsed: ParsedCalibration }>;
        const provKeys = ((config as unknown as Record<string, unknown>).providerKeys ?? {}) as Record<string, Record<string, string>>;

        const updatePricing = (key: string, field: string, value: number) => {
          const updated = { ...pricing, [key]: { ...(pricing[key] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), [field]: value } };
          setConfig({ ...config, modelPricing: updated } as typeof config);
          setSaveStatus("idle");
        };
        const removePricingRow = (key: string) => {
          const updated = Object.fromEntries(Object.entries(pricing).filter(([k]) => k !== key));
          setConfig({ ...config, modelPricing: updated } as typeof config);
          setSaveStatus("idle");
        };
        const updateProviderLimits = (updated: Record<string, { windows: Array<Record<string, unknown>> }>) => {
          setConfig({ ...config, providerLimits: updated } as typeof config);
          setSaveStatus("idle");
        };
        const updateProviderCalibration = (updated: typeof provCalibration) => {
          setConfig({ ...config, providerCalibration: updated } as typeof config);
          setSaveStatus("idle");
        };
        const updateProviderKey = (provider: string, keyName: string, value: string) => {
          const updated = { ...provKeys, [provider]: { ...provKeys[provider], [keyName]: value } };
          setConfig({ ...config, providerKeys: updated } as typeof config);
          setSaveStatus("idle");
        };

        return (
          <>
            <div className="mcc-file-group">
              <div className="mcc-file-group-header">
                <code className="mcc-file-group-path">config/deck-config.json</code>
              </div>
            </div>

            {/* Provider API Keys */}
            <section className="mcc-section">
              <div className="mcc-section-header">
                <h3 className="mcc-section-title">API Keys</h3>
                <span className="mcc-section-note">Admin/management keys for cost reconciliation. These are NOT your regular API keys.</span>
              </div>
              <div className="mcc-table-wrap">
                <table className="mcc-table mcc-table--kv">
                  <thead><tr><th>Provider</th><th>Key Type</th><th>Value</th></tr></thead>
                  <tbody>
                    <tr>
                      <td>OpenRouter</td>
                      <td>Management Key</td>
                      <td><input type="password" className="mcc-input" placeholder="sk-or-v1-..." value={provKeys.openrouter?.managementKey ?? ""} onChange={(e) => updateProviderKey("openrouter", "managementKey", e.target.value)} /></td>
                    </tr>
                    <tr>
                      <td>Anthropic</td>
                      <td>Admin Key</td>
                      <td><input type="password" className="mcc-input" placeholder="sk-ant-admin-..." value={provKeys.anthropic?.adminKey ?? ""} onChange={(e) => updateProviderKey("anthropic", "adminKey", e.target.value)} /></td>
                    </tr>
                    <tr>
                      <td>OpenAI</td>
                      <td>Admin Key</td>
                      <td><input type="password" className="mcc-input" placeholder="sk-admin-..." value={provKeys.openai?.adminKey ?? ""} onChange={(e) => updateProviderKey("openai", "adminKey", e.target.value)} /></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>

            {/* Model Pricing */}
            <section className="mcc-section">
              <div className="mcc-section-header">
                <h3 className="mcc-section-title">Model Pricing</h3>
                <span className="mcc-section-note">Cost per 1M tokens. Keys are substring-matched against model names.</span>
                <button className="mcc-btn mcc-add-btn" onClick={() => {
                  const key = prompt("Model substring (e.g. 'gemini', 'llama'):");
                  if (!key?.trim()) return;
                  updatePricing(key.trim().toLowerCase(), "input", 0);
                }}>+ Add Model</button>
              </div>
              <div className="mcc-table-wrap">
                <table className="mcc-table">
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th>Input $/1M</th>
                      <th>Output $/1M</th>
                      <th>Cache Read $/1M</th>
                      <th>Cache Write $/1M</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(pricing).map(([key, p]) => (
                      <tr key={key} className="mcc-row">
                        <td data-label="Model"><code>{key}</code></td>
                        {(["input", "output", "cacheRead", "cacheWrite"] as const).map((field) => (
                          <td key={field} data-label={field}>
                            <input
                              type="number"
                              className="mcc-input mcc-input--mono"
                              value={p[field]}
                              onChange={(e) => updatePricing(key, field, Number(e.target.value))}
                              min="0"
                              step="0.01"
                            />
                          </td>
                        ))}
                        <td>
                          <button className="mcc-btn mcc-btn--danger mcc-btn--sm" onClick={() => removePricingRow(key)}>
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            {/* Throttle Chain (collapsible) */}
            <details className="mcc-section mcc-collapsible">
              <summary>
                <div>
                  <h3 className="mcc-section-title">Throttle Chain</h3>
                  <span className="mcc-section-note">{chain.join(" → ")}</span>
                </div>
              </summary>
              <div className="mcc-collapsible-body">
                <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 8px" }}>Model downgrade path when budget is exceeded (most expensive → cheapest)</p>
                <div className="mcc-table-wrap">
                  <table className="mcc-table mcc-table--kv">
                    <thead><tr><th>#</th><th>Model Key</th><th></th></tr></thead>
                    <tbody>
                      {chain.map((key, i) => (
                        <tr key={i} className="mcc-row">
                          <td data-label="#">{i + 1}</td>
                          <td data-label="Model Key">
                            <input
                              className="mcc-input mcc-input--mono"
                              value={key}
                              onChange={(e) => {
                                const updated = [...chain];
                                updated[i] = e.target.value;
                                setConfig({ ...config, throttleChain: updated } as typeof config);
                                setSaveStatus("idle");
                              }}
                            />
                          </td>
                          <td>
                            <div style={{ display: "flex", gap: 4 }}>
                              {i > 0 && (
                                <button className="mcc-btn mcc-btn--sm" onClick={() => {
                                  const updated = [...chain];
                                  [updated[i - 1], updated[i]] = [updated[i], updated[i - 1]];
                                  setConfig({ ...config, throttleChain: updated } as typeof config);
                                  setSaveStatus("idle");
                                }}>↑</button>
                              )}
                              {i < chain.length - 1 && (
                                <button className="mcc-btn mcc-btn--sm" onClick={() => {
                                  const updated = [...chain];
                                  [updated[i], updated[i + 1]] = [updated[i + 1], updated[i]];
                                  setConfig({ ...config, throttleChain: updated } as typeof config);
                                  setSaveStatus("idle");
                                }}>↓</button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </details>

            {/* Provider Rate Limits */}
            <section className="mcc-section" id="cfg-providerLimits">
              <div className="mcc-section-header">
                <h3 className="mcc-section-title">Rate Limits</h3>
                <span className="mcc-section-note">Subscription provider usage limits. Windows define how each provider tracks usage.</span>
                <button className="mcc-btn mcc-add-btn" onClick={() => {
                  const key = prompt("Provider name (e.g. 'anthropic', 'openai'):");
                  if (!key?.trim()) return;
                  const k = key.trim().toLowerCase();
                  if (provLimits[k]) { alert(`${k} already exists`); return; }
                  updateProviderLimits({ ...provLimits, [k]: { windows: [] } });
                }}>+ Add Provider</button>
              </div>
              {Object.entries(provLimits).map(([provider, prov]) => (
                <div key={provider} className="mcc-subsection">
                  <div className="mcc-subsection-header">
                    <h4 className="mcc-subsection-title">{provider}</h4>
                    <button className="mcc-btn mcc-btn--danger mcc-btn--sm" onClick={() => {
                      if (!confirm(`Remove all limits for ${provider}?`)) return;
                      const updated = { ...provLimits };
                      delete updated[provider];
                      updateProviderLimits(updated);
                    }}>Remove</button>
                    <button className="mcc-btn mcc-btn--sm" onClick={() => {
                      const id = prompt("Window ID (e.g. '5h-rolling', 'weekly'):");
                      if (!id?.trim()) return;
                      const newWindow = { id: id.trim(), duration: 18000, rolling: true, shared: true, weights: {}, limit: 45 };
                      updateProviderLimits({
                        ...provLimits,
                        [provider]: { windows: [...prov.windows, newWindow] },
                      });
                    }}>+ Add Window</button>
                  </div>
                  {prov.windows.map((w, i) => {
                    const updateWindow = (patch: Record<string, unknown>) => {
                      const wins = [...prov.windows]; wins[i] = { ...w, ...patch };
                      updateProviderLimits({ ...provLimits, [provider]: { windows: wins } });
                    };
                    const weights = (w.weights ?? {}) as Record<string, number>;
                    const dur = Number(w.duration ?? 0);
                    const PRESETS: Array<{ label: string; value: number }> = [
                      { label: "1 hour", value: 3600 },
                      { label: "3 hours", value: 10800 },
                      { label: "5 hours", value: 18000 },
                      { label: "8 hours", value: 28800 },
                      { label: "Daily", value: 86400 },
                      { label: "Weekly", value: 604800 },
                    ];
                    const presetMatch = PRESETS.find((p) => p.value === dur);
                    return (
                      <div key={i} className="mcc-prov-window-card">
                        <div className="mcc-prov-window-top">
                          <input className="mcc-input mcc-input--mono" value={String(w.id ?? "")} onChange={(e) => updateWindow({ id: e.target.value })} style={{ width: 120 }} placeholder="Window ID" />
                          <select className="mcc-input" value={presetMatch ? String(dur) : "custom"} onChange={(e) => {
                            if (e.target.value !== "custom") updateWindow({ duration: Number(e.target.value) });
                          }}>
                            {PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                            {!presetMatch && <option value="custom">Custom ({dur}s)</option>}
                          </select>
                          {!presetMatch && (
                            <input type="number" className="mcc-input mcc-input--mono" value={dur} onChange={(e) => updateWindow({ duration: Number(e.target.value) })} min="0" style={{ width: 80 }} placeholder="seconds" />
                          )}
                          <label className="mcc-prov-toggle"><input type="checkbox" checked={!!w.rolling} onChange={(e) => updateWindow({ rolling: e.target.checked })} /> Rolling</label>
                          <label className="mcc-prov-toggle"><input type="checkbox" checked={!!w.shared} onChange={(e) => updateWindow({ shared: e.target.checked })} /> Shared pool</label>
                          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Limit:</span>
                            <input type="number" className="mcc-input mcc-input--mono" value={String(w.limit ?? 0)} onChange={(e) => updateWindow({ limit: Number(e.target.value) })} min="0" style={{ width: 70 }} />
                            <button className="mcc-btn mcc-btn--danger mcc-btn--sm" onClick={() => {
                              const wins = prov.windows.filter((_, j) => j !== i);
                              updateProviderLimits({ ...provLimits, [provider]: { windows: wins } });
                            }}>Delete</button>
                          </div>
                        </div>
                        {!w.shared ? (
                          <div className="mcc-prov-window-detail">
                            <span className="mcc-prov-detail-label">Model match:</span>
                            <input className="mcc-input mcc-input--mono" value={String(w.model ?? "")} onChange={(e) => updateWindow({ model: e.target.value })} placeholder="e.g. gpt-5, o3" style={{ width: 160 }} />
                          </div>
                        ) : (
                          <div className="mcc-prov-window-detail">
                            <span className="mcc-prov-detail-label">Model weights:</span>
                            <div className="mcc-prov-weights">
                              {Object.entries(weights).map(([model, weight]) => (
                                <div key={model} className="mcc-prov-weight-row">
                                  <input className="mcc-input mcc-input--mono" value={model} onChange={(e) => {
                                    const newWeights = { ...weights };
                                    delete newWeights[model];
                                    if (e.target.value.trim()) newWeights[e.target.value.trim()] = weight;
                                    updateWindow({ weights: newWeights });
                                  }} style={{ width: 90 }} placeholder="model" />
                                  <span style={{ color: "var(--text-muted)" }}>=</span>
                                  <input type="number" className="mcc-input mcc-input--mono" value={weight} onChange={(e) => {
                                    updateWindow({ weights: { ...weights, [model]: Number(e.target.value) } });
                                  }} step="0.05" min="0" style={{ width: 60 }} />
                                  <button className="mcc-btn mcc-btn--sm" style={{ padding: "1px 6px", fontSize: 11 }} onClick={() => {
                                    const newWeights = { ...weights };
                                    delete newWeights[model];
                                    updateWindow({ weights: newWeights });
                                  }}>x</button>
                                </div>
                              ))}
                              <button className="mcc-btn mcc-btn--sm" onClick={() => {
                                const name = prompt("Model substring (e.g. 'opus', 'sonnet'):");
                                if (!name?.trim()) return;
                                updateWindow({ weights: { ...weights, [name.trim().toLowerCase()]: 1.0 } });
                              }}>+ Add weight</button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  }) as React.ReactNode[]}
                </div>
              ))}
              {Object.keys(provLimits).length === 0 && (
                <p className="muted" style={{ padding: "0.5rem 0" }}>No provider limits configured. Add a provider to start tracking subscription usage.</p>
              )}
            </section>

            {/* Provider Calibration */}
            <section className="mcc-section">
              <div className="mcc-section-header">
                <h3 className="mcc-section-title">Usage Calibration</h3>
                <span className="mcc-section-note">Paste usage text from your provider dashboard to calibrate rate limit tracking. Uses AI to parse any format.</span>
              </div>
              {Object.keys(provLimits).map((provider) => {
                const cal = provCalibration[provider];
                const staleness = cal?.lastUpdated ? Math.round((Date.now() - new Date(cal.lastUpdated).getTime()) / 3600000) : null;
                return (
                  <div key={provider} className="mcc-subsection">
                    <div className="mcc-subsection-header">
                      <h4 className="mcc-subsection-title">{provider}</h4>
                      {cal?.lastUpdated && (
                        <span style={{ fontSize: 11, color: staleness !== null && staleness > 6 ? "var(--accent-danger)" : "var(--text-muted)" }}>
                          Last calibrated: {staleness !== null && staleness < 1 ? "just now" : `${staleness}h ago`}
                        </span>
                      )}
                    </div>
                    <textarea
                      className="mcc-input"
                      rows={8}
                      placeholder={`Paste ${provider} usage text here. Example:\n\nCurrent session\n12% used\nResets in 2 hr 57 min\n\nWeekly limits\nAll models\n2% used\nResets Thu 9:59 PM\nLast update: 11:50PM`}
                      defaultValue={cal?.rawText ?? ""}
                      style={{ fontFamily: "var(--font-mono)", fontSize: 12, width: "100%", resize: "vertical", lineHeight: 1.5 }}
                      onBlur={async (e) => {
                        const text = e.target.value.trim();
                        if (!text) {
                          if (cal) {
                            const updated = { ...provCalibration };
                            delete updated[provider];
                            updateProviderCalibration(updated);
                          }
                          return;
                        }
                        // Try LLM parsing first, fall back to regex
                        let parsed: ParsedCalibration | null = null;
                        try {
                          const res = await fetch("/api/parse-provider-usage", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ text, provider }),
                          });
                          const data = await res.json();
                          if (data.ok && data.parsed?.windows?.length > 0) {
                            parsed = {
                              plan: data.parsed.plan ?? undefined,
                              windows: data.parsed.windows.map((w: { id: string; pct: number; resetIn?: string }) => {
                                const win: ParsedCalibration["windows"][0] = { id: w.id, pct: w.pct };
                                if (w.resetIn) {
                                  const hmMatch = w.resetIn.match(/(\d+)\s*hr?\s*(?:(\d+)\s*min)?/i);
                                  if (hmMatch) {
                                    const hours = parseInt(hmMatch[1], 10);
                                    const mins = hmMatch[2] ? parseInt(hmMatch[2], 10) : 0;
                                    win.resetAt = new Date(Date.now() + hours * 3600000 + mins * 60000).toISOString();
                                  }
                                  const dayTimeMatch = w.resetIn.match(/(mon|tue|wed|thu|fri|sat|sun)\w*\s+(\d{1,2}):(\d{2})\s*(am|pm)/i);
                                  if (dayTimeMatch) {
                                    const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
                                    const targetDay = days.indexOf(dayTimeMatch[1].toLowerCase().slice(0, 3));
                                    let hour = parseInt(dayTimeMatch[2], 10);
                                    const min = parseInt(dayTimeMatch[3], 10);
                                    if (dayTimeMatch[4].toLowerCase() === "pm" && hour < 12) hour += 12;
                                    if (dayTimeMatch[4].toLowerCase() === "am" && hour === 12) hour = 0;
                                    const now = new Date();
                                    let daysUntil = targetDay - now.getDay();
                                    if (daysUntil <= 0) daysUntil += 7;
                                    const resetDate = new Date(now);
                                    resetDate.setDate(resetDate.getDate() + daysUntil);
                                    resetDate.setHours(hour, min, 0, 0);
                                    win.resetAt = resetDate.toISOString();
                                  }
                                  win.note = w.resetIn;
                                }
                                return win;
                              }),
                            };
                          }
                        } catch {
                          // LLM failed, fall through to regex
                        }
                        if (!parsed || parsed.windows.length === 0) {
                          parsed = parseProviderUsageText(text);
                        }
                        updateProviderCalibration({
                          ...provCalibration,
                          [provider]: {
                            lastUpdated: new Date().toISOString(),
                            rawText: text,
                            parsed,
                          },
                        });

                        // Auto-update provider limit values from calibration
                        if (parsed && parsed.windows.length > 0 && provLimits[provider]?.windows?.length > 0) {
                          try {
                            const limRes = await fetch("/api/provider-limits");
                            const limData = await limRes.json();
                            const gwWindows = (limData.windows ?? []) as Array<{ windowId: string; provider: string; used: number; limit: number }>;
                            const updates: Array<{ windowId: string; oldLimit: number; newLimit: number }> = [];
                            const updatedWindows = provLimits[provider].windows.map((w) => {
                              const wId = String(w.id ?? "");
                              const calWindow = parsed!.windows.find((cw) => cw.id === wId);
                              if (!calWindow || calWindow.pct <= 0) return w;
                              const gwWindow = gwWindows.find((gw) => gw.provider === provider && gw.windowId === wId);
                              const gwUsed = gwWindow?.used ?? 0;
                              if (gwUsed <= 0) return w;
                              const estimatedLimit = Math.round(gwUsed / (calWindow.pct / 100));
                              if (estimatedLimit > 0 && estimatedLimit !== Number(w.limit ?? 0)) {
                                updates.push({ windowId: wId, oldLimit: Number(w.limit ?? 0), newLimit: estimatedLimit });
                                return { ...w, limit: estimatedLimit };
                              }
                              return w;
                            });
                            if (updates.length > 0) {
                              const msg = updates.map((u) => `  ${u.windowId}: ${u.oldLimit} → ${u.newLimit}`).join("\n");
                              if (confirm(`Calibration detected new limit values:\n\n${msg}\n\nUpdate provider limits?`)) {
                                updateProviderLimits({ ...provLimits, [provider]: { windows: updatedWindows } });
                              }
                            }
                          } catch {
                            // Gateway unavailable — skip auto-update, calibration data still saved
                          }
                        }
                      }}
                    />
                    {cal?.parsed && cal.parsed.windows.length > 0 && (
                      <div style={{ marginTop: 6, fontSize: 12 }}>
                        {cal.parsed.plan && <span style={{ color: "var(--accent)", marginRight: 12 }}>Plan: {cal.parsed.plan}</span>}
                        <div className="mcc-prov-weights" style={{ marginTop: 4 }}>
                          {cal.parsed.windows.map((w, i) => (
                            <div key={i} className="mcc-prov-weight-row" style={{ gap: 8 }}>
                              <span style={{ color: "var(--text-muted)", minWidth: 80 }}>{w.id}:</span>
                              <span style={{ color: w.pct > 80 ? "var(--accent-danger)" : w.pct > 50 ? "var(--accent-warning)" : "var(--accent)" }}>{w.pct}% used</span>
                              {w.resetAt && <span style={{ color: "var(--text-muted)", fontSize: 11 }}>resets {new Date(w.resetAt).toLocaleString()}</span>}
                              {w.note && !w.resetAt && <span style={{ color: "var(--text-muted)", fontSize: 11 }}>{w.note}</span>}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {cal?.rawText && (!cal.parsed || cal.parsed.windows.length === 0) && (
                      <p style={{ fontSize: 11, color: "var(--accent-warning)", marginTop: 4 }}>Could not parse usage data. Try copying more text from the usage page.</p>
                    )}
                  </div>
                );
              })}
              {Object.keys(provLimits).length === 0 && (
                <p className="muted" style={{ padding: "0.5rem 0" }}>Add provider rate limits above first.</p>
              )}
            </section>
          </>
        );
      })()}

      {/* ════════════════════════════════════════════════════════════════════════
         TAB: Sentinel
         ════════════════════════════════════════════════════════════════════════ */}
      {viewMode === "edit" && activeTab === "sentinel" && sentinelConfig && (
        <>
          <div className="mcc-file-group">
            <div className="mcc-file-group-header">
              <code className="mcc-file-group-path">sentinel/deck-sentinel.json</code>
            </div>
          </div>

          {/* Sentinel toolbar */}
          <div className="mcc-sentinel-toolbar">
            <div className="mcc-status">
              {sentinelDirty && (
                <span className="mcc-status-badge mcc-status-badge--dirty">Unsaved changes</span>
              )}
              {sentinelSaveStatus === "saved" && (
                <span className="mcc-status-badge mcc-status-badge--ok">Saved</span>
              )}
            </div>
            {sentinelDirty && (
              <div className="mcc-actions">
                <button className="mcc-btn" onClick={handleSentinelDiscard}>Discard</button>
                <button className="mcc-btn mcc-btn--primary" onClick={handleSentinelSave} disabled={sentinelSaveStatus === "saving"}>
                  {sentinelSaveStatus === "saving" ? "Saving..." : "Save Sentinel Config"}
                </button>
              </div>
            )}
          </div>

          {sentinelSaveErrors.length > 0 && (
            <div className="mcc-error-bar">
              {sentinelSaveErrors.map((e, i) => <div key={i}>{e}</div>)}
            </div>
          )}

          <div className="mcc-restart-note">Changes take effect on next sentinel loop cycle (no restart needed).</div>

          {/* Global settings */}
          <section className="mcc-section">
            <div className="mcc-section-header">
              <h3 className="mcc-section-title">Sentinel — Global</h3>
              <span className="mcc-section-note">Self-healing health monitor</span>
            </div>
            <div className="mcc-sentinel-global">
              <label>
                Loop interval (seconds):
                <input
                  className="mcc-input mcc-input--sm"
                  type="number"
                  min={60}
                  value={sentinelConfig.loop_interval_seconds ?? 300}
                  onChange={(e) => updateSentinelTopLevel("loop_interval_seconds", Number(e.target.value))}
                />
              </label>
            </div>
          </section>

          {/* Per-check cards */}
          <section className="mcc-section">
            <div className="mcc-section-header">
              <h3 className="mcc-section-title">Health Checks</h3>
              <span className="mcc-section-note">Toggle and configure individual checks</span>
            </div>
            <div className="mcc-check-grid">
              {Object.entries(SENTINEL_CHECKS).map(([checkName, meta]) => {
                const check = sentinelConfig.checks?.[checkName] ?? { enabled: false };
                const isEnabled = check.enabled ?? false;
                const note = check._note as string | undefined;

                return (
                  <div key={checkName} id={`cfg-${checkName}`} className={`mcc-check-card${!isEnabled ? " mcc-check-card--disabled" : ""}`}>
                    <div className="mcc-check-header">
                      <h4 className="mcc-check-title">{meta.label}</h4>
                      <label className="mcc-toggle">
                        <input
                          type="checkbox"
                          checked={isEnabled}
                          onChange={(e) => updateSentinelCheck(checkName, "enabled", e.target.checked)}
                        />
                        <span className="mcc-toggle-slider" />
                      </label>
                    </div>
                    <p className="mcc-check-desc">{meta.description}</p>
                    {note && <p className="mcc-check-note">{note}</p>}

                    {meta.params && meta.params.length > 0 && (
                      <div className="mcc-check-params">
                        {meta.params.map((p) => {
                          const val = p.topLevel
                            ? sentinelConfig[p.key]
                            : check[p.key];

                          if (p.type === "boolean") {
                            return (
                              <div key={p.key} id={`cfg-${p.key}`} className="mcc-check-param">
                                <label>{p.label}</label>
                                <label className="mcc-toggle">
                                  <input
                                    type="checkbox"
                                    checked={val ?? false}
                                    onChange={(e) =>
                                      p.topLevel
                                        ? updateSentinelTopLevel(p.key, e.target.checked)
                                        : updateSentinelCheck(checkName, p.key, e.target.checked)
                                    }
                                  />
                                  <span className="mcc-toggle-slider" />
                                </label>
                              </div>
                            );
                          }

                          if (p.type === "number") {
                            return (
                              <div key={p.key} id={`cfg-${p.key}`} className="mcc-check-param">
                                <label>{p.label}</label>
                                <input
                                  className="mcc-input mcc-input--sm"
                                  type="text"
                                  inputMode="decimal"
                                  value={val ?? ""}
                                  onChange={(e) => {
                                    const raw = e.target.value;
                                    if (raw === "" || /^\d*\.?\d*$/.test(raw)) {
                                      const v = raw === "" ? undefined : parseFloat(raw);
                                      if (p.topLevel) {
                                        updateSentinelTopLevel(p.key, v);
                                      } else {
                                        updateSentinelCheck(checkName, p.key, v);
                                      }
                                    }
                                  }}
                                />
                              </div>
                            );
                          }

                          // string
                          return (
                            <div key={p.key} id={`cfg-${p.key}`} className="mcc-check-param">
                              <label>{p.label}</label>
                              <input
                                className="mcc-input mcc-input--mono"
                                type="text"
                                value={val ?? ""}
                                onChange={(e) =>
                                  p.topLevel
                                    ? updateSentinelTopLevel(p.key, e.target.value)
                                    : updateSentinelCheck(checkName, p.key, e.target.value)
                                }
                              />
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          {/* Sticky bottom save bar */}
          {sentinelDirty && (
            <div className="mcc-sticky-save">
              <span className="mcc-sticky-save-label">Unsaved changes</span>
              <div className="mcc-sticky-save-actions">
                <button className="mcc-btn" onClick={handleSentinelDiscard}>Discard</button>
                <button className="mcc-btn mcc-btn--primary" onClick={handleSentinelSave} disabled={sentinelSaveStatus === "saving"}>
                  {sentinelSaveStatus === "saving" ? "Saving..." : "Save Sentinel Config"}
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {viewMode === "edit" && activeTab === "sentinel" && !sentinelConfig && (
        <div className="mcc-restart-note">Sentinel config not found. Create <code>sentinel/deck-sentinel.json</code> to enable.</div>
      )}

      {/* ════════════════════════════════════════════════════════════════════════
         TAB: Dashboard
         ════════════════════════════════════════════════════════════════════════ */}
      {viewMode === "edit" && activeTab === "dashboard" && (() => {
        const dash: DashboardPrefs = config.dashboard ?? {};
        const hiddenTabs = new Set(dash.hiddenTabs ?? []);

        const NAV_TABS = [
          { key: "overview", label: "Overview", href: "/" },
          { key: "costs", label: "Costs", href: "/costs" },
          { key: "schedule", label: "Schedule", href: "/schedule" },
          { key: "logs", label: "Logs", href: "/logs" },
          { key: "tests", label: "Tests", href: "/tests" },
          { key: "knowledge", label: "Knowledge", href: "/knowledge" },
          { key: "sessions", label: "Sessions", href: "/sessions" },
          { key: "analysis", label: "Analysis", href: "/analysis" },
          { key: "search", label: "Search", href: "/search" },
          { key: "services", label: "Services", href: "/services" },
          { key: "config", label: "OpenClaw Config", href: "/config" },
        ];


        function updateDashboard(next: DashboardPrefs) {
          setConfig({ ...config!, dashboard: next });
          setSaveStatus("idle");
        }

        function toggleTab(tabKey: string) {
          const next = new Set(hiddenTabs);
          if (next.has(tabKey)) next.delete(tabKey);
          else next.add(tabKey);
          updateDashboard({ ...dash, hiddenTabs: [...next] });
        }


        const origDash = original ? JSON.parse(original).dashboard ?? {} : {};
        const dashDirty = JSON.stringify(config.dashboard ?? {}) !== JSON.stringify(origDash);

        return (
          <>
            <div className="mcc-file-group">
              <div className="mcc-file-group-header">
                <code className="mcc-file-group-path">config/deck-config.json</code>
              </div>
            </div>

            {/* Dashboard toolbar */}
            <div className="mcc-toolbar">
              <div className="mcc-status">
                {dashDirty && (
                  <span className="mcc-status-badge mcc-status-badge--dirty">Unsaved changes</span>
                )}
                {saveStatus === "saved" && (
                  <span className="mcc-status-badge mcc-status-badge--ok">Saved</span>
                )}
              </div>
              {dashDirty && (
                <div className="mcc-actions">
                  <button className="mcc-btn" onClick={handleDiscard}>Discard</button>
                  <button className="mcc-btn mcc-btn--primary" onClick={async () => {
                    await handleSave();
                    window.dispatchEvent(new Event("dashboard-prefs-changed"));
                  }} disabled={saveStatus === "saving"}>
                    {saveStatus === "saving" ? "Saving..." : "Save"}
                  </button>
                </div>
              )}
            </div>

            <div className="mcc-restart-note">Dashboard preferences take effect immediately after save (no restart needed).</div>

            {/* Tab visibility */}
            <section className="mcc-section">
              <div className="mcc-section-header">
                <h3 className="mcc-section-title">Navigation Tabs</h3>
                <span className="mcc-section-note">Toggle which tabs appear in the sidebar. Services &amp; Deck Config are always visible.</span>
              </div>
              <div className="mcc-check-grid">
                {NAV_TABS.map((tab) => {
                  const visible = !hiddenTabs.has(tab.key);
                  return (
                    <div key={tab.key} className={`mcc-check-card${!visible ? " mcc-check-card--disabled" : ""}`}>
                      <div className="mcc-check-header">
                        <span style={{ fontSize: "13px", fontWeight: 600 }}>{tab.label}</span>
                        <label className="mcc-toggle">
                          <input
                            type="checkbox"
                            checked={visible}
                            onChange={() => toggleTab(tab.key)}
                          />
                          <span className="mcc-toggle-slider" />
                        </label>
                      </div>
                      <p className="mcc-check-desc" style={{ fontSize: "11px", color: "var(--text-muted)" }}>{tab.href}</p>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* Walkthrough */}
            <section className="mcc-section">
              <div className="mcc-section-header">
                <h3 className="mcc-section-title">Walkthrough</h3>
                <span className="mcc-section-note">Interactive tour of the dashboard pages and features.</span>
              </div>
              <button
                className="mcc-btn mcc-btn--primary"
                onClick={() => {
                  fetch("/api/dashboard-prefs/tour", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ show: true }),
                  }).then(() => {
                    window.dispatchEvent(new Event("tour-start"));
                  });
                }}
              >
                Start Walkthrough
              </button>
            </section>

            {/* Sticky bottom save bar */}
            {dashDirty && (
              <div className="mcc-sticky-save">
                <span className="mcc-sticky-save-label">Unsaved changes</span>
                <div className="mcc-sticky-save-actions">
                  <button className="mcc-btn" onClick={handleDiscard}>Discard</button>
                  <button className="mcc-btn mcc-btn--primary" onClick={async () => {
                    await handleSave();
                    window.dispatchEvent(new Event("dashboard-prefs-changed"));
                  }} disabled={saveStatus === "saving"}>
                    {saveStatus === "saving" ? "Saving..." : "Save"}
                  </button>
                </div>
              </div>
            )}
          </>
        );
      })()}

      {/* ════════════════════════════════════════════════════════════════════════
         TAB: Budgets
         ════════════════════════════════════════════════════════════════════════ */}
      {viewMode === "edit" && activeTab === "budgets" && (() => {
        const budgets = (config as unknown as Record<string, unknown>).budgets as {
          global?: { daily?: number; weekly?: number; monthly?: number };
          agents?: Record<string, { daily?: number; weekly?: number; monthly?: number; action?: string; autoRecovery?: boolean }>;
          alertThresholds?: number[];
          alertChannel?: string;
          defaultAutoRecovery?: string;
          sessionCostCap?: { default?: number; agents?: Record<string, number>; action?: string };
          costView?: string;
        } | undefined ?? {};

        const updateBudgets = (patch: Record<string, unknown>) => {
          setConfig({ ...config, budgets: { ...budgets, ...patch } } as typeof config);
          setSaveStatus("idle");
        };

        return (
          <>
            <div className="mcc-file-group">
              <div className="mcc-file-group-header">
                <code className="mcc-file-group-path">config/deck-config.json</code>
              </div>
            </div>

            {/* Alert Settings — global settings for all budget/alert checks */}
            <section className="mcc-section" id="cfg-alertSettings">
              <div className="mcc-section-header">
                <h3 className="mcc-section-title">Alert Settings</h3>
                <span className="mcc-section-note">Global settings for all budget limits and alerts</span>
              </div>
              <div className="mcc-table-wrap">
                <table className="mcc-table mcc-table--kv">
                  <thead><tr><th>Setting</th><th>Value</th></tr></thead>
                  <tbody>
                    <tr className="mcc-row">
                      <td data-label="Setting">Cost Evaluation</td>
                      <td data-label="Value">
                        <div className="mcc-radio-group">
                          {[
                            { value: "actual", label: "Actual", desc: "only real provider spend" },
                            { value: "api-equiv", label: "API Equiv", desc: "estimated cost (incl. subscription)" },
                            { value: "total", label: "Total", desc: "actual for API, api-equiv for subscription" },
                          ].map((opt) => (
                            <label key={opt.value} className={`mcc-radio-option${(budgets?.costView ?? "total") === opt.value ? " mcc-radio-option--active" : ""}`}>
                              <input
                                type="radio"
                                name="budgetCostView"
                                value={opt.value}
                                checked={(budgets?.costView ?? "total") === opt.value}
                                onChange={() => updateBudgets({ costView: opt.value })}
                              />
                              <span className="mcc-radio-label">{opt.label}</span>
                              <span className="mcc-radio-desc">{opt.desc}</span>
                            </label>
                          ))}
                        </div>
                      </td>
                    </tr>
                    <tr className="mcc-row">
                      <td data-label="Setting">Alert Routing</td>
                      <td data-label="Value">
                        <button className="mcc-btn mcc-btn--ghost" style={{ fontSize: 12 }} onClick={() => setActiveTab("alerts")}>
                          Configure in Alerts tab &rarr;
                        </button>
                      </td>
                    </tr>
                    <tr className="mcc-row">
                      <td data-label="Setting">Alert Thresholds (%)</td>
                      <td data-label="Value">
                        <input
                          className="mcc-input mcc-input--mono"
                          defaultValue={(budgets?.alertThresholds ?? [80, 100]).join(", ")}
                          onBlur={(e) => {
                            const vals = e.target.value.split(",").map((s) => Number(s.trim())).filter((n) => !isNaN(n) && n > 0);
                            if (vals.length > 0) updateBudgets({ alertThresholds: vals });
                          }}
                          placeholder="80, 100"
                        />
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>

            {/* Session Guardrails — operational safety limits */}
            {(() => {
              const guardrails = (cfgAny.sessionGuardrails ?? cfgAny.replayAlerts ?? {}) as {
                enabled?: boolean;
                action?: string;
                maxSessionDuration?: number;
                cronMaxDuration?: number;
                maxToolCalls?: number;
                contextThreshold?: number;
                stepCostThreshold?: number;
              };
              const updateGuardrails = (patch: Record<string, unknown>) => {
                setConfig({ ...config, sessionGuardrails: { ...guardrails, ...patch } } as typeof config);
                setSaveStatus("idle");
              };
              return (
                <section className="mcc-section" id="cfg-sessionGuardrails">
                  <div className="mcc-section-header">
                    <h3 className="mcc-section-title">Session Guardrails</h3>
                    <span className="mcc-section-note">Protect against runaway sessions — long duration, excessive tool calls, context overflow</span>
                  </div>
                  <div className="mcc-table-wrap">
                    <table className="mcc-table mcc-table--kv">
                      <thead><tr><th>Setting</th><th>Value</th></tr></thead>
                      <tbody>
                        <tr className="mcc-row">
                          <td data-label="Setting">Enabled</td>
                          <td data-label="Value">
                            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <input
                                type="checkbox"
                                checked={guardrails.enabled !== false}
                                onChange={(e) => updateGuardrails({ enabled: e.target.checked })}
                              />
                              {guardrails.enabled !== false ? "Active" : "Disabled"}
                            </label>
                          </td>
                        </tr>
                        <tr className="mcc-row">
                          <td data-label="Setting">Enforcement Action</td>
                          <td data-label="Value">
                            <div className="mcc-radio-group">
                              {([
                                { value: "alert", label: "Alert Only", desc: "Discord notification only" },
                                { value: "throttle", label: "Throttle", desc: "Downgrade model when breached" },
                                { value: "block", label: "Block", desc: "Reject LLM calls when breached" },
                              ] as const).map((opt) => (
                                <label key={opt.value} className={`mcc-radio-option${(guardrails.action ?? "alert") === opt.value ? " mcc-radio-option--active" : ""}`}>
                                  <input type="radio" name="guardrailAction" value={opt.value} checked={(guardrails.action ?? "alert") === opt.value}
                                    onChange={() => updateGuardrails({ action: opt.value })} />
                                  <span className="mcc-radio-label">{opt.label}</span>
                                  <span className="mcc-radio-desc">{opt.desc}</span>
                                </label>
                              ))}
                            </div>
                          </td>
                        </tr>
                        <tr className="mcc-row" id="cfg-maxSessionDuration">
                          <td data-label="Setting">Max Session Duration (min)</td>
                          <td data-label="Value">
                            <input
                              type="text"
                              inputMode="numeric"
                              className="mcc-input mcc-input--mono"
                              value={guardrails.maxSessionDuration ?? ""}
                              onChange={(e) => {
                                const raw = e.target.value;
                                if (raw === "" || /^\d+$/.test(raw)) {
                                  updateGuardrails({ maxSessionDuration: raw === "" ? undefined : Number(raw) });
                                }
                              }}
                              placeholder="60"
                            />
                          </td>
                        </tr>
                        <tr className="mcc-row" id="cfg-cronMaxDuration">
                          <td data-label="Setting">Cron Max Duration (min)</td>
                          <td data-label="Value">
                            <input
                              type="text"
                              inputMode="numeric"
                              className="mcc-input mcc-input--mono"
                              value={guardrails.cronMaxDuration ?? ""}
                              onChange={(e) => {
                                const raw = e.target.value;
                                if (raw === "" || /^\d+$/.test(raw)) {
                                  updateGuardrails({ cronMaxDuration: raw === "" ? undefined : Number(raw) });
                                }
                              }}
                              placeholder="30"
                            />
                            <span className="mcc-input-note">Per-invocation limit for cron jobs (not cumulative)</span>
                          </td>
                        </tr>
                        <tr className="mcc-row" id="cfg-maxToolCalls">
                          <td data-label="Setting">Max Tool Calls</td>
                          <td data-label="Value">
                            <input
                              type="text"
                              inputMode="numeric"
                              className="mcc-input mcc-input--mono"
                              value={guardrails.maxToolCalls ?? ""}
                              onChange={(e) => {
                                const raw = e.target.value;
                                if (raw === "" || /^\d+$/.test(raw)) {
                                  updateGuardrails({ maxToolCalls: raw === "" ? undefined : Number(raw) });
                                }
                              }}
                              placeholder="200"
                            />
                          </td>
                        </tr>
                        <tr className="mcc-row" id="cfg-contextThreshold">
                          <td data-label="Setting">Context Threshold (%)</td>
                          <td data-label="Value">
                            <input
                              type="text"
                              inputMode="numeric"
                              className="mcc-input mcc-input--mono"
                              value={guardrails.contextThreshold ?? ""}
                              onChange={(e) => {
                                const raw = e.target.value;
                                if (raw === "" || /^\d+$/.test(raw)) {
                                  updateGuardrails({ contextThreshold: raw === "" ? undefined : Number(raw) });
                                }
                              }}
                              placeholder="85"
                            />
                          </td>
                        </tr>
                        <tr className="mcc-row" id="cfg-stepCostThreshold">
                          <td data-label="Setting">Step Cost Threshold ($)</td>
                          <td data-label="Value">
                            <input
                              type="text"
                              inputMode="decimal"
                              className="mcc-input mcc-input--mono"
                              value={guardrails.stepCostThreshold ?? ""}
                              onChange={(e) => {
                                const raw = e.target.value;
                                if (raw === "" || /^\d*\.?\d*$/.test(raw)) {
                                  // Keep raw string (e.g. "0.") to allow typing decimals; convert on blur
                                  updateGuardrails({ stepCostThreshold: raw === "" ? undefined : raw });
                                }
                              }}
                              onBlur={(e) => {
                                const v = e.target.value;
                                if (v && !isNaN(Number(v))) updateGuardrails({ stepCostThreshold: Number(v) });
                              }}
                              placeholder="1.00"
                            />
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </section>
              );
            })()}

            {/* Global Budgets */}
            <section className="mcc-section" id="cfg-globalBudgets">
              <div className="mcc-section-header">
                <h3 className="mcc-section-title">Global Budgets</h3>
                <span className="mcc-section-note">Fleet-wide spending limits (USD). Leave empty for no limit.</span>
              </div>
              <div className="mcc-table-wrap">
                <table className="mcc-table mcc-table--kv">
                  <thead><tr><th>Period</th><th>Cost Limit ($)</th><th>Request Limit</th></tr></thead>
                  <tbody>
                    {([
                      { period: "daily" as const, reqKey: "dailyRequests" as const },
                      { period: "weekly" as const, reqKey: "weeklyRequests" as const },
                      { period: "monthly" as const, reqKey: null },
                    ]).map(({ period, reqKey }) => (
                      <tr key={period} className="mcc-row">
                        <td data-label="Period" style={{ textTransform: "capitalize" }}>{period}</td>
                        <td data-label="Cost Limit">
                          <input
                            type="text"
                            inputMode="decimal"
                            pattern="[0-9]*\.?[0-9]*"
                            className="mcc-input mcc-input--mono"
                            value={budgets.global?.[period] ?? ""}
                            onChange={(e) => {
                              const raw = e.target.value;
                              if (raw === "" || /^\d*\.?\d*$/.test(raw)) {
                                updateBudgets({
                                  global: { ...budgets.global, [period]: raw === "" ? undefined : raw },
                                });
                              }
                            }}
                            onBlur={(e) => {
                              const v = e.target.value;
                              if (v && !isNaN(Number(v))) {
                                updateBudgets({ global: { ...budgets.global, [period]: Number(v) } });
                              }
                            }}
                            placeholder="No limit"
                          />
                        </td>
                        <td data-label="Request Limit">
                          {reqKey ? (
                            <input
                              type="text"
                              inputMode="numeric"
                              pattern="[0-9]*"
                              className="mcc-input mcc-input--mono"
                              value={String((budgets.global as Record<string, unknown>)?.[reqKey] ?? "")}
                              onChange={(e) => {
                                const raw = e.target.value;
                                if (raw === "" || /^\d+$/.test(raw)) {
                                  updateBudgets({
                                    global: { ...budgets.global, [reqKey]: raw === "" ? undefined : Number(raw) },
                                  });
                                }
                              }}
                              placeholder="No limit"
                            />
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            {/* Per-Agent Budgets (collapsible) */}
            {(() => {
              const customCount = config.agents.filter(a => {
                const ab = (budgets.agents?.[a.key] ?? {}) as Record<string, unknown>;
                return ab.daily || ab.dailyRequests || ab.weeklyRequests;
              }).length;
              return (
                <details className="mcc-section mcc-collapsible" id="cfg-agentBudgets">
                  <summary>
                    <div>
                      <h3 className="mcc-section-title">Per-Agent Budgets</h3>
                      <span className="mcc-section-note">{customCount > 0 ? `${customCount} agent${customCount > 1 ? "s" : ""} with custom limits` : "No custom limits set"}</span>
                    </div>
                  </summary>
                  <div className="mcc-collapsible-body">
                    <div className="mcc-table-wrap">
                      <table className="mcc-table">
                        <thead>
                          <tr>
                            <th>Agent</th>
                            <th>Daily Limit ($)</th>
                            <th>Daily Requests</th>
                            <th>Weekly Requests</th>
                            <th>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {config.agents.map((a) => {
                            const ab = (budgets.agents?.[a.key] ?? {}) as Record<string, unknown>;
                            return (
                              <tr key={a.key} className="mcc-row">
                                <td data-label="Agent">{a.emoji} {a.name}</td>
                                <td data-label="Daily Limit">
                                  <input
                                    type="text"
                                    inputMode="decimal"
                                    pattern="[0-9]*\.?[0-9]*"
                                    className="mcc-input mcc-input--mono"
                                    value={String(ab.daily ?? "")}
                                    onChange={(e) => {
                                      const raw = e.target.value;
                                      if (raw === "" || /^\d*\.?\d*$/.test(raw)) {
                                        const agents = { ...budgets.agents, [a.key]: { ...ab, daily: raw === "" ? undefined : raw } };
                                        updateBudgets({ agents });
                                      }
                                    }}
                                    onBlur={(e) => {
                                      const v = e.target.value;
                                      if (v && !isNaN(Number(v))) {
                                        const agents = { ...budgets.agents, [a.key]: { ...(budgets.agents?.[a.key] ?? {}), daily: Number(v) } };
                                        updateBudgets({ agents });
                                      }
                                    }}
                                    placeholder="No limit"
                                  />
                                </td>
                                <td data-label="Daily Requests">
                                  <input
                                    type="text"
                                    inputMode="numeric"
                                    pattern="[0-9]*"
                                    className="mcc-input mcc-input--mono"
                                    value={String(ab.dailyRequests ?? "")}
                                    onChange={(e) => {
                                      const raw = e.target.value;
                                      if (raw === "" || /^\d+$/.test(raw)) {
                                        const agents = { ...budgets.agents, [a.key]: { ...ab, dailyRequests: raw === "" ? undefined : Number(raw) } };
                                        updateBudgets({ agents });
                                      }
                                    }}
                                    placeholder="No limit"
                                  />
                                </td>
                                <td data-label="Weekly Requests">
                                  <input
                                    type="text"
                                    inputMode="numeric"
                                    pattern="[0-9]*"
                                    className="mcc-input mcc-input--mono"
                                    value={String(ab.weeklyRequests ?? "")}
                                    onChange={(e) => {
                                      const raw = e.target.value;
                                      if (raw === "" || /^\d+$/.test(raw)) {
                                        const agents = { ...budgets.agents, [a.key]: { ...ab, weeklyRequests: raw === "" ? undefined : Number(raw) } };
                                        updateBudgets({ agents });
                                      }
                                    }}
                                    placeholder="No limit"
                                  />
                                </td>
                                <td data-label="Action">
                                  <div className="mcc-radio-group mcc-radio-group--inline">
                                    {[
                                      { value: "alert", label: "Alert Only" },
                                      { value: "throttle", label: "Throttle" },
                                      { value: "block", label: "Block" },
                                    ].map((opt) => (
                                      <label key={opt.value} className={`mcc-radio-option${(ab.action ?? "alert") === opt.value ? " mcc-radio-option--active" : ""}`}>
                                        <input type="radio" name={`action-${a.key}`} value={opt.value} checked={(ab.action ?? "alert") === opt.value}
                                          onChange={() => { const agents = { ...budgets.agents, [a.key]: { ...ab, action: opt.value } }; updateBudgets({ agents }); }} />
                                        <span className="mcc-radio-label">{opt.label}</span>
                                      </label>
                                    ))}
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </details>
              );
            })()}

            {/* Session Cost Cap */}
            <section className="mcc-section" id="cfg-sessionCostCap">
              <div className="mcc-section-header">
                <h3 className="mcc-section-title">Session Cost Cap</h3>
                <span className="mcc-section-note">Maximum cost for a single agent session</span>
              </div>
              <div style={{ marginBottom: 12 }}>
                <label className="mcc-label" style={{ marginBottom: 8, display: "block" }}>Enforcement Action</label>
                <div className="mcc-radio-group">
                  {([
                    { value: "alert", label: "Alert Only", desc: "Discord notification only" },
                    { value: "throttle", label: "Throttle", desc: "Downgrade model when exceeded" },
                    { value: "block", label: "Block", desc: "Reject LLM calls when exceeded" },
                  ] as const).map((opt) => (
                    <label key={opt.value} className={`mcc-radio-option${((budgets.sessionCostCap as any)?.action ?? "alert") === opt.value ? " mcc-radio-option--active" : ""}`}>
                      <input type="radio" name="sessionCostCapAction" value={opt.value}
                        checked={((budgets.sessionCostCap as any)?.action ?? "alert") === opt.value}
                        onChange={() => updateBudgets({ sessionCostCap: { ...(budgets.sessionCostCap as any ?? {}), action: opt.value } })} />
                      <span className="mcc-radio-label">{opt.label}</span>
                      <span className="mcc-radio-desc">{opt.desc}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
                <label className="mcc-label" style={{ minWidth: 120 }}>Default Cap ($)</label>
                <input
                  type="number"
                  className="mcc-input mcc-input--mono"
                  style={{ maxWidth: 120 }}
                  value={(budgets.sessionCostCap as any)?.default ?? ""}
                  onChange={(e) => {
                    const cap = { ...(budgets.sessionCostCap as any ?? {}), default: e.target.value === "" ? undefined : Number(e.target.value) };
                    updateBudgets({ sessionCostCap: cap });
                  }}
                  min="0"
                  step="0.01"
                  placeholder="5"
                />
              </div>
              {(() => {
                const caps = (budgets.sessionCostCap as any)?.agents ?? {};
                const overrideCount = Object.keys(caps).filter(k => caps[k] != null).length;
                return (
                  <details className="mcc-collapsible">
                    <summary>
                      <div>
                        <span className="mcc-section-title" style={{ fontSize: 13 }}>Per-Agent Overrides</span>
                        <span className="mcc-section-note">{overrideCount > 0 ? `${overrideCount} agent${overrideCount > 1 ? "s" : ""} with custom cap` : "All using default"}</span>
                      </div>
                    </summary>
                    <div className="mcc-collapsible-body">
                      <div className="mcc-table-wrap">
                        <table className="mcc-table">
                          <thead><tr><th>Agent</th><th>Session Cap ($)</th></tr></thead>
                          <tbody>
                            {config.agents.map((a) => (
                              <tr key={a.key} className="mcc-row">
                                <td data-label="Agent">{a.emoji} {a.name}</td>
                                <td data-label="Session Cap">
                                  <input
                                    type="number"
                                    className="mcc-input mcc-input--mono"
                                    value={String(caps[a.key] ?? "")}
                                    onChange={(e) => {
                                      const newAgents = { ...caps };
                                      if (e.target.value) newAgents[a.key] = Number(e.target.value);
                                      else delete newAgents[a.key];
                                      updateBudgets({ sessionCostCap: { ...(budgets.sessionCostCap as any ?? {}), agents: newAgents } });
                                    }}
                                    placeholder="Use default"
                                    min="0"
                                    step="0.01"
                                  />
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </details>
                );
              })()}
            </section>

            {/* Auto-Recovery */}
            <section className="mcc-section">
              <div className="mcc-section-header">
                <h3 className="mcc-section-title">Auto-Recovery</h3>
                <span className="mcc-section-note">Should blocked agents automatically resume when budget resets?</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
                <label className="mcc-label" style={{ minWidth: 120 }}>Default</label>
                <div className="mcc-radio-group">
                  {[
                    { value: "throttle-only", label: "Throttle-only", desc: "Auto-recover throttled, not blocked" },
                    { value: "all", label: "Always auto-recover" },
                    { value: "none", label: "Never", desc: "Manual only" },
                  ].map((opt) => (
                    <label key={opt.value} className={`mcc-radio-option${(budgets.defaultAutoRecovery ?? "throttle-only") === opt.value ? " mcc-radio-option--active" : ""}`}>
                      <input type="radio" name="defaultAutoRecovery" value={opt.value} checked={(budgets.defaultAutoRecovery ?? "throttle-only") === opt.value}
                        onChange={() => updateBudgets({ defaultAutoRecovery: opt.value })} />
                      <span className="mcc-radio-label">{opt.label}</span>
                      {opt.desc && <span className="mcc-radio-desc">{opt.desc}</span>}
                    </label>
                  ))}
                </div>
              </div>
              {(() => {
                const overrideCount = config.agents.filter(a => {
                  const ab = (budgets.agents?.[a.key] ?? {}) as Record<string, unknown>;
                  return ab.autoRecovery !== undefined;
                }).length;
                return (
                  <details className="mcc-collapsible">
                    <summary>
                      <div>
                        <span className="mcc-section-title" style={{ fontSize: 13 }}>Per-Agent Overrides</span>
                        <span className="mcc-section-note">{overrideCount > 0 ? `${overrideCount} agent${overrideCount > 1 ? "s" : ""} with custom setting` : "All using default"}</span>
                      </div>
                    </summary>
                    <div className="mcc-collapsible-body">
                      <div className="mcc-table-wrap">
                        <table className="mcc-table">
                          <thead><tr><th>Agent</th><th>Auto-Recovery</th></tr></thead>
                          <tbody>
                            {config.agents.map((a) => {
                              const ab = (budgets.agents?.[a.key] ?? {}) as Record<string, unknown>;
                              return (
                                <tr key={a.key} className="mcc-row">
                                  <td data-label="Agent">{a.emoji} {a.name}</td>
                                  <td data-label="Auto-Recovery">
                                    <div className="mcc-radio-group mcc-radio-group--inline">
                                      {[
                                        { value: "default", label: "Default" },
                                        { value: "always", label: "Always" },
                                        { value: "never", label: "Never" },
                                      ].map((opt) => {
                                        const cur = ab.autoRecovery === true ? "always" : ab.autoRecovery === false ? "never" : "default";
                                        return (
                                          <label key={opt.value} className={`mcc-radio-option${cur === opt.value ? " mcc-radio-option--active" : ""}`}>
                                            <input type="radio" name={`autoRecovery-${a.key}`} value={opt.value} checked={cur === opt.value}
                                              onChange={() => {
                                                const agents = { ...budgets.agents, [a.key]: { ...ab, autoRecovery: opt.value === "always" ? true : opt.value === "never" ? false : undefined } };
                                                updateBudgets({ agents });
                                              }} />
                                            <span className="mcc-radio-label">{opt.label}</span>
                                          </label>
                                        );
                                      })}
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </details>
                );
              })()}
            </section>


          </>
        );
      })()}

      {/* ════════════════════════════════════════════════════════════════════════
         TAB: REPLAY
         ════════════════════════════════════════════════════════════════════════ */}
      {viewMode === "edit" && activeTab === "replay" && (() => {
        const replayUI = (cfgAny.replayUI ?? {}) as {
          defaultPlaySpeed?: number;
          autoExpandThinking?: boolean;
          showCostBar?: boolean;
          showAnomalyBadges?: boolean;
          toolResultMaxLines?: number;
          timeGapThreshold?: number;
        };

        const updateReplayUI = (patch: Record<string, unknown>) => {
          setConfig({ ...config, replayUI: { ...replayUI, ...patch } } as typeof config);
          setSaveStatus("idle");
        };

        return (
          <>
            <div className="mcc-file-group">
              <div className="mcc-file-group-header">
                <code className="mcc-file-group-path">config/deck-config.json</code>
              </div>
            </div>

            {/* Replay UI — dashboard display settings */}
            <section className="mcc-section">
              <div className="mcc-section-header">
                <h3 className="mcc-section-title">Replay UI</h3>
                <span className="mcc-section-note">Dashboard display preferences for session replay</span>
              </div>
              <div className="mcc-table-wrap">
                <table className="mcc-table mcc-table--kv">
                  <thead><tr><th>Setting</th><th>Value</th></tr></thead>
                  <tbody>
                    <tr className="mcc-row">
                      <td data-label="Setting">Default Play Speed</td>
                      <td data-label="Value">
                        <div className="mcc-radio-group mcc-radio-group--inline">
                          {[
                            { value: 1, label: "1x" },
                            { value: 2, label: "2x" },
                            { value: 4, label: "4x" },
                          ].map((opt) => (
                            <label key={opt.value} className={`mcc-radio-option${(replayUI.defaultPlaySpeed ?? 1) === opt.value ? " mcc-radio-option--active" : ""}`}>
                              <input type="radio" name="defaultPlaySpeed" value={opt.value} checked={(replayUI.defaultPlaySpeed ?? 1) === opt.value}
                                onChange={() => updateReplayUI({ defaultPlaySpeed: opt.value })} />
                              <span className="mcc-radio-label">{opt.label}</span>
                            </label>
                          ))}
                        </div>
                      </td>
                    </tr>
                    <tr className="mcc-row">
                      <td data-label="Setting">Auto-Expand Thinking</td>
                      <td data-label="Value">
                        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <input
                            type="checkbox"
                            checked={replayUI.autoExpandThinking !== false}
                            onChange={(e) => updateReplayUI({ autoExpandThinking: e.target.checked })}
                          />
                          {replayUI.autoExpandThinking !== false ? "Yes" : "No"}
                        </label>
                      </td>
                    </tr>
                    <tr className="mcc-row">
                      <td data-label="Setting">Show Cost Bar</td>
                      <td data-label="Value">
                        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <input
                            type="checkbox"
                            checked={replayUI.showCostBar !== false}
                            onChange={(e) => updateReplayUI({ showCostBar: e.target.checked })}
                          />
                          {replayUI.showCostBar !== false ? "Yes" : "No"}
                        </label>
                      </td>
                    </tr>
                    <tr className="mcc-row">
                      <td data-label="Setting">Show Anomaly Badges</td>
                      <td data-label="Value">
                        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <input
                            type="checkbox"
                            checked={replayUI.showAnomalyBadges !== false}
                            onChange={(e) => updateReplayUI({ showAnomalyBadges: e.target.checked })}
                          />
                          {replayUI.showAnomalyBadges !== false ? "Yes" : "No"}
                        </label>
                      </td>
                    </tr>
                    <tr className="mcc-row">
                      <td data-label="Setting">Tool Result Max Lines</td>
                      <td data-label="Value">
                        <input
                          type="number"
                          className="mcc-input mcc-input--mono"
                          value={String(replayUI.toolResultMaxLines ?? 50)}
                          onChange={(e) => updateReplayUI({ toolResultMaxLines: Number(e.target.value) || 50 })}
                          min="5"
                        />
                      </td>
                    </tr>
                    <tr className="mcc-row">
                      <td data-label="Setting">Time Gap Threshold (sec)</td>
                      <td data-label="Value">
                        <input
                          type="number"
                          className="mcc-input mcc-input--mono"
                          value={String(replayUI.timeGapThreshold ?? 60)}
                          onChange={(e) => updateReplayUI({ timeGapThreshold: Number(e.target.value) || 60 })}
                          min="5"
                        />
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
          </>
        );
      })()}

      {/* ════════════════════════════════════════════════════════════════════════
         TAB: ALERTS
         ════════════════════════════════════════════════════════════════════════ */}
      {viewMode === "edit" && activeTab === "alerts" && (() => {
        const ALERT_CATEGORIES = [
          { id: "budget", label: "Budget & Cost", desc: "Budget threshold, exceeded, blocked, session cost, step cost" },
          { id: "session", label: "Session Health", desc: "Long session, excessive tools, context critical" },
          { id: "drift", label: "Model Drift", desc: "Unexpected drift, fallback, cron drift" },
          { id: "cron", label: "Cron Jobs", desc: "Cron failures and recoveries" },
          { id: "monitoring", label: "Agent Monitoring", desc: "Stuck loops, agent silence" },
        ] as const;
        type CategoryId = typeof ALERT_CATEGORIES[number]["id"];

        const alertRouting = (cfgAny.alertRouting ?? {}) as {
          platform?: string;
          channels?: Array<{ id: string; name: string }>;
          routing?: Record<string, string>; // category → channel id
          platformConfigs?: Record<string, { channels: Array<{ id: string; name: string }>; routing: Record<string, string> }>;
        };

        const platforms = alertPlatforms;
        const resolvingChannel = alertResolvingChannel;
        const setResolvingChannel = setAlertResolvingChannel;
        const newChannelId = alertNewChannelId;
        const setNewChannelId = setAlertNewChannelId;
        const resolveError = alertResolveError;
        const setResolveError = setAlertResolveError;

        const updateAlertRouting = (patch: Record<string, unknown>) => {
          const updated = { ...alertRouting, ...patch };
          setConfig({ ...config, alertRouting: updated } as typeof config);
          setSaveStatus("idle");
        };

        const selectedPlatform = alertRouting.platform ?? "";
        const platformConfigs = alertRouting.platformConfigs ?? {};
        const channels = alertRouting.channels ?? [];
        const routing = alertRouting.routing ?? {};

        const addChannel = async () => {
          if (!newChannelId.trim() || !selectedPlatform) return;
          setResolvingChannel(true);
          setResolveError("");
          try {
            const res = await fetch("/api/resolve-channel", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ platform: selectedPlatform, channelId: newChannelId.trim() }),
            });
            const data = await res.json();
            if (!data.ok) {
              setResolveError(data.error ?? "Failed to resolve channel");
              return;
            }
            const newChannel = { id: newChannelId.trim(), name: data.name };
            const updated = [...channels, newChannel];
            // If this is the first channel, set all categories to route to it
            if (channels.length === 0) {
              const defaultRouting: Record<string, string> = {};
              for (const cat of ALERT_CATEGORIES) {
                defaultRouting[cat.id] = newChannel.id;
              }
              updateAlertRouting({ channels: updated, routing: defaultRouting });
            } else {
              updateAlertRouting({ channels: updated });
            }
            setNewChannelId("");
          } catch (err) {
            setResolveError(String(err));
          } finally {
            setResolvingChannel(false);
          }
        };

        const removeChannel = (channelId: string) => {
          const updated = channels.filter((c) => c.id !== channelId);
          // Remove routing entries pointing to this channel
          const updatedRouting = { ...routing };
          for (const [cat, id] of Object.entries(updatedRouting)) {
            if (id === channelId) {
              // Fall back to first remaining channel or remove
              updatedRouting[cat] = updated[0]?.id ?? "";
            }
          }
          updateAlertRouting({ channels: updated, routing: updatedRouting });
        };

        return (
          <>
            <div className="mcc-file-group">
              <div className="mcc-file-group-header">
                <span>Alert Routing</span>
                <span className="mcc-file-group-note">Configure where system alerts are sent</span>
              </div>
            </div>

            {/* Platform Selection */}
            <section className="mcc-section">
              <div className="mcc-section-header">
                <h3 className="mcc-section-title">Platform</h3>
                <span className="mcc-section-note">Select which messaging platform receives alerts</span>
              </div>
              <div className="mcc-table-wrap">
                <table className="mcc-table mcc-table--kv">
                  <tbody>
                    <tr className="mcc-row">
                      <td data-label="Setting">Platform</td>
                      <td data-label="Value">
                        {platforms.length > 0 ? (
                          <div className="mcc-radio-group mcc-radio-group--inline">
                            {platforms.map((p) => (
                              <label key={p.id} className={`mcc-radio-option${selectedPlatform === p.id ? " mcc-radio-option--active" : ""}${!p.available ? " mcc-radio-option--disabled" : ""}`}>
                                <input
                                  type="radio"
                                  name="alertPlatform"
                                  value={p.id}
                                  checked={selectedPlatform === p.id}
                                  disabled={!p.available}
                                  onChange={() => {
                                    // Save current platform's config before switching
                                    const saved = { ...platformConfigs };
                                    if (selectedPlatform && channels.length > 0) {
                                      saved[selectedPlatform] = { channels, routing };
                                    }
                                    // Restore target platform's config if previously saved
                                    const restored = saved[p.id];
                                    updateAlertRouting({
                                      platform: p.id,
                                      channels: restored?.channels ?? [],
                                      routing: restored?.routing ?? {},
                                      platformConfigs: saved,
                                    });
                                  }}
                                />
                                <span className="mcc-radio-label">{p.label}</span>
                                {!p.available && <span className="mcc-radio-desc">no bot token</span>}
                              </label>
                            ))}
                          </div>
                        ) : (
                          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Loading platforms...</span>
                        )}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>

            {/* Channels */}
            {selectedPlatform && (
              <section className="mcc-section">
                <div className="mcc-section-header">
                  <h3 className="mcc-section-title">Channels</h3>
                  <span className="mcc-section-note">Add channels where alerts will be delivered</span>
                </div>
                <div className="mcc-table-wrap">
                  <table className="mcc-table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>ID</th>
                        <th style={{ width: 60 }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {channels.map((ch) => (
                        <tr key={ch.id} className="mcc-row">
                          <td data-label="Name">#{ch.name}</td>
                          <td data-label="ID" className="mcc-mono" style={{ fontSize: 12 }}>{ch.id}</td>
                          <td>
                            <button className="mcc-btn mcc-btn--ghost mcc-btn--sm" onClick={() => removeChannel(ch.id)} title="Remove channel">
                              &times;
                            </button>
                          </td>
                        </tr>
                      ))}
                      <tr className="mcc-row">
                        <td colSpan={3}>
                          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                            <input
                              className={`mcc-input mcc-input--mono${resolveError ? " mcc-input--error" : ""}`}
                              style={{ flex: 1 }}
                              value={newChannelId}
                              onChange={(e) => { setNewChannelId(e.target.value); setResolveError(""); }}
                              placeholder={selectedPlatform === "discord" ? "Channel ID (e.g. 1234567890)" : selectedPlatform === "slack" ? "Channel ID (e.g. C0ABCDEF)" : "Chat ID (e.g. -1001234567890)"}
                              onKeyDown={(e) => { if (e.key === "Enter") addChannel(); }}
                            />
                            <button
                              className="mcc-btn mcc-btn--primary mcc-btn--sm"
                              onClick={addChannel}
                              disabled={!newChannelId.trim() || resolvingChannel}
                            >
                              {resolvingChannel ? "..." : "+ Add"}
                            </button>
                          </div>
                          {resolveError && <div style={{ color: "var(--error)", fontSize: 12, marginTop: 4 }}>{resolveError}</div>}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {/* Alert Routing */}
            {channels.length > 0 && (
              <section className="mcc-section">
                <div className="mcc-section-header">
                  <h3 className="mcc-section-title">Route Alerts</h3>
                  <span className="mcc-section-note">Choose which channel receives each alert category</span>
                </div>
                <div className="mcc-table-wrap">
                  <table className="mcc-table">
                    <thead>
                      <tr>
                        <th>Category</th>
                        <th>Description</th>
                        <th>Channel</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ALERT_CATEGORIES.map((cat) => (
                        <tr key={cat.id} className="mcc-row">
                          <td data-label="Category" style={{ fontWeight: 500 }}>{cat.label}</td>
                          <td data-label="Description" style={{ fontSize: 12, color: "var(--text-muted)" }}>{cat.desc}</td>
                          <td data-label="Channel">
                            {channels.length === 1 ? (
                              <span style={{ fontSize: 13 }}>#{channels[0].name}</span>
                            ) : (
                              <select
                                className="mcc-select"
                                value={routing[cat.id] ?? channels[0]?.id ?? ""}
                                onChange={(e) => updateAlertRouting({ routing: { ...routing, [cat.id]: e.target.value } })}
                              >
                                {channels.map((ch) => (
                                  <option key={ch.id} value={ch.id}>#{ch.name}</option>
                                ))}
                              </select>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </>
        );
      })()}

      {/* ════════════════════════════════════════════════════════════════════════
         TAB: JSON
         ════════════════════════════════════════════════════════════════════════ */}
      {viewMode === "source" && (
        <>
          {/* Toolbar */}
          <div className="cfg-toolbar">
            <div className="cfg-status">
              {jsonPreviewSha && (
                <span className="cfg-status-badge cfg-status-badge--preview">Previewing: {jsonPreviewLabel}</span>
              )}
              {jsonCommits.length > 0 && (
                <button
                  className={`cfg-btn${jsonShowDiff ? " cfg-btn--active" : ""}`}
                  onClick={() => setJsonShowDiff(!jsonShowDiff)}
                >
                  Diff
                </button>
              )}
            </div>
            <div className="cfg-actions">
              {!jsonShowDiff && jsonPreviewSha && !jsonConfirmRestore && (
                <>
                  <button className="cfg-btn cfg-btn--muted" onClick={jsonDiscard}>Discard</button>
                  <button className="cfg-btn cfg-btn--primary" onClick={() => setJsonConfirmRestore(true)}>
                    Restore
                  </button>
                </>
              )}
              {jsonConfirmRestore && (
                <>
                  <span className="cfg-confirm-warn">Overwrite current file with this version?</span>
                  <button className="cfg-btn" onClick={() => setJsonConfirmRestore(false)}>Cancel</button>
                  <button className="cfg-btn cfg-btn--danger" onClick={jsonRestore} disabled={jsonRestoreStatus === "restoring"}>
                    {jsonRestoreStatus === "restoring" ? "Restoring..." : "Confirm Restore"}
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Diff selectors */}
          {jsonShowDiff && jsonCommits.length > 0 && (
            <div className="fv-diff-bar">
              <span className="fv-diff-label">From:</span>
              <select className="fv-git-select" value={jsonDiffFrom} onChange={e => setJsonDiffFrom(e.target.value)}>
                {jsonCommits.map(c => (
                  <option key={c.sha} value={c.sha}>
                    {c.short} — {c.message.slice(0, 50)} ({jsonRelativeTime(c.date)})
                  </option>
                ))}
              </select>
              <span className="fv-diff-label">To:</span>
              <select className="fv-git-select" value={jsonDiffTo} onChange={e => setJsonDiffTo(e.target.value)}>
                <option value="working">Working copy</option>
                {jsonCommits.map(c => (
                  <option key={c.sha} value={c.sha}>
                    {c.short} — {c.message.slice(0, 50)} ({jsonRelativeTime(c.date)})
                  </option>
                ))}
              </select>
              <button className="cfg-btn" onClick={() => setJsonShowDiff(false)}>Close</button>
            </div>
          )}

          <div className="cfg-layout">
            {/* Left: Read-only editor or diff */}
            <div className="cfg-editor-panel">
              {/* Diff view */}
              {jsonShowDiff && (
                <div className="fv-diff" style={{ flex: 1 }}>
                  {jsonDiffLoading && <div className="loading" style={{ padding: 20 }}>Loading diff...</div>}
                  {!jsonDiffLoading && jsonDiffLines.length === 0 && <div className="fv-diff-empty">No changes between these versions</div>}
                  {!jsonDiffLoading && jsonDiffLines.map((line, i) => (
                    <div key={i} className={`fv-diff-line fv-diff-line--${line.type}`}>
                      <span className="fv-diff-gutter">
                        {line.type === "del" ? line.oldLine : line.type === "add" ? line.newLine : line.type === "ctx" ? line.newLine : ""}
                      </span>
                      <span className="fv-diff-sign">
                        {line.type === "add" ? "+" : line.type === "del" ? "-" : line.type === "ctx" ? " " : ""}
                      </span>
                      <span className="fv-diff-text">{line.content}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Read-only textarea (hidden when diff is active) */}
              {!jsonShowDiff && (
                <textarea
                  className="cfg-textarea"
                  value={jsonContent}
                  readOnly
                  spellCheck={false}
                />
              )}
            </div>

            {/* Right: Git history */}
            <div className="cfg-backups-panel">
              <div className="cfg-backups-header">
                <span className="cfg-backups-title">History</span>
                <span className="cfg-backups-count">{jsonCommits.length}</span>
              </div>
              <div className="cfg-backups-list">
                {jsonCommits.length === 0 && (
                  <p className="cfg-backups-empty">No git history found</p>
                )}
                {jsonCommits.map((c) => (
                  <div
                    key={c.sha}
                    className={`cfg-backup-item${jsonPreviewSha === c.sha ? " cfg-backup-item--active" : ""}`}
                  >
                    <div className="cfg-backup-top">
                      <span className="cfg-backup-source cfg-backup-source--git">git</span>
                      <span className="cfg-backup-time">{jsonRelativeTime(c.date)}</span>
                    </div>
                    <div className="cfg-backup-label">{c.message}</div>
                    <div className="cfg-backup-actions">
                      <button className="cfg-btn cfg-btn--sm" onClick={() => jsonPreview(c.sha, c.message)}>Preview</button>
                      <button
                        className={`cfg-btn cfg-btn--sm${jsonShowDiff && jsonDiffFrom === c.sha ? " cfg-btn--active" : ""}`}
                        onClick={() => { setJsonDiffFrom(c.sha); setJsonDiffTo("working"); setJsonShowDiff(true); }}
                      >
                        Diff
                      </button>
                      <button className="cfg-btn cfg-btn--sm" onClick={() => jsonPreview(c.sha, c.message)}>Restore</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      {/* Modals */}
      {showAddAgent && (
        <AddAgentModal
          existingKeys={existingAgentKeys}
          onAdd={addAgent}
          onClose={() => setShowAddAgent(false)}
        />
      )}
      {showAddChannel && (
        <AddChannelModal
          existingNames={existingChannelNames}
          onAdd={addLogChannel}
          onClose={() => setShowAddChannel(false)}
        />
      )}

      {/* Sticky bottom save bar (Deck config tabs only) */}
      {mcTab && isDirty && (
        <div className="mcc-sticky-save">
          <span className="mcc-sticky-save-label">Unsaved changes</span>
          <div className="mcc-sticky-save-actions">
            <button className="mcc-btn" onClick={handleDiscard}>Discard</button>
            <button className="mcc-btn mcc-btn--primary" onClick={handleSave} disabled={!canSave || saveStatus === "saving"}>
              {saveStatus === "saving" ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      )}

      {/* Toast notification */}
      {toast && (
        <div
          className={`mcc-toast mcc-toast--${toast.type}`}
          onClick={() => setToast(null)}
        >
          {toast.message}
        </div>
      )}
    </div>
  );
}
