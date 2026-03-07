import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { logSystemEvent } from "@/app/api/_lib/system-log";
import { commitDeckConfig, commitSentinelConfig } from "@/app/api/_lib/config-git";
import { WORKSPACE_DIR } from "@/app/api/_lib/paths";

export const dynamic = "force-dynamic";

/** Map allowed file keys to their absolute paths and commit functions. */
const FILE_MAP: Record<string, { resolve: () => string; commit: (reason: string) => void }> = {
  "config/deck-agents.json": {
    resolve: () => path.resolve(process.cwd(), "config/deck-agents.json"),
    commit: commitDeckConfig,
  },
  "config/deck-config.json": {
    resolve: () => path.resolve(process.cwd(), "config/deck-config.json"),
    commit: commitDeckConfig,
  },
  "sentinel/deck-sentinel.json": {
    resolve: () => path.join(process.cwd(), "sentinel/deck-sentinel.json"),
    commit: commitSentinelConfig,
  },
};

/** GET: read raw file content */
export async function GET(req: NextRequest) {
  const file = req.nextUrl.searchParams.get("file") || "config/deck-agents.json";
  const entry = FILE_MAP[file];
  if (!entry) {
    return NextResponse.json({ ok: false, error: "Invalid file" }, { status: 400 });
  }

  try {
    const content = fs.readFileSync(entry.resolve(), "utf-8");
    return NextResponse.json({ ok: true, content });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

/** POST: write raw file content (restore from backup) */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const file = body.file || "config/deck-agents.json";
    const content = body.content;

    if (typeof content !== "string") {
      return NextResponse.json({ ok: false, error: "Missing content" }, { status: 400 });
    }

    const entry = FILE_MAP[file];
    if (!entry) {
      return NextResponse.json({ ok: false, error: "Invalid file" }, { status: 400 });
    }

    // Validate JSON
    try {
      JSON.parse(content);
    } catch {
      return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
    }

    // Format and write
    const formatted = JSON.stringify(JSON.parse(content), null, 2) + "\n";
    fs.writeFileSync(entry.resolve(), formatted, "utf-8");

    const fileName = path.basename(file);
    logSystemEvent({
      category: "config",
      action: "restore",
      summary: `Restored ${fileName} from backup`,
      status: "ok",
    });

    entry.commit(`restore ${fileName} from backup`);

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
