import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/plugin/event-log";
import { syncSearchIndex, syncFilesystemContent, searchQuery, rebuildSearchIndex } from "@/plugin/search-index";
import { safeErrorMessage } from "@/app/api/_lib/security";

export const dynamic = "force-dynamic";

/** GET /api/search?q=<query>&type=<types>&agent=<agent>&from=<ts>&to=<ts>&limit=<n> */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const q = sp.get("q")?.trim();
  if (!q) {
    return NextResponse.json({ ok: false, error: "Missing required parameter: q" }, { status: 400 });
  }

  const db = getDb();

  // Incremental sync before querying
  try {
    syncSearchIndex(db);
    syncFilesystemContent(db);
  } catch (err) {
    console.warn("[search] sync error:", err);
  }

  const types = sp.get("type")?.split(",").filter(Boolean);
  const agent = sp.get("agent") || undefined;
  const from = sp.get("from") ? Number(sp.get("from")) : undefined;
  const to = sp.get("to") ? Number(sp.get("to")) : undefined;
  const limit = sp.get("limit") ? Math.min(Math.max(Number(sp.get("limit")), 1), 500) : undefined;

  try {
    const result = searchQuery(db, { query: q, types, agent, from, to, limit });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json({ ok: false, error: safeErrorMessage(err) }, { status: 500 });
  }
}

/** POST /api/search — rebuild the entire search index. */
export async function POST() {
  const db = getDb();
  try {
    rebuildSearchIndex(db);
    return NextResponse.json({ ok: true, message: "Search index rebuilt." });
  } catch (err) {
    return NextResponse.json({ ok: false, error: safeErrorMessage(err) }, { status: 500 });
  }
}
