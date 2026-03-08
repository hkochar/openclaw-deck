import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

const CONFIG_PATH = path.resolve(process.cwd(), "config/deck-config.json");
const DEFAULT_HIDDEN = ["tests"];

export async function GET() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const config = JSON.parse(raw);
    const dash = config.dashboard ?? {};
    return NextResponse.json({
      hiddenTabs: dash.hiddenTabs ?? DEFAULT_HIDDEN,
      showWalkthrough: dash.showWalkthrough ?? false,
    });
  } catch {
    return NextResponse.json({ hiddenTabs: DEFAULT_HIDDEN });
  }
}
