import { NextResponse } from "next/server";
import { execSync } from "child_process";
import { WORKSPACE_DIR } from "@/app/api/_lib/paths";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const log = execSync(
      `git -C "${WORKSPACE_DIR}" log --oneline --format="%H|%ai|%s" -20 -- openclaw.json`,
      { encoding: "utf-8", timeout: 5_000 },
    );

    const entries = log
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, date, ...msgParts] = line.split("|");
        return { sha, date, message: msgParts.join("|") };
      });

    return NextResponse.json({ ok: true, entries });
  } catch {
    return NextResponse.json({ ok: true, entries: [] });
  }
}
