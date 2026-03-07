import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

const CONFIG_PATH = path.resolve(process.cwd(), "config/deck-config.json");

export async function POST(req: Request) {
  try {
    const { show } = await req.json();
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const config = JSON.parse(raw);
    config.dashboard = config.dashboard ?? {};
    config.dashboard.showWalkthrough = !!show;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
