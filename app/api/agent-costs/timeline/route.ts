import { NextRequest, NextResponse } from "next/server";
import { GATEWAY_URL } from "@/app/api/_lib/paths";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const agent = searchParams.get("agent") ?? "";
  const days = searchParams.get("days") ?? "7";

  const qs = new URLSearchParams();
  if (agent) qs.set("agent", agent);
  qs.set("days", days);

  try {
    const res = await fetch(`${GATEWAY_URL}/logs/timeline?${qs}`, {
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Gateway ${res.status}`);
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json([], { status: 502 });
  }
}
