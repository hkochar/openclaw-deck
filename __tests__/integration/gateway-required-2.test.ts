/**
 * Integration tests — Tier 2b: Additional gateway-required routes.
 *
 * Tests gracefully skip if the gateway is not running.
 *
 * Run: npx tsx --test __tests__/integration/gateway-required-2.test.ts
 */

import { describe } from "node:test";
import assert from "node:assert/strict";
import { GET, POST, isServerUp, isGatewayUp, maybeIt } from "./helpers.js";

let serverUp = false;
let gatewayUp = false;

import { before } from "node:test";

before(async () => {
  serverUp = await isServerUp();
  if (!serverUp) {
    console.error("SKIP: Next.js dev server not running at localhost:3000");
    return;
  }
  gatewayUp = await isGatewayUp();
  if (!gatewayUp) {
    console.log("Gateway not running — gateway-dependent tests will be skipped");
  }
});

// ── GET /api/logs (proxies to gateway, falls back to SQLite) ────────────────

describe("GET /api/logs", () => {
  maybeIt(
    () => gatewayUp,
    "gateway",
    "returns 200 with events array",
    async () => {
      const { status, body } = await GET("/api/logs?endpoint=stream&limit=5");
      assert.equal(status, 200);
      // Gateway returns events array directly
      assert.ok(Array.isArray(body.events) || Array.isArray(body));
    },
  );
});

