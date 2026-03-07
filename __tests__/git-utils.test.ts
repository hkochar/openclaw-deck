import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { safePath, safeGitSha, parseDiff } from "@/app/api/_lib/git-utils";

// ── safePath ────────────────────────────────────────────────────────────────

describe("safePath", () => {
  it("valid simple filename", () => {
    assert.equal(safePath("openclaw.json"), "openclaw.json");
  });

  it("valid nested relative path", () => {
    assert.equal(safePath("agents/dev/AGENT.md"), "agents/dev/AGENT.md");
  });

  it("absolute path blocked", () => {
    assert.equal(safePath("/etc/passwd"), null);
  });

  it("parent directory traversal blocked", () => {
    assert.equal(safePath("../../../etc/passwd"), null);
  });

  it("embedded traversal blocked", () => {
    assert.equal(safePath("foo/../../bar"), null);
  });

  it("empty string passes (harmless)", () => {
    assert.equal(safePath(""), "");
  });
});

// ── safeGitSha ──────────────────────────────────────────────────────────────

describe("safeGitSha", () => {
  it("valid 7-char hex", () => {
    assert.equal(safeGitSha("abc1234"), true);
  });

  it("valid 40-char hex (full SHA)", () => {
    // Exactly 40 hex chars
    const sha40 = "a".repeat(40);
    assert.equal(sha40.length, 40);
    assert.equal(safeGitSha(sha40), true);
  });

  it("too short (6 chars)", () => {
    assert.equal(safeGitSha("abc123"), false);
  });

  it("too long (41 chars)", () => {
    assert.equal(safeGitSha("abc12345678901234567890123456789012345678901"), false);
  });

  it("uppercase rejected", () => {
    assert.equal(safeGitSha("ABCDEFG"), false);
  });

  it("non-hex character rejected", () => {
    assert.equal(safeGitSha("abc123g"), false);
  });

  it("empty string rejected", () => {
    assert.equal(safeGitSha(""), false);
  });
});

// ── parseDiff ───────────────────────────────────────────────────────────────

describe("parseDiff", () => {
  it("empty string returns empty array", () => {
    assert.deepEqual(parseDiff(""), []);
  });

  it("single hunk with add, del, and context", () => {
    const diff = [
      "diff --git a/file.txt b/file.txt",
      "index abc1234..def5678 100644",
      "--- a/file.txt",
      "+++ b/file.txt",
      "@@ -1,3 +1,3 @@",
      " unchanged line",
      "-old line",
      "+new line",
    ].join("\n");

    const lines = parseDiff(diff);
    // Filter out empty trailing line artifacts
    const meaningful = lines.filter((l) => l.type !== "hdr" || l.content.length > 0);

    // 4 header lines (diff, index, ---, +++) + hunk header + ctx + del + add = 8
    // The hunk header @@ line is also "hdr"
    const headers = meaningful.filter((l) => l.type === "hdr");
    assert.ok(headers.length >= 4); // diff, index, ---, +++, @@

    // Check content lines
    const ctx = meaningful.find((l) => l.type === "ctx");
    assert.ok(ctx);
    assert.equal(ctx!.content, "unchanged line");
    assert.equal(ctx!.oldLine, 1);
    assert.equal(ctx!.newLine, 1);

    const del = meaningful.find((l) => l.type === "del");
    assert.ok(del);
    assert.equal(del!.content, "old line");
    assert.equal(del!.oldLine, 2);

    const add = meaningful.find((l) => l.type === "add");
    assert.ok(add);
    assert.equal(add!.content, "new line");
    assert.equal(add!.newLine, 2);
  });

  it("multiple hunks reset line numbers", () => {
    const diff = [
      "@@ -1,2 +1,2 @@",
      " line1",
      "-old",
      "+new",
      "@@ -10,2 +10,2 @@",
      " line10",
      "-old10",
      "+new10",
    ].join("\n");

    const lines = parseDiff(diff);
    // Second hunk starts at line 10
    const secondCtx = lines.find((l) => l.content === "line10");
    assert.ok(secondCtx);
    assert.equal(secondCtx!.oldLine, 10);
    assert.equal(secondCtx!.newLine, 10);
  });

  it("hunk header without count (@@ -1 +1 @@)", () => {
    const diff = "@@ -1 +1 @@\n+added";
    const lines = parseDiff(diff);
    assert.equal(lines[0].type, "hdr");
    assert.equal(lines[1].type, "add");
    assert.equal(lines[1].newLine, 1);
  });
});
