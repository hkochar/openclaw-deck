/**
 * POST /api/resolve-channel
 * Resolves a channel ID to a name on the given platform.
 * Body: { platform: "discord"|"slack"|"telegram", channelId: string }
 * Returns: { ok: true, name: string } or { ok: false, error: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { loadEnv } from "@/app/api/_lib/paths";

export async function POST(req: NextRequest) {
  try {
    const { platform, channelId } = await req.json();
    if (!platform || !channelId) {
      return NextResponse.json({ ok: false, error: "platform and channelId required" }, { status: 400 });
    }

    const env = loadEnv();
    const get = (key: string) => process.env[key] || env[key] || "";

    let name: string | null = null;

    if (platform === "discord") {
      const token = get("DISCORD_BOT_TOKEN_DECK") || get("DISCORD_BOT_TOKEN");
      if (!token) return NextResponse.json({ ok: false, error: "No Discord bot token available" }, { status: 400 });
      const res = await fetch(`https://discord.com/api/v10/channels/${channelId}`, {
        headers: { Authorization: `Bot ${token.replace(/^Bot\s+/i, "")}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return NextResponse.json({ ok: false, error: `Discord API ${res.status}` }, { status: 400 });
      const data = await res.json();
      name = data.name ?? null;
    } else if (platform === "slack") {
      const token = get("SLACK_BOT_TOKEN");
      if (!token) return NextResponse.json({ ok: false, error: "No Slack bot token available" }, { status: 400 });
      const res = await fetch(`https://slack.com/api/conversations.info?channel=${channelId}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return NextResponse.json({ ok: false, error: `Slack API ${res.status}` }, { status: 400 });
      const data = await res.json();
      if (!data.ok) return NextResponse.json({ ok: false, error: data.error ?? "Slack API error" }, { status: 400 });
      name = data.channel?.name ?? null;
    } else if (platform === "telegram") {
      const token = get("TELEGRAM_BOT_TOKEN");
      if (!token) return NextResponse.json({ ok: false, error: "No Telegram bot token available" }, { status: 400 });
      const res = await fetch(`https://api.telegram.org/bot${token}/getChat?chat_id=${channelId}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return NextResponse.json({ ok: false, error: `Telegram API ${res.status}` }, { status: 400 });
      const data = await res.json();
      if (!data.ok) return NextResponse.json({ ok: false, error: data.description ?? "Telegram API error" }, { status: 400 });
      name = data.result?.title ?? data.result?.first_name ?? null;
    } else {
      return NextResponse.json({ ok: false, error: `Unknown platform: ${platform}` }, { status: 400 });
    }

    return NextResponse.json({ ok: true, name: name ?? channelId });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
