/**
 * Shared path resolution and environment helpers for Deck API routes.
 *
 * All paths are derived from $HOME — no hardcoded user directories.
 */

import fs from "fs";
import path from "path";
import { serviceUrls } from "@/lib/agent-config";

const HOME = process.env.HOME || "~";

/** Root of the OpenClaw data directory (~/.openclaw) */
export const OPENCLAW_HOME = path.join(HOME, ".openclaw");

/** Workspace root (~/.openclaw/workspace) */
export const WORKSPACE_DIR = path.join(OPENCLAW_HOME, "workspace");

/** Deck Dashboard repo root (resolved from cwd — works regardless of clone directory name) */
export const DECK_DIR = process.cwd();

/** Main OpenClaw config file (~/.openclaw/openclaw.json) */
export const CONFIG_PATH = path.join(OPENCLAW_HOME, "openclaw.json");

/** OpenClaw .env file with tokens (~/.openclaw/.env) */
export const ENV_PATH = path.join(OPENCLAW_HOME, ".env");

const urls = serviceUrls();

/** Gateway HTTP URL */
export const GATEWAY_URL =
  process.env.OPENCLAW_GATEWAY_URL || urls.gateway || "http://127.0.0.1:18789";

/** Deck dashboard URL (for deep links in notifications) */
export const DECK_URL = process.env.DECK_URL || urls.deckDashboard || "http://localhost:3000";

/** System audit log SQLite DB (config changes, git commits, model swaps) */
export const SYSTEM_LOG_DB =
  process.env.DECK_SYSTEM_LOG_DB || path.join(process.cwd(), "data", "deck-system.db");

/** Deck data directory (~/.openclaw-deck) */
export const DECK_DATA_HOME = path.join(HOME, ".openclaw-deck");

/** Usage/cost log SQLite DB (created by Deck gateway plugin) */
export const USAGE_DB =
  process.env.DECK_USAGE_DB || path.join(DECK_DATA_HOME, "data", "usage.db");

/** Path to the openclaw CLI binary (defaults to PATH lookup) */
export const OPENCLAW_BIN = process.env.OPENCLAW_BIN || "openclaw";

/**
 * Parse the OpenClaw .env file into a key-value map.
 * This pattern was duplicated across 8+ route files — now centralized here.
 */
export function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    const lines = fs.readFileSync(ENV_PATH, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("="))
        continue;
      const [k, ...rest] = trimmed.split("=");
      env[k.trim()] = rest.join("=").trim();
    }
  } catch {}
  return env;
}
