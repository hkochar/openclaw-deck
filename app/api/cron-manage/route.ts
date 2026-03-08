import { NextResponse } from "next/server";
import { execSync, execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { logSystemEvent } from "@/app/api/_lib/system-log";

export const dynamic = "force-dynamic";

import { GATEWAY_URL, OPENCLAW_BIN, CONFIG_PATH, WORKSPACE_DIR, loadEnv } from "@/app/api/_lib/paths";
import { systemChannels } from "@/lib/agent-config";
const DISCORD_CHANNELS = systemChannels();

// ── Discord notification ────────────────────────────────────────────────────

async function notifySystemStatus(message: string): Promise<void> {
  const env = loadEnv();
  const botToken = env["DISCORD_BOT_TOKEN_DECK"] || env["DISCORD_BOT_TOKEN"] || "";
  if (!botToken) return;

  try {
    await fetch(`https://discord.com/api/v10/channels/${DISCORD_CHANNELS.systemStatus}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bot ${botToken}`,
      },
      body: JSON.stringify({ content: message }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {}
}

// ── Gateway cron tool helper ────────────────────────────────────────────────

async function cronUpdate(
  jobId: string,
  patch: Record<string, unknown>,
  gatewayToken: string
): Promise<{ ok: boolean; job?: Record<string, unknown>; error?: string }> {
  try {
    const res = await fetch(`${GATEWAY_URL}/tools/invoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${gatewayToken}`,
      },
      body: JSON.stringify({
        tool: "cron",
        args: { action: "update", jobId, patch },
        sessionKey: "main",
      }),
      signal: AbortSignal.timeout(10_000),
    });

    const data = await res.json();
    if (data.error) {
      return { ok: false, error: data.error?.message || JSON.stringify(data.error) };
    }

    const text = data?.result?.content?.[0]?.text;
    if (text) {
      return { ok: true, job: JSON.parse(text) };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

import { validateConfig, validateSchedule } from "@/app/api/_lib/config-validation";

// ── Gateway health check ────────────────────────────────────────────────────

async function waitForGateway(maxMs: number): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${GATEWAY_URL}/api/status`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return false;
}

// ── Git helpers ─────────────────────────────────────────────────────────────

function gitExec(...args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf-8",
    timeout: 10_000,
    cwd: WORKSPACE_DIR,
    env: { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` },
  }).trim();
}

function getHeadSha(): string {
  return gitExec("rev-parse", "HEAD");
}

// ── Route handler ───────────────────────────────────────────────────────────

export async function POST(request: Request) {
  const env = loadEnv();
  const gatewayToken = env["OPENCLAW_GATEWAY_TOKEN"] || "";

  try {
    const body = await request.json();
    const { action } = body;

    // ── Toggle enable/disable ─────────────────────────────────────────────
    if (action === "toggle") {
      const { jobId, enabled, jobName } = body as {
        jobId: string;
        enabled: boolean;
        jobName?: string;
      };
      if (!jobId || typeof enabled !== "boolean") {
        return NextResponse.json({ ok: false, error: "jobId and enabled (boolean) required" }, { status: 400 });
      }

      const result = await cronUpdate(jobId, { enabled }, gatewayToken);
      if (!result.ok) {
        logSystemEvent({ category: "cron", action: "toggle", summary: `Cron toggle failed: ${jobName || jobId}`, detail: { jobId, enabled, error: result.error }, status: "error" });
        return NextResponse.json({ ok: false, error: result.error });
      }

      const label = jobName || jobId;
      const statusWord = enabled ? "enabled" : "disabled";
      logSystemEvent({ category: "cron", action: "toggle", summary: `${label} ${statusWord}`, detail: { jobId, jobName, enabled }, status: "ok" });
      notifySystemStatus(`**Cron ${statusWord}:** \`${label}\` was ${statusWord} via Deck`).catch(() => {});

      return NextResponse.json({ ok: true, job: result.job });
    }

    // ── Update schedule/name ──────────────────────────────────────────────
    if (action === "update") {
      const { jobId, patch, jobName } = body as {
        jobId: string;
        patch: Record<string, unknown>;
        jobName?: string;
      };
      if (!jobId || !patch || typeof patch !== "object") {
        return NextResponse.json({ ok: false, error: "jobId and patch required" }, { status: 400 });
      }

      // Validate schedule if provided
      if (patch.schedule) {
        const schedError = validateSchedule(patch.schedule as Record<string, unknown>);
        if (schedError) {
          return NextResponse.json({ ok: false, error: schedError }, { status: 400 });
        }
      }

      const result = await cronUpdate(jobId, patch, gatewayToken);
      if (!result.ok) {
        logSystemEvent({ category: "cron", action: "update", summary: `Cron update failed: ${jobName || jobId}`, detail: { jobId, patch, error: result.error }, status: "error" });
        return NextResponse.json({ ok: false, error: result.error });
      }

      const label = jobName || jobId;
      const changes = Object.keys(patch).join(", ");
      logSystemEvent({ category: "cron", action: "update", summary: `${label} updated: ${changes}`, detail: { jobId, jobName, patch }, status: "ok" });
      notifySystemStatus(`**Cron updated:** \`${label}\` — changed: ${changes}`).catch(() => {});

      return NextResponse.json({ ok: true, job: result.job });
    }

    // ── Safe gateway restart ──────────────────────────────────────────────
    if (action === "restart-gateway") {
      const steps: { step: string; ok: boolean; detail?: string }[] = [];

      // Step 1: Pre-flight config validation
      let configRaw: string;
      try {
        configRaw = fs.readFileSync(CONFIG_PATH, "utf-8");
      } catch (err) {
        const msg = `Cannot read config: ${err instanceof Error ? err.message : String(err)}`;
        steps.push({ step: "read-config", ok: false, detail: msg });
        return NextResponse.json({ ok: false, steps, error: msg });
      }

      const validation = validateConfig(configRaw);
      if (!validation.ok) {
        steps.push({ step: "validate-config", ok: false, detail: validation.errors.join("; ") });
        notifySystemStatus(`**Gateway restart blocked:** Config validation failed — ${validation.errors.join("; ")}`).catch(() => {});
        return NextResponse.json({ ok: false, steps, error: `Config validation failed: ${validation.errors.join("; ")}` });
      }
      steps.push({ step: "validate-config", ok: true });

      // Step 2: Git commit current config
      let previousSha: string;
      try {
        previousSha = getHeadSha();
        try {
          gitExec("add", "openclaw.json");
          gitExec("commit", "-m", "config: pre-restart snapshot (Deck)");
        } catch {
          // No changes to commit — that's fine
        }
        steps.push({ step: "git-commit", ok: true, detail: `previous: ${previousSha.slice(0, 7)}` });
      } catch (err) {
        // Git failure is non-fatal — proceed with restart
        previousSha = "";
        steps.push({ step: "git-commit", ok: false, detail: err instanceof Error ? err.message : String(err) });
      }

      // Step 3: Restart gateway
      let restartOk = false;
      try {
        execFileSync(OPENCLAW_BIN, ["gateway", "restart"], {
          encoding: "utf-8",
          timeout: 15_000,
          env: { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` },
        });
        steps.push({ step: "restart-command", ok: true });
        restartOk = true;
      } catch (err) {
        steps.push({ step: "restart-command", ok: false, detail: err instanceof Error ? err.message : String(err) });
      }

      // Step 4: Health check
      if (restartOk) {
        // Wait a moment for the process to initialize
        await new Promise((r) => setTimeout(r, 3_000));
        const healthy = await waitForGateway(30_000);
        steps.push({ step: "health-check", ok: healthy });

        if (healthy) {
          logSystemEvent({ category: "gateway", action: "restart", summary: "Gateway restarted successfully", detail: { steps }, status: "ok" });
          notifySystemStatus("**Gateway restarted successfully** via Deck").catch(() => {});
          return NextResponse.json({ ok: true, steps });
        }
      }

      // Step 5: Rollback on failure
      if (previousSha) {
        try {
          gitExec("checkout", previousSha, "--", "openclaw.json");
          // Copy rolled-back config to primary location
          const rolledBack = fs.readFileSync(path.join(WORKSPACE_DIR, "openclaw.json"), "utf-8");
          fs.writeFileSync(CONFIG_PATH, rolledBack, "utf-8");
          steps.push({ step: "rollback", ok: true, detail: `restored to ${previousSha.slice(0, 7)}` });

          // Attempt restart with rolled-back config
          try {
            execFileSync(OPENCLAW_BIN, ["gateway", "restart"], {
              encoding: "utf-8",
              timeout: 15_000,
              env: { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` },
            });
            await new Promise((r) => setTimeout(r, 3_000));
            const retryHealthy = await waitForGateway(20_000);
            steps.push({ step: "retry-restart", ok: retryHealthy });
          } catch (err) {
            steps.push({ step: "retry-restart", ok: false, detail: err instanceof Error ? err.message : String(err) });
          }

          notifySystemStatus(
            `**Gateway restart failed — rolled back** to \`${previousSha.slice(0, 7)}\`\n` +
            `Steps: ${steps.map((s) => `${s.ok ? "pass" : "FAIL"} ${s.step}`).join(", ")}`
          ).catch(() => {});
        } catch (err) {
          steps.push({ step: "rollback", ok: false, detail: err instanceof Error ? err.message : String(err) });
          notifySystemStatus(
            `**Gateway restart failed — rollback also failed!**\n${err instanceof Error ? err.message : String(err)}`
          ).catch(() => {});
        }
      } else {
        notifySystemStatus(
          `**Gateway restart failed** — no git SHA available for rollback\n` +
          `Steps: ${steps.map((s) => `${s.ok ? "pass" : "FAIL"} ${s.step}`).join(", ")}`
        ).catch(() => {});
      }

      logSystemEvent({
        category: "gateway", action: "restart",
        summary: "Gateway restart failed" + (previousSha ? " — rolled back" : ""),
        detail: { steps }, status: previousSha ? "rollback" : "error",
      });
      return NextResponse.json({
        ok: false,
        steps,
        error: "Gateway failed to start. " + (previousSha ? "Config rolled back." : "No rollback available."),
      });
    }

    // ── Create new cron job ───────────────────────────────────────────────
    if (action === "create") {
      const { name, agentId, schedule, model, message, enabled = true } = body as {
        name: string;
        agentId: string;
        schedule: string;
        model?: string;
        message?: string;
        enabled?: boolean;
      };
      if (!name || !agentId || !schedule) {
        return NextResponse.json({ ok: false, error: "name, agentId, and schedule required" }, { status: 400 });
      }

      // Parse schedule string → object
      const trimmed = schedule.trim();
      let scheduleObj: Record<string, unknown>;
      if (trimmed.startsWith("every ")) {
        const match = trimmed.match(/^every\s+(\d+)\s*(ms|s|m|h)$/i);
        if (!match) {
          return NextResponse.json({ ok: false, error: "Invalid interval format. Use: every 5m, every 1h, etc." }, { status: 400 });
        }
        const multipliers: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000 };
        const everyMs = parseInt(match[1]) * (multipliers[match[2].toLowerCase()] || 1);
        if (everyMs < 60_000) {
          return NextResponse.json({ ok: false, error: "Minimum interval is 60 seconds (every 1m)" }, { status: 400 });
        }
        scheduleObj = { kind: "every", everyMs };
      } else {
        const fields = trimmed.split(/\s+/);
        if (fields.length !== 5) {
          return NextResponse.json({ ok: false, error: "Cron expression must have 5 fields" }, { status: 400 });
        }
        scheduleObj = { kind: "cron", expr: trimmed };
      }

      // Build job
      const job = {
        name,
        schedule: scheduleObj,
        sessionTarget: "isolated",
        agentId,
        payload: {
          kind: "agentTurn",
          message: message || "heartbeat check",
          ...(model ? { model } : {}),
        },
        delivery: { mode: "none" },
        enabled,
      };

      try {
        const res = await fetch(`${GATEWAY_URL}/tools/invoke`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${gatewayToken}`,
          },
          body: JSON.stringify({ tool: "cron", args: { action: "add", job }, sessionKey: "main" }),
          signal: AbortSignal.timeout(10_000),
        });
        const data = await res.json();
        if (!res.ok || data.error) {
          logSystemEvent({ category: "cron", action: "create", summary: `Cron create failed: ${name}`, detail: { job, error: data.error }, status: "error" });
          return NextResponse.json({ ok: false, error: data.error?.message || JSON.stringify(data.error || data) });
        }
        const jobId = data.result?.id;
        logSystemEvent({ category: "cron", action: "create", summary: `Created cron: ${name}`, detail: { jobId, job }, status: "ok" });
        notifySystemStatus(`**Cron created:** \`${name}\` (${schedule}) via Deck`).catch(() => {});
        return NextResponse.json({ ok: true, jobId });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logSystemEvent({ category: "cron", action: "create", summary: `Cron create failed: ${name}`, detail: { error: msg }, status: "error" });
        return NextResponse.json({ ok: false, error: msg });
      }
    }

    return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
