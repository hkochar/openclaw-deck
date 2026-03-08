/**
 * GET /api/alert-platforms
 * Returns which messaging platforms have bot tokens available.
 * Checks both process.env and ~/.openclaw/.env (where tokens typically live).
 */

import { NextResponse } from "next/server";
import { loadEnv } from "@/app/api/_lib/paths";

export const dynamic = "force-dynamic";

export async function GET() {
  const env = loadEnv();

  const has = (key: string) => !!(process.env[key] || env[key]);

  const platforms: Array<{ id: string; label: string; available: boolean }> = [
    {
      id: "discord",
      label: "Discord",
      available: has("DISCORD_BOT_TOKEN_DECK") || has("DISCORD_BOT_TOKEN"),
    },
    {
      id: "slack",
      label: "Slack",
      available: has("SLACK_BOT_TOKEN"),
    },
  ];

  return NextResponse.json({ platforms });
}
