import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { stripSecrets } from "@/app/api/_lib/security";
import { WORKSPACE_DIR } from "@/app/api/_lib/paths";

export const dynamic = "force-dynamic";

// Directories that agent-docs files can live in
const ALLOWED_ROOTS = [
  WORKSPACE_DIR,
  path.join(WORKSPACE_DIR, "dashboard", "openclaw-deck-ui"),
];

export async function GET(req: NextRequest) {
  const filePath = new URL(req.url).searchParams.get("path");

  if (!filePath) {
    return NextResponse.json({ error: "Missing path param" }, { status: 400 });
  }

  // Resolve to absolute and check it's within an allowed root
  const abs = path.resolve(filePath);
  const allowed = ALLOWED_ROOTS.some(root => abs.startsWith(root + "/") || abs === root);
  if (!allowed || abs.includes("..")) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile()) {
      return NextResponse.json({ error: "Not a file" }, { status: 400 });
    }
    const content = stripSecrets(fs.readFileSync(abs, "utf-8"));
    return NextResponse.json({ ok: true, content, modified: stat.mtimeMs });
  } catch {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }
}
