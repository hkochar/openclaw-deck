import { NextResponse } from "next/server";
import { execSync } from "child_process";
import { loadEnv, WORKSPACE_DIR } from "@/app/api/_lib/paths";
import path from "path";

export const dynamic = "force-dynamic";

interface EnvVarDef {
  key: string;
  category: string;
  description: string;
  required: boolean;
  source: "~/.openclaw/.env" | ".env.local";
}

const ENV_VARS: EnvVarDef[] = [
  // ── ~/.openclaw/.env (shared across services) ──────────────────────────

  // Discord bot tokens (used by Deck dashboard, sentinel, ops-bot)
  { key: "DISCORD_BOT_TOKEN_DECK", category: "Discord", description: "Deck Bridge bot token (primary)", required: true, source: "~/.openclaw/.env" },
  { key: "DISCORD_BOT_TOKEN", category: "Discord", description: "Discord bot token (fallback)", required: false, source: "~/.openclaw/.env" },

  // Gateway
  { key: "OPENCLAW_GATEWAY_URL", category: "Gateway", description: "Gateway HTTP endpoint (overrides config)", required: false, source: "~/.openclaw/.env" },
  { key: "OPENCLAW_GATEWAY_TOKEN", category: "Gateway", description: "Gateway API bearer token", required: true, source: "~/.openclaw/.env" },

  // LLM API keys
  { key: "ANTHROPIC_API_KEY", category: "LLM Keys", description: "Anthropic API key (model swap smoke tests)", required: false, source: "~/.openclaw/.env" },
  { key: "OPENROUTER_API_KEY", category: "LLM Keys", description: "OpenRouter API key (model swap smoke tests)", required: false, source: "~/.openclaw/.env" },
  { key: "OPENAI_API_KEY", category: "LLM Keys", description: "OpenAI API key (model swap smoke tests)", required: false, source: "~/.openclaw/.env" },
  { key: "NVIDIA_API_KEY", category: "LLM Keys", description: "NVIDIA API key (model swap smoke tests)", required: false, source: "~/.openclaw/.env" },

  // ── .env.local (Deck dashboard only) ─────────────────────────────────────

  // Paths (optional overrides)
  { key: "DECK_SYSTEM_LOG_DB", category: "Paths", description: "System audit log DB (default: data/deck-system.db)", required: false, source: ".env.local" },
  { key: "DECK_USAGE_DB", category: "Paths", description: "Deck usage/cost log DB (default: ~/.openclaw-deck/data/usage.db)", required: false, source: ".env.local" },
];

export async function GET() {
  const env = loadEnv();
  const processEnv = process.env;

  const results = ENV_VARS.map((def) => {
    // Check both .env file and process.env
    const value = env[def.key] || processEnv[def.key] || "";
    const isSet = value.length > 0;
    // Show masked preview: first 4 chars + "..."
    const preview = isSet && value.length > 8
      ? value.slice(0, 4) + "..." + value.slice(-3)
      : isSet ? "***" : "";

    return {
      ...def,
      isSet,
      preview,
    };
  });

  // Git identity check — needed for auto-committing config changes
  const git: Record<string, { name: string; email: string; isSet: boolean }> = {};
  const deckDir = process.cwd();
  for (const [label, dir] of [["workspace", WORKSPACE_DIR], ["deck-dashboard", deckDir]] as const) {
    let name = "";
    let email = "";
    try {
      name = execSync("git config user.name", { cwd: dir, encoding: "utf-8", timeout: 3_000 }).trim();
      email = execSync("git config user.email", { cwd: dir, encoding: "utf-8", timeout: 3_000 }).trim();
    } catch {}
    git[label] = { name, email, isSet: !!(name && email) };
  }

  return NextResponse.json({ vars: results, git });
}
