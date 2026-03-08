import { NextRequest, NextResponse } from "next/server";

/**
 * Security middleware: rate limiting + authentication + CSRF protection.
 *
 * Rate limiting (always active):
 *   Per-IP sliding window: 120 requests per minute (configurable via DECK_RATE_LIMIT).
 *   Returns 429 when exceeded.
 *
 * Authentication (enabled when DECK_API_TOKEN is set):
 *   - Authorization: Bearer <token>  (for programmatic access)
 *   - deck_token cookie              (for browser sessions)
 *
 * CSRF protection (always active on mutating requests):
 *   POST/PUT/PATCH/DELETE requests must have an Origin or Referer header
 *   matching the request host. Requests with Bearer auth are exempt
 *   (bearer tokens aren't auto-sent by browsers, so no CSRF risk).
 *
 * When DECK_API_TOKEN is not set, auth is disabled but CSRF + rate limiting are still active.
 */

const API_TOKEN = process.env.DECK_API_TOKEN || "";
const RATE_LIMIT = Number(process.env.DECK_RATE_LIMIT) || 120; // requests per minute
const RATE_WINDOW_MS = 60_000;
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// ── Rate limiter (in-memory sliding window) ──────────────────────────────

interface RateBucket {
  timestamps: number[];
}

const rateBuckets = new Map<string, RateBucket>();

// Periodic cleanup to prevent memory growth
let lastCleanup = Date.now();
function cleanupBuckets() {
  const now = Date.now();
  if (now - lastCleanup < RATE_WINDOW_MS) return;
  lastCleanup = now;
  const cutoff = now - RATE_WINDOW_MS;
  for (const [key, bucket] of rateBuckets) {
    bucket.timestamps = bucket.timestamps.filter((t) => t > cutoff);
    if (bucket.timestamps.length === 0) rateBuckets.delete(key);
  }
}

function isRateLimited(ip: string): { limited: boolean; remaining: number } {
  cleanupBuckets();
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;

  let bucket = rateBuckets.get(ip);
  if (!bucket) {
    bucket = { timestamps: [] };
    rateBuckets.set(ip, bucket);
  }

  // Remove expired timestamps
  bucket.timestamps = bucket.timestamps.filter((t) => t > cutoff);
  const remaining = Math.max(0, RATE_LIMIT - bucket.timestamps.length);

  if (bucket.timestamps.length >= RATE_LIMIT) {
    return { limited: true, remaining: 0 };
  }

  bucket.timestamps.push(now);
  return { limited: false, remaining: remaining - 1 };
}

// ── Authentication ───────────────────────────────────────────────────────

function isAuthenticated(req: NextRequest): "bearer" | "cookie" | false {
  const authHeader = req.headers.get("authorization") ?? "";
  if (authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token === API_TOKEN) return "bearer";
  }

  const cookieToken = req.cookies.get("deck_token")?.value;
  if (cookieToken === API_TOKEN) return "cookie";

  return false;
}

// ── CSRF ─────────────────────────────────────────────────────────────────

function isValidOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");
  const host = req.headers.get("host") ?? req.nextUrl.host;

  if (origin) {
    try { return new URL(origin).host === host; } catch { return false; }
  }
  if (referer) {
    try { return new URL(referer).host === host; } catch { return false; }
  }
  return false;
}

// ── Middleware ────────────────────────────────────────────────────────────

export function middleware(req: NextRequest) {
  // Login endpoint is always accessible (but still rate-limited)
  const isLogin = req.nextUrl.pathname === "/api/auth/login";

  // ── Rate limiting ──
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || req.headers.get("x-real-ip")
    || "unknown";
  const { limited, remaining } = isRateLimited(ip);

  if (limited) {
    return NextResponse.json(
      { ok: false, error: "Too many requests" },
      {
        status: 429,
        headers: {
          "Retry-After": "60",
          "X-RateLimit-Limit": String(RATE_LIMIT),
          "X-RateLimit-Remaining": "0",
        },
      },
    );
  }

  if (isLogin) {
    return NextResponse.next();
  }

  // ── Authentication ──
  if (API_TOKEN) {
    const authResult = isAuthenticated(req);
    if (!authResult) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
      );
    }

    // Bearer-authenticated requests skip CSRF check
    if (authResult === "bearer") {
      const res = NextResponse.next();
      res.headers.set("X-RateLimit-Remaining", String(remaining));
      return res;
    }
  }

  // ── CSRF protection for mutating requests ──
  if (MUTATING_METHODS.has(req.method) && !isValidOrigin(req)) {
    return NextResponse.json(
      { ok: false, error: "CSRF validation failed" },
      { status: 403 },
    );
  }

  const res = NextResponse.next();
  res.headers.set("X-RateLimit-Remaining", String(remaining));
  return res;
}

export const config = {
  matcher: "/api/:path*",
};
