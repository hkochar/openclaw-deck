/**
 * Integration tests for Slack alert delivery.
 *
 * Sends real test messages to Slack channels to verify:
 *   1. Bot token is valid and has chat:write permission
 *   2. Bot is invited to both target channels
 *   3. Alert formatting (Block Kit) renders correctly
 *
 * Requires:
 *   - SLACK_BOT_TOKEN env var (xoxb-...)
 *   - Bot invited to both channels
 *
 * Channels:
 *   system-status: C0AK5Q0AXFG
 *   model-drift:   C0AK4D9SA05
 *
 * Run: SLACK_BOT_TOKEN=xoxb-... npx tsx --test __tests__/integration/slack-alerts.test.ts
 */

import { describe, before, it } from "node:test";
import assert from "node:assert/strict";

const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN ?? "";
const CHANNELS = {
  "system-status": "C0AK5Q0AXFG",
  "model-drift": "C0AK4D9SA05",
} as const;

let hasToken = false;

before(() => {
  hasToken = SLACK_TOKEN.startsWith("xoxb-");
  if (!hasToken) {
    console.log("  ⚠ SLACK_BOT_TOKEN not set or invalid — Slack tests will be skipped");
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────

interface SlackResponse {
  ok: boolean;
  error?: string;
  channel?: string;
  ts?: string;
}

async function postSlackMessage(
  channelId: string,
  blocks: Array<Record<string, unknown>>,
  text: string,
): Promise<SlackResponse> {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SLACK_TOKEN}`,
    },
    body: JSON.stringify({ channel: channelId, blocks, text }),
    signal: AbortSignal.timeout(10_000),
  });
  return res.json() as Promise<SlackResponse>;
}

function buildAlertBlocks(title: string, icon: string, lines: string[], buttons?: Array<{ label: string; url: string }>) {
  const titleText = `${icon} *${title}*`;
  const codeBlock = "```\n" + lines.join("\n") + "\n```";
  const blocks: Array<Record<string, unknown>> = [
    { type: "section", text: { type: "mrkdwn", text: `${titleText}\n${codeBlock}` } },
  ];
  if (buttons?.length) {
    blocks.push({
      type: "actions",
      elements: buttons.map((b) => ({
        type: "button",
        text: { type: "plain_text", text: b.label },
        url: b.url,
      })),
    });
  }
  return blocks;
}

// ── Auth Test ────────────────────────────────────────────────────────────

describe("Slack token validation", () => {
  it("token is valid (auth.test)", async () => {
    if (!hasToken) return;
    const res = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { Authorization: `Bearer ${SLACK_TOKEN}` },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.json() as { ok: boolean; user?: string; team?: string; error?: string };
    assert.equal(body.ok, true, `auth.test failed: ${body.error}`);
    console.log(`  → Authenticated as ${body.user} in workspace ${body.team}`);
  });
});

// ── Channel Access Tests ────────────────────────────────────────────────

describe("Slack channel access", () => {
  for (const [name, id] of Object.entries(CHANNELS)) {
    it(`can post to #${name} (${id})`, async () => {
      if (!hasToken) return;

      const blocks = buildAlertBlocks(
        `Test Alert — #${name}`,
        "🧪",
        [
          `Channel: #${name} (${id})`,
          `Time:    ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })}`,
          `Source:  slack-alerts.test.ts`,
          `Status:  Connection verified`,
        ],
      );

      const result = await postSlackMessage(id, blocks, `Test alert for #${name}`);
      assert.equal(result.ok, true, `Failed to post to #${name}: ${result.error}`);
      assert.ok(result.ts, "Should return message timestamp");
      console.log(`  → Posted to #${name} (ts=${result.ts})`);
    });
  }
});

// ── Alert Format Tests ──────────────────────────────────────────────────

describe("Slack alert formatting", () => {
  it("budget alert renders correctly", async () => {
    if (!hasToken) return;

    const blocks = buildAlertBlocks(
      "Budget WARNING",
      "🟡",
      [
        "Agent:     jane",
        "Spent:     $4.20 / $5.00 (84%)",
        "Period:    daily",
        "Threshold: 80%",
      ],
      [{ label: "View Dashboard", url: "http://localhost:3000/budget" }],
    );

    const result = await postSlackMessage(CHANNELS["system-status"], blocks, "Budget WARNING: jane at 84%");
    assert.equal(result.ok, true, `Budget alert failed: ${result.error}`);
    console.log(`  → Budget alert posted (ts=${result.ts})`);
  });

  it("drift alert renders correctly", async () => {
    if (!hasToken) return;

    const blocks = buildAlertBlocks(
      "Model Drift Detected",
      "🔴",
      [
        "Agent:    forge",
        "Expected: claude-sonnet-4-5",
        "Actual:   claude-haiku-4-5",
        "Fallback: true",
      ],
      [{ label: "View Models", url: "http://localhost:3000/models" }],
    );

    const result = await postSlackMessage(CHANNELS["model-drift"], blocks, "Drift: forge using claude-haiku-4-5 instead of claude-sonnet-4-5");
    assert.equal(result.ok, true, `Drift alert failed: ${result.error}`);
    console.log(`  → Drift alert posted (ts=${result.ts})`);
  });

  it("session guardrail alert renders correctly", async () => {
    if (!hasToken) return;

    const blocks = buildAlertBlocks(
      "Long-Running Session",
      "🟡",
      [
        "Agent:     scout",
        "Duration:  45min (threshold: 30min)",
        "Session:   agent:main:discord:channel:123",
        "Action:    alert (no enforcement)",
      ],
    );

    const result = await postSlackMessage(CHANNELS["system-status"], blocks, "Long session: scout at 45min");
    assert.equal(result.ok, true, `Session alert failed: ${result.error}`);
    console.log(`  → Session guardrail alert posted (ts=${result.ts})`);
  });

  it("cron failure alert renders correctly", async () => {
    if (!hasToken) return;

    const blocks = buildAlertBlocks(
      "Cron Failure",
      "🔴",
      [
        "Agent:  jane",
        "Cron:   x-monitor-review",
        "Error:  Process exited with code 1",
        "Since:  2 consecutive failures",
      ],
    );

    const result = await postSlackMessage(CHANNELS["system-status"], blocks, "Cron failure: jane x-monitor-review");
    assert.equal(result.ok, true, `Cron alert failed: ${result.error}`);
    console.log(`  → Cron failure alert posted (ts=${result.ts})`);
  });
});
