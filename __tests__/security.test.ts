import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripSecrets, safeErrorMessage } from "@/app/api/_lib/security";
import { safePath, safeGitSha } from "@/app/api/_lib/git-utils";

// ── stripSecrets ─────────────────────────────────────────────────────────

describe("stripSecrets", () => {
  it("no secrets → unchanged", () => {
    assert.equal(stripSecrets("no secrets here"), "no secrets here");
  });

  it("redacts sk-* pattern (Anthropic/OpenRouter)", () => {
    assert.equal(
      stripSecrets("key=sk-ant-abc123DEF456ghi789jkl012mno345pqr678"),
      "key=[REDACTED]",
    );
  });

  it("redacts sk_* pattern (OpenAI)", () => {
    assert.equal(
      stripSecrets("key=sk_abc123DEF456ghi789jkl0mn"),
      "key=[REDACTED]",
    );
  });

  it("redacts multiple secrets", () => {
    const input = "token1=sk-aaabbbcccdddeeefffggghhhiiijjjkkklll token2=sk-xxxyyyzzzaaabbbcccdddeeefffggg";
    const result = stripSecrets(input);
    assert.equal(result, "token1=[REDACTED] token2=[REDACTED]");
  });

  it("sk- alone without sufficient alphanumeric suffix is unchanged", () => {
    assert.equal(stripSecrets("sk- is not a key"), "sk- is not a key");
    assert.equal(stripSecrets("sk-short"), "sk-short"); // too short
  });

  it("redacts Discord bot tokens", () => {
    const longToken = "A".repeat(60);
    assert.equal(
      stripSecrets(`Bot ${longToken}`),
      "Bot [REDACTED]",
    );
  });

  it("redacts Bearer tokens", () => {
    const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdef";
    assert.equal(
      stripSecrets(`Bearer ${token}`),
      "Bearer [REDACTED]",
    );
  });

  it("redacts Slack bot tokens", () => {
    assert.equal(stripSecrets("xoxb-123-456-abc"), "[REDACTED]");
  });

  it("redacts Slack user tokens", () => {
    assert.equal(stripSecrets("xoxp-123-456-abc"), "[REDACTED]");
  });

  it("redacts GitHub PATs", () => {
    const pat = "ghp_" + "a".repeat(40);
    assert.equal(stripSecrets(pat), "[REDACTED]");
  });

  it("redacts GitHub user tokens", () => {
    const token = "ghu_" + "B".repeat(40);
    assert.equal(stripSecrets(token), "[REDACTED]");
  });

  it("multi-line content", () => {
    const input = "line1\nAPI_KEY=sk-ant-secret123abcdefghijklmnopqrstuvwxyz\nline3";
    const result = stripSecrets(input);
    assert.ok(result.includes("[REDACTED]"));
    assert.ok(!result.includes("secret123"));
  });

  it("empty string → empty string", () => {
    assert.equal(stripSecrets(""), "");
  });
});

// ── safeErrorMessage ─────────────────────────────────────────────────────

describe("safeErrorMessage", () => {
  it("strips secrets from Error.message", () => {
    const err = new Error("Failed with key sk-ant-secret123abcdefghijklmnopqrstuvwxyz");
    const msg = safeErrorMessage(err);
    assert.ok(msg.includes("[REDACTED]"));
    assert.ok(!msg.includes("secret123"));
  });

  it("truncates long messages to 500 chars", () => {
    const err = new Error("x".repeat(1000));
    assert.equal(safeErrorMessage(err).length, 500);
  });

  it("handles non-Error values", () => {
    assert.equal(safeErrorMessage("plain string"), "plain string");
    assert.equal(safeErrorMessage(42), "42");
  });
});

// ── safePath (path traversal + injection prevention) ─────────────────────

describe("safePath", () => {
  it("allows valid relative paths", () => {
    assert.equal(safePath("src/index.ts"), "src/index.ts");
    assert.equal(safePath("README.md"), "README.md");
    assert.equal(safePath("app/api/logs/route.ts"), "app/api/logs/route.ts");
  });

  it("rejects absolute paths", () => {
    assert.equal(safePath("/etc/passwd"), null);
    assert.equal(safePath("/home/user/file"), null);
  });

  it("rejects directory traversal", () => {
    assert.equal(safePath("../../../etc/passwd"), null);
    assert.equal(safePath("src/../../secret"), null);
    assert.equal(safePath("foo/../bar"), null);
  });

  it("rejects shell metacharacters", () => {
    assert.equal(safePath("file;rm -rf /"), null);
    assert.equal(safePath("$(whoami)"), null);
    assert.equal(safePath("`id`"), null);
    assert.equal(safePath("file|cat"), null);
    assert.equal(safePath("file&bg"), null);
    assert.equal(safePath("foo>bar"), null);
    assert.equal(safePath("a<b"), null);
    assert.equal(safePath("f*"), null);
    assert.equal(safePath("f?x"), null);
    assert.equal(safePath("f[0]"), null);
    assert.equal(safePath("a\\b"), null);
    assert.equal(safePath("a!b"), null);
    assert.equal(safePath("a#b"), null);
    assert.equal(safePath("a{b}"), null);
    assert.equal(safePath("a(b)"), null);
  });

  it("rejects newlines/carriage returns", () => {
    assert.equal(safePath("file\nname"), null);
    assert.equal(safePath("file\rname"), null);
  });
});

// ── safeGitSha ───────────────────────────────────────────────────────────

describe("safeGitSha", () => {
  it("accepts valid SHAs", () => {
    assert.ok(safeGitSha("abc1234"));
    assert.ok(safeGitSha("abc1234567890def1234567890abc123456789ab"));
  });

  it("rejects too short", () => {
    assert.ok(!safeGitSha("abc12"));
  });

  it("rejects non-hex characters", () => {
    assert.ok(!safeGitSha("abc123G"));
    assert.ok(!safeGitSha("abc123; rm -rf /"));
  });

  it("rejects empty string", () => {
    assert.ok(!safeGitSha(""));
  });
});
