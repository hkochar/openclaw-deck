/**
 * Bootstrap config files from examples if they don't exist.
 *
 * Runs automatically before `dev` and `build` so a fresh clone
 * works without manual file copying.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── Ensure required directories exist ────────────────────────────────
const dirs = [
  join(root, "data"),                                    // system audit log DB
  join(homedir(), ".openclaw-deck", "data"),              // usage/cost DB (plugin)
  join(homedir(), ".openclaw-deck", "state"),             // poller cursor
];

for (const dir of dirs) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    console.log(`Created directory: ${dir}`);
  }
}

// ── Copy example configs if missing ──────────────────────────────────
const pairs = [
  ["config/deck-config.example.json", "config/deck-config.json"],
  ["config/deck-agents.example.json", "config/deck-agents.json"],
  ["sentinel/deck-sentinel.example.json", "sentinel/deck-sentinel.json"],
];

for (const [example, target] of pairs) {
  const targetPath = join(root, target);
  const examplePath = join(root, example);
  if (!existsSync(targetPath) && existsSync(examplePath)) {
    copyFileSync(examplePath, targetPath);
    console.log(`Created ${target} from ${example}`);
  }
}

// ── Auto-detect gateway port from OpenClaw config ───────────────────
const deckConfig = join(root, "config", "deck-config.json");
const openclawConfig = join(homedir(), ".openclaw", "openclaw.json");

if (existsSync(deckConfig) && existsSync(openclawConfig)) {
  try {
    const oc = JSON.parse(readFileSync(openclawConfig, "utf-8"));
    const gwPort = oc?.gateway?.port;
    if (gwPort && gwPort !== 18789) {
      const deck = JSON.parse(readFileSync(deckConfig, "utf-8"));
      const currentUrl = deck?.serviceUrls?.gateway || "";
      // Only patch if still using the example default
      if (currentUrl === "http://127.0.0.1:18789") {
        deck.serviceUrls.gateway = `http://127.0.0.1:${gwPort}`;
        writeFileSync(deckConfig, JSON.stringify(deck, null, 2) + "\n");
        console.log(`Auto-detected gateway port ${gwPort} from ~/.openclaw/openclaw.json`);
      }
    }
  } catch { /* ignore — user can configure manually */ }
}

// ── Seed demo database if no real data exists ───────────────────────
const usageDb = join(homedir(), ".openclaw-deck", "data", "usage.db");
const demoDb = join(root, "data", "demo-usage.db");
const demoMarker = join(homedir(), ".openclaw-deck", "data", ".demo");

// Seed if DB doesn't exist OR is empty/schema-only (≤8KB — no real data).
// This handles the case where a previous failed run created an empty DB.
const needsSeed = !existsSync(usageDb) ||
  (existsSync(usageDb) && statSync(usageDb).size <= 8192 && !existsSync(demoMarker));

if (needsSeed && existsSync(demoDb)) {
  copyFileSync(demoDb, usageDb);
  // Write marker file so the UI can show a "demo data" banner
  writeFileSync(demoMarker, "seeded-from-demo-usage.db\n");
  console.log("Seeded demo database — dashboard will show sample data");
}
