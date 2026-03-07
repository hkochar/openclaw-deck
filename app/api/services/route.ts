import { NextResponse } from "next/server";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

const LAUNCH_AGENTS_DIR = path.join(process.env.HOME || "~", "Library", "LaunchAgents");
const PREFIX = "ai.openclaw.";

interface ServiceInfo {
  label: string;
  name: string;
  comment: string;
  running: boolean;
  status: "running" | "stopped" | "scheduled";
  pid: number | null;
  port: string | null;
  version: string | null;
  logPath: string | null;
  keepAlive: boolean;
  startInterval: number | null;
}

import { parsePlist } from "@/app/api/_lib/plist-parser";

export async function GET() {
  const services: ServiceInfo[] = [];

  // Get running services from launchctl
  const runningMap: Record<string, number> = {};
  try {
    const output = execSync("launchctl list", { encoding: "utf-8", timeout: 3000 });
    for (const line of output.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 3 && parts[2].startsWith(PREFIX)) {
        const pid = parts[0] === "-" ? null : parseInt(parts[0], 10);
        runningMap[parts[2]] = pid ?? -1;
      }
    }
  } catch {}

  // Read plist files
  try {
    const entries = fs.readdirSync(LAUNCH_AGENTS_DIR);
    for (const entry of entries) {
      if (!entry.startsWith(PREFIX) || !entry.endsWith(".plist")) continue;
      const label = entry.replace(".plist", "");

      try {
        const content = fs.readFileSync(path.join(LAUNCH_AGENTS_DIR, entry), "utf-8");
        const fields = parsePlist(content);

        // Friendly name from label
        const shortName = label.replace(PREFIX, "");
        const nameMap: Record<string, string> = {
          gateway: "OpenClaw Gateway",
          "openclaw-deck": "Deck Frontend",
          "ops-bot": "Ops Bot",
          sentinel: "Sentinel",
        };

        const pid = runningMap[label];
        const isRunning = label in runningMap && pid !== -1;
        const keepAlive = fields.KeepAlive === "true";
        const startInterval = fields.StartInterval ? parseInt(fields.StartInterval, 10) : null;

        services.push({
          label,
          name: nameMap[shortName] ?? shortName,
          comment: fields.Comment ?? "",
          running: isRunning,
          status: isRunning ? "running" : keepAlive ? "stopped" : "scheduled",
          pid: pid && pid > 0 ? pid : null,
          port: fields.OPENCLAW_GATEWAY_PORT ?? fields.PORT ?? null,
          version: fields.OPENCLAW_SERVICE_VERSION ?? null,
          logPath: fields.StandardOutPath ?? null,
          keepAlive,
          startInterval: startInterval && !isNaN(startInterval) ? startInterval : null,
        });
      } catch {}
    }
  } catch {}

  // Reconcile: if a service has a port, verify by actually checking if the
  // port is responding.  This handles processes started outside launchd
  // (e.g. `openclaw gateway start` runs directly, not via LaunchAgent).
  for (const svc of services) {
    if (!svc.running && svc.port) {
      try {
        const res = await fetch(`http://127.0.0.1:${svc.port}/health`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (res.ok || res.status < 500) {
          svc.running = true;
          svc.status = "running";
        }
      } catch {}
    }
  }

  // Sort: running first
  services.sort((a, b) => (a.running === b.running ? 0 : a.running ? -1 : 1));

  return NextResponse.json({ ok: true, services });
}
