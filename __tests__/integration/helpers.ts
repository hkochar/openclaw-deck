/**
 * Shared utilities for integration tests.
 *
 * All integration tests make real HTTP calls to the running Next.js dev server.
 * The server must already be running — tests do NOT start it.
 */

import { it } from "node:test";
import fs from "fs";
import path from "path";

// ── Constants ───────────────────────────────────────────────────────────────

export const BASE_URL = process.env.DECK_TEST_URL ?? "http://localhost:3000";
export const GATEWAY_URL =
  process.env.OPENCLAW_GATEWAY_URL ?? "http://127.0.0.1:18789";

const HOME = process.env.HOME || "~";
const CONFIG_PATH = path.join(HOME, ".openclaw", "openclaw.json");

// ── HTTP helpers ────────────────────────────────────────────────────────────

interface ApiResponse {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

export async function api(
  urlPath: string,
  init?: RequestInit,
): Promise<ApiResponse> {
  const res = await fetch(`${BASE_URL}${urlPath}`, {
    ...init,
    signal: AbortSignal.timeout(15_000),
  });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  return { status: res.status, body };
}

export async function GET(urlPath: string): Promise<ApiResponse> {
  return api(urlPath, { method: "GET" });
}

export async function POST(
  urlPath: string,
  payload: unknown,
): Promise<ApiResponse> {
  return api(urlPath, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// ── Dependency probes ───────────────────────────────────────────────────────

export async function isServerUp(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/system-log?limit=1`, {
      signal: AbortSignal.timeout(3_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function isGatewayUp(): Promise<boolean> {
  try {
    await fetch(GATEWAY_URL, { signal: AbortSignal.timeout(3_000) });
    return true; // any response (even 404) means alive
  } catch {
    return false;
  }
}

// ── Skip helper ─────────────────────────────────────────────────────────────

/**
 * Conditionally run or skip a test based on a runtime condition.
 * Uses a getter function so the condition is evaluated at test execution time
 * (after before() hooks have run), not at module load time.
 */
export function maybeIt(
  getCondition: () => boolean,
  reason: string,
  name: string,
  fn: () => Promise<void> | void,
) {
  it(name, async () => {
    if (!getCondition()) {
      return; // skip silently — the test passes without assertions
    }
    await fn();
  });
}

// ── Config snapshot/restore ─────────────────────────────────────────────────

export function snapshotConfig(): string {
  return fs.readFileSync(CONFIG_PATH, "utf-8");
}

export async function restoreConfig(snapshot: string): Promise<void> {
  await POST("/api/config", { action: "save", content: snapshot });
}
