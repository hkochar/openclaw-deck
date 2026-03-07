import { NextResponse } from "next/server";
import { GATEWAY_URL } from "@/app/api/_lib/paths";

export const dynamic = "force-dynamic";

function isJsonResponse(res: Response): boolean {
  return (res.headers.get("content-type") ?? "").includes("application/json");
}

export async function GET() {
  try {
    // Try /health first (gateway plugin health endpoint)
    const res = await fetch(`${GATEWAY_URL}/health`, {
      signal: AbortSignal.timeout(3000),
      cache: "no-store",
    });
    if (res.ok && isJsonResponse(res)) {
      const data = await res.json();
      return NextResponse.json({
        ok: data.ok ?? true,
        status: res.status,
        uptime: data.uptime,
        droppedEvents: data.droppedEvents ?? 0,
        activeLoops: data.activeLoops ?? 0,
        loops: data.loops ?? [],
        memoryMB: data.memoryMB ?? 0,
        poller: data.poller ?? null,
      });
    }

    // /health returned HTML (SPA catch-all) or non-OK — fall back to root ping
    const fallback = await fetch(GATEWAY_URL, {
      signal: AbortSignal.timeout(3000),
      cache: "no-store",
    });
    return NextResponse.json({ ok: fallback.ok, status: fallback.status });
  } catch {
    return NextResponse.json({ ok: false, status: 0 });
  }
}
