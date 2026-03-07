import { NextRequest, NextResponse } from "next/server";

const API_TOKEN = process.env.DECK_API_TOKEN || "";

/**
 * POST /api/auth/login
 * Body: { token: "..." }
 *
 * Validates the provided token against DECK_API_TOKEN.
 * On success, sets a deck_token cookie for browser sessions.
 */
export async function POST(req: NextRequest) {
  if (!API_TOKEN) {
    return NextResponse.json({ ok: true, message: "Auth not configured" });
  }

  try {
    const { token } = await req.json();
    if (!token || token !== API_TOKEN) {
      return NextResponse.json({ ok: false, error: "Invalid token" }, { status: 401 });
    }

    const res = NextResponse.json({ ok: true });
    res.cookies.set("deck_token", token, {
      httpOnly: true,
      sameSite: "strict",
      path: "/",
      maxAge: 30 * 24 * 60 * 60, // 30 days
    });
    return res;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request" }, { status: 400 });
  }
}

/** GET /api/auth/login — check if auth is required and current status. */
export async function GET(req: NextRequest) {
  const authRequired = !!API_TOKEN;
  const authenticated = !authRequired || req.cookies.get("deck_token")?.value === API_TOKEN;
  return NextResponse.json({ ok: true, authRequired, authenticated });
}
