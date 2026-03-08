import { execSync, execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { logSystemEvent } from "./system-log";
import { WORKSPACE_DIR, DECK_DIR, loadEnv } from "./paths";
import { systemChannels } from "@/lib/agent-config";
const DISCORD_CHANNELS = systemChannels();

const DECK_HOME = path.join(process.env.HOME || "~", ".openclaw-deck");
const LOG_PATH = path.join(DECK_HOME, "logs", "config-changes.log");

function appendLog(entry: string): void {
  try {
    const dir = path.dirname(LOG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${entry}\n`, "utf-8");
  } catch {}
}

export async function notifyDiscord(message: string): Promise<void> {
  const env = loadEnv();
  const botToken = env["DISCORD_BOT_TOKEN_DECK"] || env["DISCORD_BOT_TOKEN"] || "";
  if (!botToken) return;

  try {
    await fetch(`https://discord.com/api/v10/channels/${DISCORD_CHANNELS.systemStatus}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bot ${botToken}`,
      },
      body: JSON.stringify({ content: message }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {}
}


/** Resolve git author — user's config if available, otherwise a generic bot tag. */
function getGitAuthor(repoDir: string): string {
  try {
    const name = execSync("git config user.name", { cwd: repoDir, encoding: "utf-8", timeout: 3_000 }).trim();
    const email = execSync("git config user.email", { cwd: repoDir, encoding: "utf-8", timeout: 3_000 }).trim();
    if (name && email) return `${name} <${email}>`;
  } catch {}
  return "Deck Bot <noreply@localhost>";
}

/**
 * Stage specific files and commit to git in the given repo directory.
 * Fire-and-forget — logs success/failure but never throws.
 */
function commitFiles(repoDir: string, files: string[], reason: string): void {
  try {
    const author = getGitAuthor(repoDir);
    execFileSync("git", ["add", "-f", ...files], {
      cwd: repoDir,
      encoding: "utf-8",
      timeout: 5_000,
    });
    execFileSync("git", ["commit", `--author=${author}`, "-m", `config: ${reason}`], {
      cwd: repoDir,
      encoding: "utf-8",
      timeout: 5_000,
    });
    appendLog(`[OK] ${reason}`);
    logSystemEvent({ category: "git", action: "commit", summary: `Config committed: ${reason}`, status: "ok" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stderr = (err as { stderr?: Buffer | string })?.stderr?.toString?.() || "";
    const stdout = (err as { stdout?: Buffer | string })?.stdout?.toString?.() || "";
    const combined = msg + stderr + stdout;
    // "nothing to commit" is normal — don't alert
    if (combined.includes("nothing to commit") || combined.includes("no changes added") || combined.includes("nothing added to commit")) {
      appendLog(`[SKIP] ${reason} (no changes)`);
      return;
    }
    appendLog(`[FAIL] ${reason} — ${msg.slice(0, 200)}`);
    logSystemEvent({ category: "git", action: "commit", summary: `Git commit failed: ${reason}`, detail: { error: msg.slice(0, 500) }, status: "error" });
    notifyDiscord(
      `**Config git commit failed**\n` +
      `**Reason:** ${reason}\n` +
      `**Error:** \`${msg.slice(0, 300)}\``
    ).catch(() => {});
  }
}

/**
 * Copy openclaw.json to the workspace repo and git-commit it for rollback.
 *
 * openclaw.json is safe to track — Discord tokens use env-var syntax
 * (${DISCORD_BOT_TOKEN_...}), auth profiles only have provider/mode metadata.
 * Actual API keys live in separate auth-profiles.json files (gitignored).
 */
export function commitConfigChange(reason: string): void {
  const src = path.join(process.env.HOME || "~", ".openclaw", "openclaw.json");
  const dst = path.join(WORKSPACE_DIR, "openclaw.json");
  try {
    fs.copyFileSync(src, dst);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendLog(`[FAIL] copy openclaw.json — ${msg.slice(0, 200)}`);
    logSystemEvent({ category: "config", action: "change", summary: reason, detail: { error: `copy failed: ${msg.slice(0, 300)}` }, status: "error" });
    return;
  }
  commitFiles(WORKSPACE_DIR, ["openclaw.json"], reason);
}

/** Auto-commit deck-sentinel.json in Deck dashboard repo. */
export function commitSentinelConfig(reason: string): void {
  commitFiles(DECK_DIR, ["sentinel/deck-sentinel.json"], reason);
}

/** Auto-commit Deck dashboard config files (deck-agents.json, deck-config.json). */
export function commitDeckConfig(reason: string): void {
  commitFiles(DECK_DIR, ["config/deck-agents.json", "config/deck-config.json"], reason);
}

/** Auto-commit a single file in the workspace repo. */
export function commitWorkspaceFile(filePath: string, reason: string): void {
  commitFiles(WORKSPACE_DIR, [filePath], reason);
}
