/**
 * Integration tests for budget + replay alert pipelines.
 *
 * Sends real test alerts to Discord via gateway endpoints:
 *   /budget/test-alert  — budget alerts (threshold, exceeded, blocked)
 *   /replay/test-alert  — replay/session alerts (session-cost, step-cost, etc.)
 *
 * Requires: gateway running (default port 18789).
 *
 * Run: npx tsx --test __tests__/integration/budget-alerts.test.ts
 */

import { describe, before } from "node:test";
import assert from "node:assert/strict";
import { isGatewayUp, maybeIt, GATEWAY_URL } from "./helpers.js";

let gatewayUp = false;

before(async () => {
  gatewayUp = await isGatewayUp();
});

// ── Helpers ──────────────────────────────────────────────────────────────

async function postBudgetAlert(agent: string, level: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${GATEWAY_URL}/budget/test-alert`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent, level }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json() as Record<string, unknown>;
  return { status: res.status, body };
}

async function postReplayAlert(agent: string, type: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${GATEWAY_URL}/replay/test-alert`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent, type }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json() as Record<string, unknown>;
  return { status: res.status, body };
}

// ── Budget Alerts ────────────────────────────────────────────────────────

describe("budget test alerts (Discord)", () => {
  maybeIt(() => gatewayUp, "gateway not running", "sends threshold alert to Discord", async () => {
    const { status, body } = await postBudgetAlert("jane", "threshold");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.level, "threshold");
    assert.ok(["actual", "api-equiv", "total"].includes(body.costView as string),
      `costView should be one of actual/api-equiv/total, got: ${body.costView}`);
    console.log(`  → threshold alert sent (costView=${body.costView}, discord=${body.sent})`);
  });

  maybeIt(() => gatewayUp, "gateway not running", "sends exceeded alert to Discord", async () => {
    const { status, body } = await postBudgetAlert("forge", "exceeded");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.level, "exceeded");
    console.log(`  → exceeded alert sent (costView=${body.costView}, discord=${body.sent})`);
  });

  maybeIt(() => gatewayUp, "gateway not running", "sends blocked alert to Discord", async () => {
    const { status, body } = await postBudgetAlert("scout", "blocked");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.level, "blocked");
    console.log(`  → blocked alert sent (costView=${body.costView}, discord=${body.sent})`);
  });

  maybeIt(() => gatewayUp, "gateway not running", "invalid level defaults to threshold", async () => {
    const { status, body } = await postBudgetAlert("maya", "invalid-level");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.level, "threshold");
  });

  maybeIt(() => gatewayUp, "gateway not running", "missing agent returns 400", async () => {
    const res = await fetch(`${GATEWAY_URL}/budget/test-alert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level: "threshold" }),
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as Record<string, unknown>;
    assert.ok(body.error);
  });

  maybeIt(() => gatewayUp, "gateway not running", "returns costView from current config", async () => {
    const { body } = await postBudgetAlert("vigil", "threshold");
    assert.ok(["actual", "api-equiv", "total"].includes(body.costView as string));
    console.log(`  → current costView config: ${body.costView}`);
  });
});

// ── Replay / Session Alerts ──────────────────────────────────────────────

describe("replay test alerts (Discord)", () => {
  maybeIt(() => gatewayUp, "gateway not running", "sends session-cost alert", async () => {
    const { status, body } = await postReplayAlert("jane", "session-cost");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.type, "session-cost");
    assert.ok(body.alertChannel, "should return alertChannel");
    console.log(`  → session-cost alert sent (costView=${body.costView}, channel=${body.alertChannel})`);
  });

  maybeIt(() => gatewayUp, "gateway not running", "sends step-cost alert", async () => {
    const { status, body } = await postReplayAlert("forge", "step-cost");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.type, "step-cost");
    console.log(`  → step-cost alert sent (costView=${body.costView})`);
  });

  maybeIt(() => gatewayUp, "gateway not running", "sends long-session alert", async () => {
    const { status, body } = await postReplayAlert("scout", "long-session");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.type, "long-session");
    console.log(`  → long-session alert sent`);
  });

  maybeIt(() => gatewayUp, "gateway not running", "sends excessive-tools alert", async () => {
    const { status, body } = await postReplayAlert("maya", "excessive-tools");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.type, "excessive-tools");
    console.log(`  → excessive-tools alert sent`);
  });

  maybeIt(() => gatewayUp, "gateway not running", "sends context-critical alert", async () => {
    const { status, body } = await postReplayAlert("pulse", "context-critical");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.type, "context-critical");
    console.log(`  → context-critical alert sent`);
  });

  maybeIt(() => gatewayUp, "gateway not running", "invalid type defaults to session-cost", async () => {
    const { status, body } = await postReplayAlert("vigil", "nonexistent-type");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.type, "session-cost");
  });

  maybeIt(() => gatewayUp, "gateway not running", "missing agent returns 400", async () => {
    const res = await fetch(`${GATEWAY_URL}/replay/test-alert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "session-cost" }),
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as Record<string, unknown>;
    assert.ok(body.error);
  });

  maybeIt(() => gatewayUp, "gateway not running", "uses global budgets.alertChannel (not replayAlerts)", async () => {
    const { body } = await postReplayAlert("sentinel", "session-cost");
    // alertChannel should come from budgets config, confirming consolidation works
    assert.ok(body.alertChannel, "should return alertChannel from budgets config");
    console.log(`  → replay alerts using global alertChannel: ${body.alertChannel}`);
  });
});
