import { NextResponse } from "next/server";
import { loadEnv, GATEWAY_URL } from "@/app/api/_lib/paths";
import { computeNextRun, scheduleLabel } from "@/app/api/_lib/cron-parser";
import type { CronSchedule, CronState } from "@/app/api/_lib/cron-parser";

export const dynamic = "force-dynamic";

interface CronJob {
  id: string;
  name?: string;
  enabled?: boolean;
  schedule?: CronSchedule;
  state?: CronState;
  payload?: {
    model?: string;
  };
}

export async function GET() {
  const env = loadEnv();
  const gatewayToken = env["OPENCLAW_GATEWAY_TOKEN"] || "";

  try {
    const res = await fetch(`${GATEWAY_URL}/tools/invoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${gatewayToken}`,
      },
      body: JSON.stringify({
        tool: "cron",
        args: { action: "list", includeDisabled: true },
        sessionKey: "main",
      }),
      signal: AbortSignal.timeout(8_000),
      cache: "no-store",
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: `Gateway returned ${res.status}` },
        { status: 502 }
      );
    }

    const data = await res.json();
    // tools/invoke wraps result in { ok, result: { content: [{ type: "text", text: "<json>" }] } }
    let jobs: CronJob[] = [];
    const textContent = data?.result?.content?.[0]?.text;
    if (textContent) {
      try {
        const parsed = JSON.parse(textContent);
        jobs = parsed?.jobs ?? [];
      } catch {}
    } else {
      jobs = data?.result?.jobs ?? data?.jobs ?? [];
    }

    const scheduleItems = jobs.map((job: CronJob) => {
      const schedule = job.schedule ?? { kind: "unknown" };
      const state = job.state;

      // Fix: one-shot "at" jobs whose time has passed should not appear
      // as enabled — the gateway may have missed the window.
      let enabled = job.enabled ?? false;
      if (enabled && schedule.kind === "at" && schedule.at) {
        const atMs = new Date(schedule.at).getTime();
        if (!isNaN(atMs) && atMs < Date.now()) {
          enabled = false;
        }
      }

      return {
        id: job.id,
        name: job.name ?? job.id,
        schedule: scheduleLabel(schedule),
        nextRun: computeNextRun(schedule, state),
        lastRun: state?.lastRunAtMs
          ? new Date(state.lastRunAtMs).toISOString()
          : null,
        model: job.payload?.model ?? null,
        status: state?.lastStatus ?? null,
        enabled,
      };
    });

    return NextResponse.json(scheduleItems);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
