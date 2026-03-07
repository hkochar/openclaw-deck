import { NextRequest, NextResponse } from "next/server";
import { execSync, execFileSync, spawn } from "child_process";
import fs from "fs";
import path from "path";
import { logSystemEvent } from "@/app/api/_lib/system-log";
import { OPENCLAW_BIN, WORKSPACE_DIR, CONFIG_PATH, GATEWAY_URL } from "@/app/api/_lib/paths";
import { commitConfigChange, notifyDiscord } from "@/app/api/_lib/config-git";

export const dynamic = "force-dynamic";

const HOME = process.env.HOME || "~";
const LOG_DIR = path.join(HOME, ".openclaw", "logs");
const LAUNCH_AGENTS_DIR = path.join(HOME, "Library", "LaunchAgents");

const AUGMENTED_ENV = {
  ...process.env,
  PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin`,
};

// Service label → friendly name mapping
const SERVICE_MAP: Record<string, { name: string; isGateway?: boolean }> = {
  "ai.openclaw.gateway": { name: "OpenClaw Gateway", isGateway: true },
  "ai.openclaw.deck": { name: "Deck" },
  "ai.openclaw.ops-bot": { name: "Ops Bot" },
  "ai.openclaw.sentinel": { name: "Sentinel" },
};

function run(bin: string, args: string[], timeout = 15_000): { ok: boolean; output: string } {
  try {
    const output = execFileSync(bin, args, {
      encoding: "utf-8",
      timeout,
      env: AUGMENTED_ENV,
    });
    return { ok: true, output: output.trim() };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const stderr = (e as { stderr?: Buffer })?.stderr?.toString?.() || "";
    return { ok: false, output: stderr || msg };
  }
}

// ── GET: tail service logs ──────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const service = searchParams.get("service");
  const lines = Math.min(parseInt(searchParams.get("lines") || "50", 10), 500);

  if (!service) {
    return NextResponse.json({ ok: false, error: "service param required" }, { status: 400 });
  }

  // Validate service name against known services to prevent path traversal
  const safeName = Object.keys(SERVICE_MAP).includes(service) ? service : null;
  if (!safeName) {
    return NextResponse.json({ ok: false, error: "unknown service" }, { status: 400 });
  }

  // Resolve log file: try stderr log first, then stdout
  const candidates = [
    path.join(LOG_DIR, `${safeName}.err.log`),
    path.join(LOG_DIR, `${safeName}.log`),
  ];

  for (const logPath of candidates) {
    try {
      if (!fs.existsSync(logPath)) continue;
      const content = fs.readFileSync(logPath, "utf-8");
      const allLines = content.split("\n");
      const tail = allLines.slice(-lines).join("\n");
      return NextResponse.json({ ok: true, logPath, lines: tail });
    } catch {}
  }

  return NextResponse.json({ ok: false, error: `No log file found for "${service}"` }, { status: 404 });
}

// ── POST: service actions ───────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { action, service } = body;

    // Operations that don't need a service label
    if (action === "doctor") return handleDoctor();
    if (action === "revert-config") return handleRevertConfig();
    if (action === "restart-all") return handleRestartAll(!!body.includeGateway);
    if (action === "apply-config-safely") return handleApplyConfigSafely(body.content, body.reason);

    // Service-specific actions
    if (!service || !SERVICE_MAP[service]) {
      return NextResponse.json(
        { ok: false, error: `Unknown service: ${service}` },
        { status: 400 },
      );
    }

    if (!["start", "stop", "restart"].includes(action)) {
      return NextResponse.json(
        { ok: false, error: `Unknown action: ${action}` },
        { status: 400 },
      );
    }

    const svc = SERVICE_MAP[service];

    // Gateway uses the openclaw CLI
    if (svc.isGateway) {
      return handleGatewayAction(action);
    }

    return handleLaunchctlAction(action, service, svc.name);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

// ── Gateway actions (via openclaw CLI) ──────────────────────────────────────

function handleGatewayAction(action: string) {
  if (action === "start") {
    const result = run(OPENCLAW_BIN, ["gateway", "start"]);
    if (!result.ok && result.output.includes("not loaded")) {
      const installResult = run(OPENCLAW_BIN, ["gateway", "install"]);
      logAction("gateway", "start", installResult.ok, installResult.output);
      return NextResponse.json(installResult);
    }
    logAction("gateway", "start", result.ok, result.output);
    return NextResponse.json(result);
  }

  const result = run(OPENCLAW_BIN, ["gateway", action]);
  logAction("gateway", action, result.ok, result.output);
  return NextResponse.json(result);
}

// ── LaunchAgent actions (via launchctl) ─────────────────────────────────────

function handleLaunchctlAction(action: string, label: string, name: string) {
  const uid = process.getuid?.() ?? 501;
  const target = `gui/${uid}/${label}`;
  const plistPath = path.join(LAUNCH_AGENTS_DIR, `${label}.plist`);

  let result: { ok: boolean; output: string };

  switch (action) {
    case "stop":
      result = run("launchctl", ["bootout", target], 10_000);
      break;

    case "start": {
      // Bootstrap the plist to load it
      if (!fs.existsSync(plistPath)) {
        return NextResponse.json({ ok: false, output: `No plist found: ${plistPath}` });
      }
      result = run("launchctl", ["bootstrap", `gui/${uid}`, plistPath], 10_000);
      break;
    }

    case "restart":
      result = run("launchctl", ["kickstart", "-k", target], 10_000);
      break;

    default:
      return NextResponse.json({ ok: false, output: `Unknown action: ${action}` }, { status: 400 });
  }

  logAction(name, action, result.ok, result.output);
  return NextResponse.json(result);
}

// ── Doctor ──────────────────────────────────────────────────────────────────

function handleDoctor() {
  const result = run(OPENCLAW_BIN, ["doctor"], 60_000);
  logSystemEvent({
    category: "services",
    action: "doctor",
    summary: `Doctor ${result.ok ? "passed" : "found issues"}`,
    detail: { output: result.output.slice(0, 2000) },
    status: result.ok ? "ok" : "error",
  });
  return NextResponse.json(result);
}

// ── Revert Config ───────────────────────────────────────────────────────────

function handleRevertConfig() {
  // Check for uncommitted changes
  const diffResult = run(
    `git -C "${WORKSPACE_DIR}" diff HEAD -- openclaw.json`,
    10_000,
  );

  if (!diffResult.output.trim()) {
    return NextResponse.json({
      ok: true,
      output: "Config is already at the last committed version. No changes to revert.",
    });
  }

  // Revert workspace copy
  const revertResult = run(
    `git -C "${WORKSPACE_DIR}" checkout HEAD -- openclaw.json`,
    10_000,
  );

  if (!revertResult.ok) {
    logSystemEvent({
      category: "services",
      action: "revert-config",
      summary: "Config revert failed",
      detail: { error: revertResult.output.slice(0, 500) },
      status: "error",
    });
    return NextResponse.json({ ok: false, output: `Revert failed: ${revertResult.output}` });
  }

  // Copy reverted config to live location
  const livePath = CONFIG_PATH;
  const workspacePath = path.join(WORKSPACE_DIR, "openclaw.json");
  try {
    fs.copyFileSync(workspacePath, livePath);
  } catch (err) {
    return NextResponse.json({
      ok: false,
      output: `Reverted workspace config but failed to copy to live location: ${err}`,
    });
  }

  // Truncate diff for display
  const diff = diffResult.output.length > 1500
    ? diffResult.output.slice(0, 1500) + "\n... (truncated)"
    : diffResult.output;

  logSystemEvent({
    category: "services",
    action: "revert-config",
    summary: "Config reverted to last committed version",
    detail: { diff: diff.slice(0, 1000) },
    status: "ok",
  });

  return NextResponse.json({
    ok: true,
    output: `Config reverted to last committed version.\nRun gateway restart to apply.\n\n${diff}`,
  });
}

// ── Restart All ─────────────────────────────────────────────────────────────

function handleRestartAll(includeGateway: boolean) {
  const uid = process.getuid?.() ?? 501;
  const steps: { service: string; ok: boolean; output: string }[] = [];

  // Restart other services first, Deck last (since restarting Deck kills this process)
  const services = [
    { label: "ai.openclaw.sentinel", name: "Sentinel" },
    { label: "ai.openclaw.ops-bot", name: "Ops Bot" },
  ];

  // Optionally restart gateway
  if (includeGateway) {
    const gwResult = run(OPENCLAW_BIN, ["gateway", "restart"]);
    steps.push({ service: "Gateway", ok: gwResult.ok, output: gwResult.output });
  }

  for (const svc of services) {
    const target = `gui/${uid}/${svc.label}`;
    const result = run("launchctl", ["kickstart", "-k", target], 10_000);
    steps.push({ service: svc.name, ok: result.ok || result.output.includes("No such process"), output: result.output });
  }

  // Deck restarts itself last — use detached process with a short delay so the response is sent first
  const deckTarget = `gui/${uid}/ai.openclaw.deck`;
  const child = spawn("bash", ["-c", `sleep 1 && launchctl kickstart -k ${deckTarget}`], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  steps.push({ service: "Deck", ok: true, output: "scheduled restart" });

  const allOk = steps.every((s) => s.ok);

  logSystemEvent({
    category: "services",
    action: "restart-all",
    summary: `Restart all: ${allOk ? "all succeeded" : "some failed"}`,
    detail: { steps },
    status: allOk ? "ok" : "error",
  });

  return NextResponse.json({ ok: allOk, steps });
}

// ── Apply Config Safely ──────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const CONFIG_LOCK = CONFIG_PATH + ".lock";

/** Acquire a file lock (exclusive). Returns true if acquired. */
function acquireConfigLock(): boolean {
  try {
    // O_CREAT | O_EXCL — atomic create-if-not-exists
    const fd = fs.openSync(CONFIG_LOCK, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch {
    // Check if stale lock (older than 30s)
    try {
      const stat = fs.statSync(CONFIG_LOCK);
      if (Date.now() - stat.mtimeMs > 30_000) {
        fs.unlinkSync(CONFIG_LOCK);
        return acquireConfigLock();
      }
    } catch { /* lock file gone, retry */ }
    return false;
  }
}

function releaseConfigLock(): void {
  try { fs.unlinkSync(CONFIG_LOCK); } catch { /* already gone */ }
}

async function handleApplyConfigSafely(
  content?: string,
  reason?: string,
): Promise<NextResponse> {
  const stabilityPollMs = 2_000;
  const stabilityPollCount = 4; // 4 × 2s = 8s total

  // ── Step 0: Acquire config lock ──
  if (!acquireConfigLock()) {
    return NextResponse.json({
      ok: false,
      error: "Another config operation is in progress. Please try again.",
      phase: "lock",
    }, { status: 409 });
  }

  try {
    return await _applyConfigSafelyInner(content, reason, stabilityPollMs, stabilityPollCount);
  } finally {
    releaseConfigLock();
  }
}

async function _applyConfigSafelyInner(
  content: string | undefined,
  reason: string | undefined,
  stabilityPollMs: number,
  stabilityPollCount: number,
): Promise<NextResponse> {
  // ── Step 1: Validate new content (if provided) ──
  if (content) {
    try {
      JSON.parse(content);
    } catch (e) {
      return NextResponse.json({
        ok: false,
        error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
        phase: "validation",
      }, { status: 400 });
    }
  }

  // ── Step 2: Git-commit current config as rollback point ──
  commitConfigChange(reason ?? "pre-apply snapshot");

  // ── Step 3: Write new config ──
  if (content) {
    try {
      const tmp = CONFIG_PATH + `.tmp.${process.pid}`;
      fs.writeFileSync(tmp, content, "utf-8");
      fs.renameSync(tmp, CONFIG_PATH);
    } catch (e) {
      return NextResponse.json({
        ok: false,
        error: `Failed to write config: ${e instanceof Error ? e.message : String(e)}`,
        phase: "write",
      }, { status: 500 });
    }
  }

  // ── Step 4: Restart gateway ──
  const uid = process.getuid?.() ?? 501;
  const restartResult = run("launchctl", ["kickstart", "-k", `gui/${uid}/ai.openclaw.gateway`], 15_000);
  if (!restartResult.ok) {
    const rb = await rollbackAndRestart("Gateway restart command failed");
    return NextResponse.json({
      ok: false,
      error: "Gateway restart command failed",
      rolledBack: rb.ok,
      phase: "restart",
    });
  }

  // ── Step 5: Wait for stability + health check ──
  let healthy = false;
  for (let i = 0; i < stabilityPollCount; i++) {
    await sleep(stabilityPollMs);
    try {
      const res = await fetch(`${GATEWAY_URL}/health`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.ok || data.uptime > 0) {
          healthy = true;
          break;
        }
      }
    } catch {
      // Gateway not up yet — keep waiting
    }
  }

  // ── Step 6: Success or rollback ──
  if (healthy) {
    commitConfigChange(reason ?? "apply-safely succeeded");

    logSystemEvent({
      category: "config",
      action: "apply-safely",
      summary: `Config applied safely${reason ? `: ${reason}` : ""}`,
      status: "ok",
    });

    notifyDiscord(
      `**Config Applied Successfully**\n` +
      `Gateway restarted and healthy.\n` +
      (reason ? `Reason: ${reason}` : ""),
    ).catch(() => {});

    return NextResponse.json({
      ok: true,
      action: "apply-safely",
      gateway: "healthy",
    });
  } else {
    const rb = await rollbackAndRestart("Gateway unhealthy after config apply");
    return NextResponse.json({
      ok: false,
      error: "Gateway failed health check after restart",
      rolledBack: rb.ok,
      phase: "health-check",
      gateway: "unhealthy",
    });
  }
}

async function rollbackAndRestart(reason: string): Promise<{ ok: boolean }> {
  logSystemEvent({
    category: "config",
    action: "rollback",
    summary: `Auto-rollback: ${reason}`,
    status: "error",
  });

  notifyDiscord(
    `**Config Auto-Rollback**\n` +
    `Reason: ${reason}\n` +
    `Reverting to last known good config and restarting gateway.`,
  ).catch(() => {});

  // Revert config file from git
  try {
    execFileSync("git", ["-C", WORKSPACE_DIR, "checkout", "HEAD", "--", "openclaw.json"], {
      encoding: "utf-8",
      timeout: 10_000,
    });
    const workspacePath = path.join(WORKSPACE_DIR, "openclaw.json");
    fs.copyFileSync(workspacePath, CONFIG_PATH);
  } catch (e) {
    logSystemEvent({
      category: "config",
      action: "rollback",
      summary: "Rollback failed — could not revert config",
      detail: { error: String(e).slice(0, 500) },
      status: "error",
    });

    notifyDiscord(
      `**Rollback FAILED** — could not revert config file.\n` +
      `Manual intervention required.\n` +
      `Error: ${String(e).slice(0, 200)}`,
    ).catch(() => {});

    return { ok: false };
  }

  // Restart gateway with reverted config
  const uid = process.getuid?.() ?? 501;
  const restartResult = run(
    `launchctl kickstart -k gui/${uid}/ai.openclaw.gateway`,
    15_000,
  );

  if (restartResult.ok) {
    notifyDiscord(
      `**Rollback Complete**\n` +
      `Reverted to last known good config. Gateway restarting.`,
    ).catch(() => {});
  }

  return { ok: restartResult.ok };
}

// ── Logging helper ──────────────────────────────────────────────────────────

function logAction(service: string, action: string, ok: boolean, output: string) {
  logSystemEvent({
    category: "services",
    action,
    summary: `${service} ${action} ${ok ? "succeeded" : "failed"}`,
    detail: { output: output.slice(0, 500) },
    status: ok ? "ok" : "error",
  });
}
