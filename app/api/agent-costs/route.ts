import { NextRequest, NextResponse } from "next/server";
import { GATEWAY_URL } from "@/app/api/_lib/paths";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const since = req.nextUrl.searchParams.get("since");
    const until = req.nextUrl.searchParams.get("until");
    const params = new URLSearchParams();
    if (since) params.set("since", since);
    if (until) params.set("until", until);
    const qs = params.toString() ? `?${params}` : "";
    const res = await fetch(`${GATEWAY_URL}/budget/status${qs}`, {
      signal: AbortSignal.timeout(5_000),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Gateway ${res.status}`);
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json(
      { error: "Gateway unavailable", agents: [], global: {}, alertThresholds: [80, 100], pricing: {} },
      { status: 502 },
    );
  }
}
