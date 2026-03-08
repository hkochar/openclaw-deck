import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import {
  agentKeys,
  agentLabels,
  agentMetadata,
  channelNames,
  agents,
  systemChannels,
  pluginChannels,
  logChannels,
  agentSessionKeys,
  agentDirs,
  serviceUrls,
  opsBotCommands,
} from "@/lib/agent-config";
import { WORKSPACE_DIR } from "@/app/api/_lib/paths";
import { stripSecrets } from "@/app/api/_lib/security";
import { logSystemEvent } from "@/app/api/_lib/system-log";
import { commitDeckConfig } from "@/app/api/_lib/config-git";

export const dynamic = "force-dynamic";

const AGENTS_PATH = path.resolve(process.cwd(), "config/deck-agents.json");
const CONFIG_PATH = path.resolve(process.cwd(), "config/deck-config.json");

/** Read fresh from disk so edits via POST are immediately visible. */
function readJsonFromDisk(filePath: string) {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Redact provider key values that look like real API keys. */
function redactProviderKeys(keys: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(keys)) {
    if (typeof v === "string") {
      result[k] = stripSecrets(v);
    } else if (v && typeof v === "object") {
      result[k] = redactProviderKeys(v as Record<string, unknown>);
    } else {
      result[k] = v;
    }
  }
  return result;
}

export async function GET() {
  const agentsDisk = readJsonFromDisk(AGENTS_PATH);
  const configDisk = readJsonFromDisk(CONFIG_PATH);

  if (agentsDisk) {
    // Build derived helpers from the on-disk config
    const agentList = agentsDisk.agents ?? [];
    const keys = agentList.map((a: { key: string }) => a.key);
    const labels = Object.fromEntries(agentList.map((a: { key: string; name: string }) => [a.key, a.name]));
    const meta = Object.fromEntries(agentList.map((a: { key: string; name: string; emoji: string }) => [a.key, { name: a.name, emoji: a.emoji }]));
    const chNames: Record<string, string> = {};
    for (const a of agentList) chNames[a.discordChannelId] = `#${a.key}`;
    for (const section of [agentsDisk.systemChannels, agentsDisk.pluginChannels, agentsDisk.logChannels]) {
      for (const [name, id] of Object.entries(section ?? {})) {
        if (id) chNames[id as string] = `#${name.replace(/([A-Z])/g, "-$1").toLowerCase()}`;
      }
    }

    const sKeys: Record<string, string> = {};
    for (const a of agentList) {
      sKeys[a.key] = `agent:${a.id}:discord:channel:${a.discordChannelId}`;
    }

    const dirs: Record<string, string> = {};
    for (const a of agentList) {
      if (a.agentDir) dirs[a.key] = `${WORKSPACE_DIR}/${a.agentDir}`;
    }

    return NextResponse.json({
      agents: agentList,
      agentKeys: keys,
      agentLabels: labels,
      agentMetadata: meta,
      channelNames: chNames,
      systemChannels: agentsDisk.systemChannels ?? {},
      pluginChannels: agentsDisk.pluginChannels ?? {},
      logChannels: agentsDisk.logChannels ?? {},
      serviceUrls: configDisk?.serviceUrls ?? {},
      dashboard: configDisk?.dashboard ?? {},
      budgets: configDisk?.budgets ?? {},
      modelPricing: configDisk?.modelPricing ?? {},
      throttleChain: configDisk?.throttleChain ?? ["opus", "sonnet", "haiku"],
      providerKeys: redactProviderKeys(configDisk?.providerKeys ?? {}),
      providerLimits: configDisk?.providerLimits ?? {},
      providerCalibration: configDisk?.providerCalibration ?? {},
      sessionGuardrails: configDisk?.sessionGuardrails ?? configDisk?.replayAlerts ?? {},
      replayUI: configDisk?.replayUI ?? {},
      alertRouting: configDisk?.alertRouting ?? {},
      opsBotCommands: agentsDisk.opsBotCommands ?? {},
      sessionKeys: sKeys,
      agentDirs: dirs,
    });
  }

  // Fallback to cached module imports
  return NextResponse.json({
    agents: agents(),
    agentKeys: agentKeys(),
    agentLabels: agentLabels(),
    agentMetadata: agentMetadata(),
    channelNames: channelNames(),
    systemChannels: systemChannels(),
    pluginChannels: pluginChannels(),
    logChannels: logChannels(),
    serviceUrls: serviceUrls(),
    opsBotCommands: opsBotCommands(),
    sessionKeys: agentSessionKeys(),
    agentDirs: agentDirs(WORKSPACE_DIR),
  });
}

// ── Validation ───────────────────────────────────────────────────────────────

interface AgentInput {
  id?: string;
  key?: string;
  name?: string;
  role?: string;
  emoji?: string;
  discordChannelId?: string;
  agentDir?: string;
}

function isNumericString(s: string): boolean {
  return /^\d{10,25}$/.test(s);
}

/** Validate a channel ref: bare snowflake or platform:id format. */
function isValidChannelRef(s: string): boolean {
  const trimmed = s.trim();
  if (!trimmed) return false;
  if (isNumericString(trimmed)) return true;
  const match = trimmed.match(/^(discord|slack|telegram):(.+)$/);
  if (match) {
    if (match[1] === "discord") return isNumericString(match[2]);
    return match[2].length > 0;
  }
  return false;
}

function validateDeckConfig(body: {
  agents?: AgentInput[];
  systemChannels?: Record<string, string>;
  pluginChannels?: Record<string, string>;
  logChannels?: Record<string, string>;
  serviceUrls?: Record<string, string>;
}): string[] {
  const errors: string[] = [];

  // Agents
  if (!Array.isArray(body.agents) || body.agents.length === 0) {
    errors.push("agents must be a non-empty array");
    return errors;
  }

  const seenKeys = new Set<string>();
  const seenIds = new Set<string>();

  for (let i = 0; i < body.agents.length; i++) {
    const a = body.agents[i];
    const label = `Agent #${i + 1}`;

    if (!a.key || !a.key.trim()) errors.push(`${label}: key is required`);
    if (!a.id || !a.id.trim()) errors.push(`${label}: id is required`);
    if (!a.name || !a.name.trim()) errors.push(`${label}: name is required`);
    if (!a.emoji || !a.emoji.trim()) errors.push(`${label}: emoji is required`);
    if (!a.discordChannelId || !a.discordChannelId.trim()) {
      errors.push(`${label}: discordChannelId is required`);
    } else if (!isValidChannelRef(a.discordChannelId.trim())) {
      errors.push(`${label}: discordChannelId must be a channel ID (discord:ID, slack:ID, or telegram:ID)`);
    }

    if (a.key && seenKeys.has(a.key)) errors.push(`${label}: duplicate key "${a.key}"`);
    if (a.id && seenIds.has(a.id)) errors.push(`${label}: duplicate id "${a.id}"`);
    if (a.key) seenKeys.add(a.key);
    if (a.id) seenIds.add(a.id);
  }

  // Validate locked channel sections — required keys must be present
  function validateChannelSection(
    section: Record<string, string> | undefined,
    sectionName: string,
    requiredKeys: string[],
  ) {
    if (!section || typeof section !== "object") {
      errors.push(`${sectionName} is required`);
      return;
    }
    for (const key of requiredKeys) {
      if (!(key in section)) {
        errors.push(`${sectionName} "${key}" is required`);
      }
    }
    for (const [name, id] of Object.entries(section)) {
      if (id && id.trim() && !isValidChannelRef(id.trim())) {
        errors.push(`${sectionName} "${name}": must be a channel ID (discord:ID, slack:ID, or telegram:ID)`);
      }
    }
  }

  validateChannelSection(body.systemChannels, "System channel", ["systemStatus", "agentMonitoring"]);
  validateChannelSection(body.pluginChannels, "Plugin channel", ["model-drift"]);

  // Log channels — optional, but validate IDs if present
  if (body.logChannels && typeof body.logChannels === "object") {
    for (const [name, id] of Object.entries(body.logChannels)) {
      if (!id || !isValidChannelRef(id.trim())) {
        errors.push(`Log channel "${name}": must be a channel ID (discord:ID, slack:ID, or telegram:ID)`);
      }
    }
  }

  // Service URLs — validate format if present
  if (body.serviceUrls && typeof body.serviceUrls === "object") {
    for (const [name, url] of Object.entries(body.serviceUrls)) {
      if (url && url.trim() && !/^https?:\/\/.+/.test(url.trim())) {
        errors.push(`Service URL "${name}": must start with http:// or https://`);
      }
    }
  }

  return errors;
}

// ── Diff helper ──────────────────────────────────────────────────────────────

function diffChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  prefix = "",
): string[] {
  const changes: string[] = [];
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const key of allKeys) {
    const path = prefix ? `${prefix}.${key}` : key;
    const oldVal = before[key];
    const newVal = after[key];

    if (
      oldVal !== null && newVal !== null &&
      typeof oldVal === "object" && typeof newVal === "object" &&
      !Array.isArray(oldVal) && !Array.isArray(newVal)
    ) {
      changes.push(
        ...diffChanges(
          oldVal as Record<string, unknown>,
          newVal as Record<string, unknown>,
          path,
        ),
      );
    } else if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      changes.push(`${path}: ${JSON.stringify(oldVal)} → ${JSON.stringify(newVal)}`);
    }
  }
  return changes;
}

// ── POST: save config ────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const errors = validateDeckConfig(body);
    if (errors.length > 0) {
      return NextResponse.json({ ok: false, errors }, { status: 400 });
    }

    const trimEntries = (obj: Record<string, unknown> | undefined) =>
      Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [k, (v as string).trim()]));

    // agents.json — agents + channel sections
    const agentsConfig = {
      agents: body.agents.map((a: AgentInput) => ({
        id: a.id!.trim(),
        key: a.key!.trim(),
        name: a.name!.trim(),
        role: (a.role || "").trim(),
        emoji: a.emoji!.trim(),
        discordChannelId: a.discordChannelId!.trim(),
        agentDir: (a.agentDir || "").trim(),
      })),
      systemChannels: trimEntries(body.systemChannels),
      pluginChannels: trimEntries(body.pluginChannels),
      logChannels: trimEntries(body.logChannels),
      opsBotCommands: body.opsBotCommands ?? {},
    };

    // config.json — service URLs + future non-agent settings
    const deckConfig: Record<string, unknown> = {
      serviceUrls: trimEntries(body.serviceUrls),
    };

    // Preserve dashboard prefs (passed through without validation)
    if (body.dashboard && typeof body.dashboard === "object") {
      deckConfig.dashboard = body.dashboard;
    } else {
      const existing = readJsonFromDisk(CONFIG_PATH);
      if (existing?.dashboard) deckConfig.dashboard = existing.dashboard;
    }

    // Preserve budget/pricing/throttle config
    const existingConfig = readJsonFromDisk(CONFIG_PATH) ?? {};
    deckConfig.budgets = body.budgets ?? existingConfig.budgets ?? {};
    deckConfig.modelPricing = body.modelPricing ?? existingConfig.modelPricing ?? {};
    deckConfig.throttleChain = body.throttleChain ?? existingConfig.throttleChain ?? ["opus", "sonnet", "haiku"];
    deckConfig.providerKeys = body.providerKeys ?? existingConfig.providerKeys ?? {};
    deckConfig.providerLimits = body.providerLimits ?? existingConfig.providerLimits ?? {};
    deckConfig.providerCalibration = body.providerCalibration ?? existingConfig.providerCalibration ?? {};
    deckConfig.sessionGuardrails = body.sessionGuardrails ?? existingConfig.sessionGuardrails ?? existingConfig.replayAlerts ?? {};
    // Clean up legacy key
    delete deckConfig.replayAlerts;
    deckConfig.replayUI = body.replayUI ?? existingConfig.replayUI ?? {};
    deckConfig.alertRouting = body.alertRouting ?? existingConfig.alertRouting ?? {};

    // Read previous state for diffing
    const prevAgents = readJsonFromDisk(AGENTS_PATH) ?? {};
    const prevConfig = readJsonFromDisk(CONFIG_PATH) ?? {};

    fs.writeFileSync(AGENTS_PATH, JSON.stringify(agentsConfig, null, 2) + "\n", "utf-8");
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(deckConfig, null, 2) + "\n", "utf-8");

    const agentChanges = diffChanges(prevAgents, agentsConfig);
    const configChanges = diffChanges(prevConfig, deckConfig);
    const allChanges = [...agentChanges, ...configChanges];

    logSystemEvent({
      category: "config",
      action: "save",
      summary: allChanges.length > 0
        ? `Deck config: ${allChanges.join(", ")}`
        : "Deck config saved (no changes)",
      detail: {
        files: ["config/deck-agents.json", "config/deck-config.json"],
        changes: allChanges,
      },
      status: "ok",
    });

    if (allChanges.length > 0) {
      commitDeckConfig(allChanges.slice(0, 3).join(", "));
    }

    // Categorize changes so the frontend knows what needs restarting
    const restarts: string[] = [];
    const hasAgentChanges = agentChanges.some((c) => c.startsWith("agents"));
    const hasChannelChanges = agentChanges.some((c) =>
      c.startsWith("systemChannels") ||
      c.startsWith("pluginChannels") || c.startsWith("logChannels"),
    );
    const hasOpsBotChanges = agentChanges.some((c) => c.startsWith("opsBotCommands"));
    const hasServiceUrlChanges = configChanges.some((c) => c.startsWith("serviceUrls"));
    const hasAlertRoutingChanges = configChanges.some((c) => c.startsWith("alertRouting"));

    if (hasAgentChanges || hasChannelChanges || hasAlertRoutingChanges) restarts.push("gateway");
    if (hasAgentChanges || hasChannelChanges) restarts.push("ops-bot");
    if (hasServiceUrlChanges) restarts.push("deck");

    return NextResponse.json({
      ok: true,
      changes: allChanges,
      restarts,
      immediate: hasOpsBotChanges && restarts.length === 0
        ? ["Ops-bot command permissions (effective immediately)"]
        : [],
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, errors: [err instanceof Error ? err.message : String(err)] },
      { status: 500 }
    );
  }
}
