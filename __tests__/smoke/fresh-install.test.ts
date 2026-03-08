/**
 * Smoke tests — validate a fresh install would work without any services running.
 *
 * These tests check for common issues discovered during the MC → Deck rename:
 * - Missing directories / bootstrap failures
 * - Hardcoded paths or directory names
 * - Stale env var / label references
 * - Config file validity
 *
 * Run: pnpm test:smoke
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const ROOT = path.resolve(__dirname, "../..");

// ── Bootstrap ────────────────────────────────────────────────────────────────

describe("Bootstrap script", () => {
  it("bootstrap-config.mjs exists and is valid", () => {
    const script = path.join(ROOT, "scripts/bootstrap-config.mjs");
    assert.ok(fs.existsSync(script), "scripts/bootstrap-config.mjs should exist");
    const content = fs.readFileSync(script, "utf-8");
    assert.ok(content.includes("mkdirSync"), "Should create directories");
    assert.ok(content.includes("copyFileSync"), "Should copy example configs");
  });

  it("package.json has predev hook to run bootstrap", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
    assert.ok(pkg.scripts?.predev, "predev script should exist");
    assert.ok(
      pkg.scripts.predev.includes("bootstrap-config"),
      "predev should run bootstrap-config"
    );
  });
});

// ── Config examples ──────────────────────────────────────────────────────────

describe("Example config files", () => {
  it("deck-config.example.json is valid JSON with required keys", () => {
    const configPath = path.join(ROOT, "config/deck-config.example.json");
    assert.ok(fs.existsSync(configPath), "deck-config.example.json should exist");

    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    assert.ok(config.serviceUrls, "Should have serviceUrls");
    assert.ok(config.serviceUrls.gateway, "Should have gateway URL");
    assert.ok(config.budgets, "Should have budgets section");
    assert.ok(config.modelPricing, "Should have modelPricing");
  });

  it("deck-agents.example.json is valid JSON with agents array", () => {
    const agentsPath = path.join(ROOT, "config/deck-agents.example.json");
    assert.ok(fs.existsSync(agentsPath), "deck-agents.example.json should exist");

    const agents = JSON.parse(fs.readFileSync(agentsPath, "utf-8"));
    assert.ok(Array.isArray(agents.agents), "Should have agents array");
    assert.ok(agents.agents.length > 0, "Should have at least one agent");

    const first = agents.agents[0];
    assert.ok(first.id, "Agent should have id");
    assert.ok(first.key, "Agent should have key");
    assert.ok(first.name, "Agent should have name");
  });

  it(".env.example exists and documents key vars", () => {
    const envPath = path.join(ROOT, ".env.example");
    assert.ok(fs.existsSync(envPath), ".env.example should exist");

    const content = fs.readFileSync(envPath, "utf-8");
    assert.ok(content.includes("OPENCLAW_GATEWAY_URL"), "Should document gateway URL");
    assert.ok(content.includes("DISCORD_BOT_TOKEN_DECK"), "Should document Discord token");
    assert.ok(content.includes("DECK_ROOT"), "Should document DECK_ROOT");
  });
});

// ── Package metadata ─────────────────────────────────────────────────────────

describe("Package metadata", () => {
  it('package.json name is "openclaw-deck"', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
    assert.equal(pkg.name, "openclaw-deck");
  });
});

// ── No hardcoded paths ───────────────────────────────────────────────────────

describe("No hardcoded paths in source", () => {
  const SOURCE_GLOBS = ["app", "lib", "plugin", "components", "shared"];
  const EXCLUDED = new Set(["node_modules", ".next", "dist", ".git", "__pycache__"]);

  function collectSourceFiles(dir: string, exts: string[]): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir)) return results;

    for (const entry of fs.readdirSync(dir)) {
      if (EXCLUDED.has(entry) || entry.startsWith(".")) continue;
      const full = path.join(dir, entry);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        results.push(...collectSourceFiles(full, exts));
      } else if (exts.some((ext) => entry.endsWith(ext))) {
        results.push(full);
      }
    }
    return results;
  }

  it("no /Users/dev in TypeScript source", () => {
    const violations: string[] = [];
    for (const dir of SOURCE_GLOBS) {
      const files = collectSourceFiles(path.join(ROOT, dir), [".ts", ".tsx"]);
      for (const file of files) {
        const content = fs.readFileSync(file, "utf-8");
        if (content.includes("/Users/dev")) {
          violations.push(path.relative(ROOT, file));
        }
      }
    }
    assert.deepEqual(violations, [], `Files with hardcoded /Users/dev: ${violations.join(", ")}`);
  });

  it("no hardcoded openclaw-deck-ui directory name in source", () => {
    const violations: string[] = [];
    for (const dir of SOURCE_GLOBS) {
      const files = collectSourceFiles(path.join(ROOT, dir), [".ts", ".tsx"]);
      for (const file of files) {
        const content = fs.readFileSync(file, "utf-8");
        if (content.includes("openclaw-deck-ui")) {
          violations.push(path.relative(ROOT, file));
        }
      }
    }
    assert.deepEqual(violations, [], `Files with hardcoded openclaw-deck-ui: ${violations.join(", ")}`);
  });
});

// ── No stale MC_ references ─────────────────────────────────────────────────

describe("No stale rename artifacts", () => {
  function grepSource(pattern: string, dirs: string[], exts: string[]): string[] {
    const violations: string[] = [];
    const EXCLUDED = new Set(["node_modules", ".next", "dist", ".git", "__pycache__"]);

    function walk(dir: string) {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir)) {
        if (EXCLUDED.has(entry) || entry.startsWith(".")) continue;
        const full = path.join(dir, entry);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          walk(full);
        } else if (exts.some((ext) => entry.endsWith(ext))) {
          const content = fs.readFileSync(full, "utf-8");
          if (new RegExp(pattern).test(content)) {
            violations.push(path.relative(ROOT, full));
          }
        }
      }
    }

    for (const dir of dirs) walk(path.join(ROOT, dir));
    return violations;
  }

  it("no MC_ROOT / MC_DIR / MC_HOME env vars in source", () => {
    const violations = grepSource(
      "\\bMC_(ROOT|DIR|HOME|USAGE_DB|SYSTEM_LOG_DB|DATA_HOME|CONFIG_PATH|STATE_DIR|URL)\\b",
      ["app", "lib", "plugin", "components"],
      [".ts", ".tsx"]
    );
    assert.deepEqual(violations, [], `Files with stale MC_ env vars: ${violations.join(", ")}`);
  });

  it("no old mission-control references in source", () => {
    const violations = grepSource(
      "mission[_-]control|mc-config|mc-qa|MC_",
      ["app", "lib", "plugin", "ops-bot", "sentinel"],
      [".ts", ".tsx", ".py"]
    );
    assert.deepEqual(violations, [], `Files with old Mission Control references: ${violations.join(", ")}`);
  });

  it("no ai.openclaw.openclaw-deck label in source", () => {
    const violations = grepSource(
      "ai\\.openclaw\\.openclaw-deck",
      ["app", "lib", "plugin", "ops-bot", "sentinel"],
      [".ts", ".tsx", ".py"]
    );
    assert.deepEqual(violations, [], `Files with double-prefix label: ${violations.join(", ")}`);
  });

  it("no DISCORD_BOT_TOKEN_MC in source", () => {
    const violations = grepSource(
      "DISCORD_BOT_TOKEN_MC\\b",
      ["app", "lib", "plugin", "ops-bot", "sentinel"],
      [".ts", ".tsx", ".py"]
    );
    assert.deepEqual(violations, [], `Files with old token var: ${violations.join(", ")}`);
  });
});

// ── LaunchAgent label consistency ────────────────────────────────────────────

describe("LaunchAgent label consistency", () => {
  const VALID_LABELS = new Set([
    "ai.openclaw.deck",
    "ai.openclaw.gateway",
    "ai.openclaw.ops-bot",
    "ai.openclaw.sentinel",
  ]);

  it("all ai.openclaw.* labels in source use valid names", () => {
    const labelPattern = /ai\.openclaw\.[a-z-]+/g;
    const invalid: { file: string; label: string }[] = [];
    const dirs = ["app", "ops-bot", "sentinel"];
    const EXCLUDED = new Set(["node_modules", ".next", "dist", ".git", "__pycache__"]);

    function walk(dir: string) {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir)) {
        if (EXCLUDED.has(entry) || entry.startsWith(".")) continue;
        const full = path.join(dir, entry);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          walk(full);
        } else if (entry.endsWith(".ts") || entry.endsWith(".tsx") || entry.endsWith(".py")) {
          const content = fs.readFileSync(full, "utf-8");
          const matches = content.match(labelPattern);
          if (matches) {
            for (const m of matches) {
              if (!VALID_LABELS.has(m)) {
                invalid.push({ file: path.relative(ROOT, full), label: m });
              }
            }
          }
        }
      }
    }

    for (const dir of dirs) walk(path.join(ROOT, dir));
    if (invalid.length > 0) {
      const details = invalid.map((i) => `${i.file}: ${i.label}`).join("\n");
      assert.fail(`Invalid LaunchAgent labels found:\n${details}`);
    }
  });
});
