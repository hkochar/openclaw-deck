import { NextResponse } from "next/server";
import { GATEWAY_URL } from "@/app/api/_lib/paths";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const res = await fetch(`${GATEWAY_URL}/provider-limits/status`, {
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Gateway ${res.status}`);
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ windows: [], config: {} }, { status: 502 });
  }
}
