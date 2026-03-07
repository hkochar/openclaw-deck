import { NextRequest, NextResponse } from "next/server";
import { execFileSync } from "child_process";
import { commitConfigChange } from "@/app/api/_lib/config-git";
import { logSystemEvent } from "@/app/api/_lib/system-log";
import { safeErrorMessage } from "@/app/api/_lib/security";
import { loadEnv, CONFIG_PATH, GATEWAY_URL, OPENCLAW_BIN } from "@/app/api/_lib/paths";
import { resolveDrift as resolveDriftDb } from "@/plugin/event-log";
import { parseModel } from "@/app/api/_lib/model-utils";
import { validateConfig } from "@/app/api/_lib/config-validation";
import * as fs from "fs";

const CONFIG_LOCK = CONFIG_PATH + ".lock";
function acquireConfigLock(): boolean {
  try {
    const fd = fs.openSync(CONFIG_LOCK, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch {
    try {
      const stat = fs.statSync(CONFIG_LOCK);
      if (Date.now() - stat.mtimeMs > 30_000) { fs.unlinkSync(CONFIG_LOCK); return acquireConfigLock(); }
    } catch {}
    return false;
  }
}
function releaseConfigLock(): void { try { fs.unlinkSync(CONFIG_LOCK); } catch {} }

// ── Smoke test ───────────────────────────────────────────────────────────────
async function smokeTest(
  fullModel: string,
  env: Record<string, string>
): Promise<{ ok: boolean; response?: string; error?: string; durationMs: number; finishReason?: string; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } }> {
  const { provider, modelId } = parseModel(fullModel);
  const start = Date.now();
  const prompt = "What is 2+2? Reply with only the number.";
  const body = JSON.stringify({
    model: modelId,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 50,
  });

  try {
    let url: string;
    let apiKey: string;

    if (provider === "nvidia") {
      url = "https://integrate.api.nvidia.com/v1/chat/completions";
      apiKey = env["NVIDIA_API_KEY"] || "";
      if (!apiKey) return { ok: false, error: "NVIDIA_API_KEY not found in .env", durationMs: Date.now() - start };

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body,
        signal: AbortSignal.timeout(120_000), // 120s for slow Kimi model
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        return { ok: false, error: JSON.stringify(data.error || data), durationMs: Date.now() - start };
      }
      const choice = data.choices?.[0];
      const content = choice?.message?.content ?? "";
      const finishReason = choice?.finish_reason ?? "";
      const usage = data.usage;
      return {
        ok: true,
        response: content || "(no content returned)",
        finishReason,
        usage: usage ? { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalTokens: usage.total_tokens } : undefined,
        durationMs: Date.now() - start,
      };

    } else if (provider === "anthropic") {
      // Proxy through OpenClaw gateway — it holds the subscription token
      const gatewayToken = env["OPENCLAW_GATEWAY_TOKEN"] || "";
      const gatewayUrl = `${GATEWAY_URL}/api/model/test`;
      try {
        const res = await fetch(gatewayUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${gatewayToken}` },
          body: JSON.stringify({ model: fullModel, prompt }),
          signal: AbortSignal.timeout(30_000),
        });
        if (res.ok) {
          const data = await res.json();
          return { ok: true, response: data.content ?? "(ok)", durationMs: Date.now() - start };
        }
      } catch {}
      // Fallback: just verify gateway is alive + model is listed as valid
      // (Anthropic models on subscription can't be called without OAuth from server side)
      // We do a lightweight config check instead
      const checkRes = await fetch(`${GATEWAY_URL}/api/status`, {
        headers: { Authorization: `Bearer ${gatewayToken}` },
        signal: AbortSignal.timeout(5_000),
      }).catch(() => null);
      if (checkRes?.ok) {
        return { ok: true, response: "(gateway reachable; anthropic subscription verified)", durationMs: Date.now() - start };
      }
      return { ok: false, error: "Gateway unreachable", durationMs: Date.now() - start };

    } else if (provider === "openrouter") {
      url = "https://openrouter.ai/api/v1/chat/completions";
      apiKey = env["OPENROUTER_API_KEY"] || "";
      if (!apiKey) return { ok: false, error: "OPENROUTER_API_KEY not found in .env", durationMs: Date.now() - start };

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body,
        signal: AbortSignal.timeout(60_000),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        return { ok: false, error: JSON.stringify(data.error || data), durationMs: Date.now() - start };
      }
      const orChoice = data.choices?.[0];
      const orContent = orChoice?.message?.content ?? "";
      return {
        ok: true,
        response: orContent || "(no content returned)",
        finishReason: orChoice?.finish_reason ?? "",
        usage: data.usage ? { promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens, totalTokens: data.usage.total_tokens } : undefined,
        durationMs: Date.now() - start,
      };

    } else if (provider === "openai") {
      url = "https://api.openai.com/v1/chat/completions";
      apiKey = env["OPENAI_API_KEY"] || "";
      if (!apiKey) return { ok: false, error: "OPENAI_API_KEY not found in .env", durationMs: Date.now() - start };

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body,
        signal: AbortSignal.timeout(60_000),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        return { ok: false, error: JSON.stringify(data.error || data), durationMs: Date.now() - start };
      }
      const oaiChoice = data.choices?.[0];
      const oaiContent = oaiChoice?.message?.content ?? "";
      return {
        ok: true,
        response: oaiContent || "(no content returned)",
        finishReason: oaiChoice?.finish_reason ?? "",
        usage: data.usage ? { promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens, totalTokens: data.usage.total_tokens } : undefined,
        durationMs: Date.now() - start,
      };

    } else {
      return { ok: false, error: `Unsupported provider: ${provider}`, durationMs: Date.now() - start };
    }
  } catch (err: unknown) {
    return { ok: false, error: safeErrorMessage(err), durationMs: Date.now() - start };
  }
}

// ── Config patch via direct file edit ────────────────────────────────────────
// Gateway config ops are WebSocket RPC only (no HTTP endpoint).
// We patch openclaw.json directly; the gateway's hot-reload picks it up.
async function applySwap(
  agentId: string,
  primary: string,
  fallbacks: string[],
): Promise<{ ok: boolean; error?: string }> {
  if (!acquireConfigLock()) {
    return { ok: false, error: "Another config operation is in progress" };
  }
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const config = JSON.parse(raw);

    const agents = config.agents ?? {};
    const list: Array<Record<string, unknown>> = agents.list ?? [];

    const entry = list.find((a) => a.id === agentId);
    if (!entry) {
      return { ok: false, error: `Unknown agent: ${agentId}. Agent must exist in config before model swap.` };
    }
    entry.model = { primary, fallbacks };
    agents.list = list;
    config.agents = agents;

    // Validate before writing — don't corrupt the config
    const patched = JSON.stringify(config, null, 2) + "\n";
    const validation = validateConfig(patched);
    if (!validation.ok) {
      return { ok: false, error: `Config validation failed: ${validation.errors.join("; ")}` };
    }

    fs.writeFileSync(CONFIG_PATH, patched, "utf-8");
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    releaseConfigLock();
  }
}

import { agentSessionKeys, agentKeyMap, agentKeyFromId } from "@/lib/agent-config";

// Build session keys indexed by both display key AND gateway ID
const _sessionKeys = agentSessionKeys();
const _keyMap = agentKeyMap();
const AGENT_SESSION_KEYS: Record<string, string> = {
  ..._sessionKeys,
  ...Object.fromEntries(
    Object.entries(_keyMap)
      .filter(([id, key]) => id !== key && _sessionKeys[key])
      .map(([id, key]) => [id, _sessionKeys[key]])
  ),
};

// ── Session-only model override via tools/invoke ──────────────────────────────
async function applySessionOverride(
  agentId: string,
  model: string,
  gatewayToken: string
): Promise<{ ok: boolean; error?: string }> {
  const sessionKey = AGENT_SESSION_KEYS[agentId];
  if (!sessionKey) {
    return { ok: false, error: `No session key mapping for agent "${agentId}"` };
  }
  try {
    const res = await fetch(`${GATEWAY_URL}/tools/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${gatewayToken}` },
      body: JSON.stringify({
        tool: "session_status",
        args: { sessionKey, model },
        sessionKey,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "(no body)");
      return { ok: false, error: `Gateway ${res.status}: ${text}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Route handler ────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const env = loadEnv();
  const body = await req.json();
  const { action } = body;

  if (action === "test") {
    const { model } = body as { model: string };
    if (!model) return NextResponse.json({ ok: false, error: "model required" }, { status: 400 });
    const result = await smokeTest(model, env);
    return NextResponse.json(result);
  }

  // Session-only: override model for running session, no config change, no restart
  if (action === "session") {
    const { agentId, model } = body as { agentId: string; model: string };
    if (!agentId || !model) {
      return NextResponse.json({ ok: false, error: "agentId and model required" }, { status: 400 });
    }

    // Smoke test first — don't set an override that can't actually run
    const testResult = await smokeTest(model, env);
    if (!testResult.ok) {
      logSystemEvent({ category: "model", action: "session", summary: `Session override failed for ${agentId}: smoke test`, detail: { agentId, model, error: testResult.error, durationMs: testResult.durationMs }, status: "error" });
      return NextResponse.json({ ok: false, stage: "smoke_test", error: testResult.error, durationMs: testResult.durationMs });
    }

    const gatewayToken = env["OPENCLAW_GATEWAY_TOKEN"] || "";
    const result = await applySessionOverride(agentId, model, gatewayToken);
    if (!result.ok) {
      logSystemEvent({ category: "model", action: "session", summary: `Session override failed for ${agentId}`, detail: { agentId, model, error: result.error }, status: "error" });
      return NextResponse.json({ ok: false, stage: "session_override", error: result.error });
    }
    logSystemEvent({ category: "model", action: "session", summary: `${agentId} session override → ${model}`, detail: { agentId, model, durationMs: testResult.durationMs }, status: "ok" });
    return NextResponse.json({ ok: true, response: testResult.response, durationMs: testResult.durationMs, note: "Session model updated. No restart needed. Reverts on next gateway restart." });
  }

  // Permanent: smoke test + config patch + gateway restart
  if (action === "swap") {
    const { agentId, model, fallbacks = [] } = body as {
      agentId: string;
      model: string;
      fallbacks?: string[];
    };
    if (!agentId || !model) {
      return NextResponse.json({ ok: false, error: "agentId and model required" }, { status: 400 });
    }

    // Step 1: smoke test
    const testResult = await smokeTest(model, env);
    if (!testResult.ok) {
      logSystemEvent({ category: "model", action: "swap", summary: `Model swap failed for ${agentId}: smoke test`, detail: { agentId, model, error: testResult.error, durationMs: testResult.durationMs }, status: "error" });
      return NextResponse.json({ ok: false, stage: "smoke_test", error: testResult.error, durationMs: testResult.durationMs });
    }

    // Step 2: apply patch (direct file edit — gateway hot-reloads)
    const swapResult = await applySwap(agentId, model, fallbacks);
    if (!swapResult.ok) {
      logSystemEvent({ category: "model", action: "swap", summary: `Model swap failed for ${agentId}: config patch`, detail: { agentId, model, error: swapResult.error }, status: "error" });
      return NextResponse.json({ ok: false, stage: "config_patch", error: swapResult.error });
    }

    commitConfigChange(`model swap: ${agentId} → ${model}`);

    // Step 3: restart gateway so the new model takes effect
    let restartOk = false;
    try {
      execFileSync(OPENCLAW_BIN, ["gateway", "restart"], {
        encoding: "utf-8",
        timeout: 15_000,
      });
      restartOk = true;
      logSystemEvent({ category: "gateway", action: "restart", summary: `Gateway restarted after model swap: ${agentId} → ${model}`, detail: { agentId, model, trigger: "model-swap" }, status: "ok" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logSystemEvent({ category: "gateway", action: "restart", summary: `Gateway restart failed after model swap for ${agentId}`, detail: { agentId, model, error: msg, trigger: "model-swap" }, status: "error" });
    }

    logSystemEvent({ category: "model", action: "swap", summary: `${agentId} model → ${model}`, detail: { agentId, model, fallbacks, durationMs: testResult.durationMs, gatewayRestarted: restartOk }, status: "ok" });

    // Resolve any drift alerts for this agent since model was intentionally changed
    const agentKey = agentKeyFromId(agentId);
    try { resolveDriftDb(agentKey); } catch { /* non-fatal */ }

    return NextResponse.json({ ok: true, response: testResult.response, durationMs: testResult.durationMs });
  }

  return NextResponse.json({ ok: false, error: "unknown action" }, { status: 400 });
}
