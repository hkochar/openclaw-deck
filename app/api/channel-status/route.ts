import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { OPENCLAW_BIN } from "@/app/api/_lib/paths";

export const dynamic = "force-dynamic";

interface ChannelSummary {
  id: string;
  label: string;
  configured: boolean;
  running: boolean;
  lastError: string | null;
  accounts: AccountSummary[];
}

interface AccountSummary {
  accountId: string;
  name?: string;
  configured: boolean;
  running: boolean;
  lastError: string | null;
  lastStartAt: number | null;
  lastStopAt: number | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

// Server-side cache — channel status doesn't change every second
let cachedResult: { channels: ChannelSummary[]; ts: number } | null = null;
const CACHE_TTL_MS = 15_000; // 15 seconds

function parseChannels(raw: string): ChannelSummary[] {
  const data = JSON.parse(raw);
  const channels: ChannelSummary[] = [];

  for (const id of data.channelOrder ?? []) {
    const ch = data.channels?.[id];
    if (!ch) continue;

    const accounts: AccountSummary[] = (data.channelAccounts?.[id] ?? [])
      .filter((a: Record<string, unknown>) => a.configured)
      .map((a: Record<string, unknown>) => ({
        accountId: a.accountId,
        name: a.name,
        configured: a.configured ?? false,
        running: a.running ?? false,
        lastError: a.lastError ?? null,
        lastStartAt: a.lastStartAt ?? null,
        lastStopAt: a.lastStopAt ?? null,
        lastInboundAt: a.lastInboundAt ?? null,
        lastOutboundAt: a.lastOutboundAt ?? null,
      }));

    channels.push({
      id,
      label: data.channelLabels?.[id] ?? id,
      configured: ch.configured ?? false,
      running: ch.running ?? false,
      lastError: ch.lastError ?? null,
      accounts,
    });
  }

  return channels;
}

function execAsync(...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(OPENCLAW_BIN, args, { encoding: "utf-8", timeout: 5000, env: { ...process.env, NO_COLOR: "1" } }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

export async function GET() {
  // Return cached result if fresh
  if (cachedResult && Date.now() - cachedResult.ts < CACHE_TTL_MS) {
    return NextResponse.json({ ok: true, channels: cachedResult.channels });
  }

  try {
    const raw = await execAsync("gateway", "call", "channels.status", "--json");
    const channels = parseChannels(raw);
    cachedResult = { channels, ts: Date.now() };
    return NextResponse.json({ ok: true, channels });
  } catch {
    // Return stale cache if available, otherwise empty
    if (cachedResult) {
      return NextResponse.json({ ok: true, channels: cachedResult.channels });
    }
    return NextResponse.json({ ok: false, channels: [] });
  }
}
