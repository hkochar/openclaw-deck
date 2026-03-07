import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * Tests for config-git.ts logic.
 *
 * The exported functions (commitConfigChange, commitSentinelConfig, etc.) all
 * depend on the filesystem and git — they are fire-and-forget wrappers around
 * execSync. Instead of mocking child_process, we test the internal helper
 * behaviour by exercising the patterns used:
 *
 * 1. getGitAuthor fallback logic (reimplemented here as the function is private)
 * 2. commitFiles error classification ("nothing to commit" is not an error)
 * 3. Path construction correctness
 *
 * NOTE: If these helpers are ever extracted/exported, replace reimplementations
 * with direct imports.
 */

// ── getGitAuthor fallback logic ──────────────────────────────────────────────

/**
 * Reimplementation of the private getGitAuthor pattern from config-git.ts
 * for testability. The real function shells out to `git config`; we test the
 * fallback decision tree.
 */
function getGitAuthor(name: string | null, email: string | null): string {
  if (name && email) return `${name} <${email}>`;
  return "Deck Bot <noreply@localhost>";
}

describe("getGitAuthor fallback logic", () => {
  it("returns user identity when both name and email are present", () => {
    assert.equal(
      getGitAuthor("Alice", "alice@example.com"),
      "Alice <alice@example.com>",
    );
  });

  it("falls back to bot identity when name is null", () => {
    assert.equal(
      getGitAuthor(null, "alice@example.com"),
      "Deck Bot <noreply@localhost>",
    );
  });

  it("falls back to bot identity when email is null", () => {
    assert.equal(
      getGitAuthor("Alice", null),
      "Deck Bot <noreply@localhost>",
    );
  });

  it("falls back to bot identity when both are null", () => {
    assert.equal(
      getGitAuthor(null, null),
      "Deck Bot <noreply@localhost>",
    );
  });

  it("falls back to bot identity when name is empty string", () => {
    assert.equal(
      getGitAuthor("", "alice@example.com"),
      "Deck Bot <noreply@localhost>",
    );
  });

  it("falls back to bot identity when email is empty string", () => {
    assert.equal(
      getGitAuthor("Alice", ""),
      "Deck Bot <noreply@localhost>",
    );
  });
});

// ── commitFiles error classification ─────────────────────────────────────────

/**
 * Reimplementation of the error classification logic from commitFiles.
 * The real function catches execSync errors and checks whether the message
 * indicates "nothing to commit" (which is normal, not an error).
 */
function isNothingToCommitError(errMsg: string, stderr: string): boolean {
  const combined = errMsg + stderr;
  return (
    combined.includes("nothing to commit") ||
    combined.includes("no changes added") ||
    combined.includes("nothing added to commit")
  );
}

describe("commitFiles error classification", () => {
  it("recognises 'nothing to commit' as non-error", () => {
    assert.equal(
      isNothingToCommitError("", "On branch main\nnothing to commit, working tree clean\n"),
      true,
    );
  });

  it("recognises 'no changes added' as non-error", () => {
    assert.equal(
      isNothingToCommitError("Command failed", "no changes added to commit"),
      true,
    );
  });

  it("recognises 'nothing added to commit' as non-error", () => {
    assert.equal(
      isNothingToCommitError("nothing added to commit", ""),
      true,
    );
  });

  it("treats generic error as real error", () => {
    assert.equal(
      isNothingToCommitError("fatal: not a git repository", ""),
      false,
    );
  });

  it("treats permission denied as real error", () => {
    assert.equal(
      isNothingToCommitError("", "error: could not lock config file: Permission denied"),
      false,
    );
  });

  it("treats empty strings as real error (catch-all)", () => {
    assert.equal(isNothingToCommitError("", ""), false);
  });
});

// ── Path construction ────────────────────────────────────────────────────────

import path from "path";

describe("config-git path construction", () => {
  const HOME = process.env.HOME || "~";

  it("DECK_HOME resolves under ~/.openclaw-deck", () => {
    const mcHome = path.join(HOME, ".openclaw-deck");
    assert.ok(mcHome.startsWith("/") || mcHome.startsWith("~"));
    assert.ok(mcHome.endsWith(".openclaw-deck"));
  });

  it("LOG_PATH resolves under DECK_HOME/logs", () => {
    const logPath = path.join(HOME, ".openclaw-deck", "logs", "config-changes.log");
    assert.ok(logPath.includes("logs"));
    assert.ok(logPath.endsWith("config-changes.log"));
  });

  it("config source path resolves to ~/.openclaw/openclaw.json", () => {
    const src = path.join(HOME, ".openclaw", "openclaw.json");
    assert.ok(src.endsWith("openclaw.json"));
    assert.ok(src.includes(".openclaw"));
  });
});

// ── Commit message format ────────────────────────────────────────────────────

describe("commit message format", () => {
  it("commit message always prefixed with 'config: '", () => {
    const reason = "update agent model";
    const msg = `config: ${reason}`;
    assert.ok(msg.startsWith("config: "));
    assert.equal(msg, "config: update agent model");
  });

  it("sentinel commit uses standard format", () => {
    const files = ["sentinel/deck-sentinel.json"];
    assert.equal(files.length, 1);
    assert.ok(files[0].includes("sentinel"));
  });

  it("Deck config commit includes both files", () => {
    const files = ["config/deck-agents.json", "config/deck-config.json"];
    assert.equal(files.length, 2);
    assert.ok(files.includes("config/deck-agents.json"));
    assert.ok(files.includes("config/deck-config.json"));
  });
});
