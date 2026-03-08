/**
 * Service smoke tests — validate running services respond correctly.
 *
 * Tests gracefully skip if services are not running.
 *
 * Run: pnpm test:smoke:live
 */

import { describe, before } from "node:test";
import assert from "node:assert/strict";

const BASE_URL = process.env.DECK_TEST_URL ?? "http://localhost:3000";
const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL ?? "http://127.0.0.1:18789";

let deckUp = false;
let gatewayUp = false;

async function probe(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(3_000) });
    return true;
  } catch {
    return false;
  }
}

function maybeIt(
  getCondition: () => boolean,
  reason: string,
  name: string,
  fn: () => Promise<void>,
) {
  // Use dynamic import to avoid test runner issues
  const { it } = require("node:test");
  it(name, async () => {
    if (!getCondition()) return;
    await fn();
  });
}

before(async () => {
  deckUp = await probe(BASE_URL);
  if (!deckUp) console.log(`SKIP: Deck not running at ${BASE_URL}`);

  gatewayUp = await probe(GATEWAY_URL);
  if (!gatewayUp) console.log(`SKIP: Gateway not running at ${GATEWAY_URL}`);
});

// ── Deck dashboard ───────────────────────────────────────────────────────────

describe("Deck dashboard", () => {
  maybeIt(() => deckUp, "deck", "homepage returns 200", async () => {
    const res = await fetch(BASE_URL, { signal: AbortSignal.timeout(5_000) });
    assert.equal(res.status, 200);
  });

  maybeIt(() => deckUp, "deck", "services API returns JSON", async () => {
    const res = await fetch(`${BASE_URL}/api/services`, {
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(typeof data, "object");
  });

  maybeIt(() => deckUp, "deck", "agent-docs API returns array", async () => {
    const res = await fetch(`${BASE_URL}/api/agent-docs`, {
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data), "Should return array of agents");
  });
});

// ── Gateway health ───────────────────────────────────────────────────────────

describe("Gateway health (via Deck)", () => {
  maybeIt(() => deckUp, "deck", "gateway-health API returns JSON", async () => {
    const res = await fetch(`${BASE_URL}/api/gateway-health`, {
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(typeof data.status, "string");
  });
});

// ── Direct gateway ───────────────────────────────────────────────────────────

describe("Gateway direct", () => {
  maybeIt(() => gatewayUp, "gateway", "gateway responds to health check", async () => {
    const res = await fetch(`${GATEWAY_URL}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(res.status, 200);
  });
});
