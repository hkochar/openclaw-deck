import { NextResponse } from "next/server";
import { execSync } from "child_process";
import os from "os";
import { statfsSync } from "fs";

export const dynamic = "force-dynamic";

interface SystemStats {
  memory: { usedPercent: number; totalGb: number; usedGb: number } | null;
  cpu: { load1m: number; cores: number; percent: number } | null;
  disk: { usedPercent: number; totalGb: number; usedGb: number; freeGb: number } | null;
}

function getMemory(): SystemStats["memory"] {
  try {
    const totalBytes = os.totalmem();
    const vmOut = execSync("vm_stat", { encoding: "utf-8", timeout: 5000 });
    let pageSize = 16384;
    for (const line of vmOut.split("\n")) {
      if (line.includes("page size of")) {
        const match = line.match(/(\d+)\s+bytes/);
        if (match) pageSize = parseInt(match[1], 10);
        break;
      }
    }
    const pages: Record<string, number> = {};
    for (const line of vmOut.split("\n")) {
      const parts = line.split(":");
      if (parts.length !== 2) continue;
      const key = parts[0].trim().toLowerCase().replace(/"/g, "");
      const valStr = parts[1].trim().replace(/\.$/, "");
      if (!/^\d+$/.test(valStr)) continue;
      pages[key] = parseInt(valStr, 10);
    }
    const active = pages["pages active"] ?? 0;
    const wired = pages["pages wired down"] ?? 0;
    const compressed = pages["pages occupied by compressor"] ?? 0;
    const usedPages = active + wired + compressed;
    const totalPages = Math.floor(totalBytes / pageSize);
    if (totalPages === 0) return null;
    const usedPercent = Math.round((usedPages / totalPages) * 1000) / 10;
    const totalGb = Math.round((totalBytes / 1073741824) * 10) / 10;
    const usedGb = Math.round((usedPages * pageSize / 1073741824) * 10) / 10;
    return { usedPercent, totalGb, usedGb };
  } catch {
    return null;
  }
}

function getCpu(): SystemStats["cpu"] {
  try {
    const loadStr = execSync("/usr/sbin/sysctl -n vm.loadavg", { encoding: "utf-8", timeout: 5000 }).trim();
    // Format: "{ 2.34 1.56 1.12 }"
    const parts = loadStr.replace(/[{}]/g, "").trim().split(/\s+/);
    const load1m = parseFloat(parts[0]);
    const cores = os.cpus().length;
    const percent = Math.round((load1m / cores) * 1000) / 10;
    return { load1m, cores, percent };
  } catch {
    return null;
  }
}

function getDisk(): SystemStats["disk"] {
  try {
    const stats = statfsSync("/");
    const totalBytes = stats.blocks * stats.bsize;
    const freeBytes = stats.bavail * stats.bsize;
    const usedBytes = totalBytes - freeBytes;
    const usedPercent = Math.round((usedBytes / totalBytes) * 1000) / 10;
    const totalGb = Math.round((totalBytes / 1073741824) * 10) / 10;
    const usedGb = Math.round((usedBytes / 1073741824) * 10) / 10;
    const freeGb = Math.round((freeBytes / 1073741824) * 10) / 10;
    return { usedPercent, totalGb, usedGb, freeGb };
  } catch {
    return null;
  }
}

export function GET() {
  return NextResponse.json({
    ok: true,
    memory: getMemory(),
    cpu: getCpu(),
    disk: getDisk(),
    ts: Date.now(),
  });
}
