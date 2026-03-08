import { NextResponse } from "next/server";
import { loadEnv, GATEWAY_URL } from "@/app/api/_lib/paths";
import { scheduleLabel } from "@/app/api/_lib/cron-parser";
import { logSystemEvent } from "@/app/api/_lib/system-log";

export const dynamic = "force-dynamic";

// Track which cron errors we've already logged to avoid duplicates on every poll
const _loggedErrors = new Map<string, string>(); // cronId → lastError

export async function GET() {
  const env = loadEnv();
  const gatewayToken = env["OPENCLAW_GATEWAY_TOKEN"] || "";

  try {
    const res = await fetch(`${GATEWAY_URL}/tools/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${gatewayToken}` },
      body: JSON.stringify({ tool: "cron", args: { action: "list", includeDisabled: true }, sessionKey: "main" }),
      signal: AbortSignal.timeout(8_000),
      cache: "no-store",
    });

    if (!res.ok) {
      return NextResponse.json({ ok: false, error: `Gateway returned ${res.status}` }, { status: 502 });
    }

    const data = await res.json();
    // tools/invoke wraps result in { ok, result: { content: [{ type: "text", text: "<json>" }] } }
    let jobs: Record<string, unknown>[] = [];
    const textContent = data?.result?.content?.[0]?.text;
    if (textContent) {
      try {
        const parsed = JSON.parse(textContent);
        jobs = parsed?.jobs ?? [];
      } catch {}
    } else {
      // Fallback: direct shape
      jobs = data?.result?.jobs ?? data?.jobs ?? [];
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const crons = jobs.map((job: any) => {
      let enabled = job.enabled ?? false;

      // Fix: one-shot "at" jobs whose scheduled time has passed should not
      // appear as enabled.  The gateway disables these after execution, but
      // if the gateway was down when the time arrived the job is orphaned as
      // enabled with lastStatus null.
      if (
        enabled &&
        job.schedule?.kind === "at" &&
        job.schedule?.at
      ) {
        const atMs = new Date(job.schedule.at).getTime();
        if (!isNaN(atMs) && atMs < Date.now()) {
          enabled = false;
        }
      }

      return {
        id: job.id,
        name: job.name ?? job.id,
        agentId: job.agentId ?? "main",
        enabled,
        model: (job.payload?.model as string) ?? null,
        schedule: scheduleLabel(job.schedule ?? {}),
        deleteAfterRun: job.deleteAfterRun ?? false,
        lastStatus: job.state?.lastStatus ?? null,
        lastError: job.state?.lastError ?? null,
        consecutiveErrors: job.state?.consecutiveErrors ?? 0,
      };
    });

    // Log new cron errors to system_log for persistent history
    for (const cron of crons) {
      // Skip disabled jobs — stale errors from before disabling shouldn't re-log
      if (!cron.enabled) {
        _loggedErrors.delete(cron.id);
        continue;
      }
      if (cron.consecutiveErrors > 0 && cron.lastError) {
        const prev = _loggedErrors.get(cron.id);
        // Only log if error message changed or error count increased
        if (prev !== `${cron.consecutiveErrors}:${cron.lastError}`) {
          _loggedErrors.set(cron.id, `${cron.consecutiveErrors}:${cron.lastError}`);
          logSystemEvent({
            category: "cron",
            action: "error",
            summary: `${cron.name} (${cron.agentId}): ${cron.lastError.slice(0, 200)}`,
            detail: {
              cronId: cron.id,
              cronName: cron.name,
              agentId: cron.agentId,
              consecutiveErrors: cron.consecutiveErrors,
              error: cron.lastError,
            },
            status: "error",
          });
        }
      } else if (cron.consecutiveErrors === 0 && _loggedErrors.has(cron.id)) {
        // Cron recovered — log recovery and clear tracker
        logSystemEvent({
          category: "cron",
          action: "recovery",
          summary: `${cron.name} (${cron.agentId}) recovered`,
          detail: { cronId: cron.id, cronName: cron.name, agentId: cron.agentId },
          status: "ok",
        });
        _loggedErrors.delete(cron.id);
      }
    }

    return NextResponse.json({ ok: true, crons });
  } catch (err) {
    // Fallback: try reading from cron tool directly
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      crons: [],
    });
  }
}
