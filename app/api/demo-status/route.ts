import { NextResponse } from "next/server";
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const DEMO_MARKER = join(homedir(), ".openclaw-deck", "data", ".demo");

export function GET() {
  return NextResponse.json({ demo: existsSync(DEMO_MARKER) });
}
