import { NextResponse } from "next/server";
import { execFileSync } from "child_process";
import { logSystemEvent } from "@/app/api/_lib/system-log";
import { safeErrorMessage } from "@/app/api/_lib/security";

export const dynamic = "force-dynamic";

import { OPENCLAW_BIN } from "@/app/api/_lib/paths";

function runCommand(subcommand: string, ...args: string[]): { ok: boolean; output: string } {
  try {
    const output = execFileSync(OPENCLAW_BIN, [subcommand, ...args], {
      encoding: "utf-8",
      timeout: 15_000,
      env: { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` },
    });
    return { ok: true, output: output.trim() };
  } catch (e) {
    // execFileSync throws on non-zero exit, but the output may still be useful
    const stderr = (e as { stderr?: Buffer })?.stderr?.toString?.() || "";
    return { ok: false, output: stderr || safeErrorMessage(e) };
  }
}

export async function GET() {
  const result = runCommand("gateway", "status");
  return NextResponse.json(result);
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const action = body.action as string;

    if (!["stop", "start", "restart"].includes(action)) {
      return NextResponse.json(
        { ok: false, output: `Unknown action: ${action}` },
        { status: 400 },
      );
    }

    // "start" needs "install" if the service was unloaded by a prior stop
    if (action === "start") {
      const result = runCommand("gateway", "start");
      if (!result.ok && result.output.includes("not loaded")) {
        const installResult = runCommand("gateway", "install");
        logSystemEvent({ category: "gateway", action: "start", summary: `Gateway ${installResult.ok ? "started (installed)" : "start failed"}`, detail: { output: installResult.output }, status: installResult.ok ? "ok" : "error" });
        return NextResponse.json(installResult);
      }
      logSystemEvent({ category: "gateway", action: "start", summary: `Gateway ${result.ok ? "started" : "start failed"}`, detail: { output: result.output }, status: result.ok ? "ok" : "error" });
      return NextResponse.json(result);
    }

    const result = runCommand("gateway", action);
    logSystemEvent({ category: "gateway", action, summary: `Gateway ${action} ${result.ok ? "succeeded" : "failed"}`, detail: { output: result.output }, status: result.ok ? "ok" : "error" });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { ok: false, output: safeErrorMessage(err) },
      { status: 500 },
    );
  }
}
