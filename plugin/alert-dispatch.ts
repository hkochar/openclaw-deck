/**
 * Multi-platform alert dispatcher.
 * Routes alerts to Discord, Slack, or Telegram based on channel reference prefix.
 *
 * Channel ref format: "platform:id" e.g. "discord:123456", "slack:C0ABC", "telegram:-100123"
 * Bare numeric IDs default to Discord for backward compatibility.
 */

export interface AlertButton {
  label: string;
  url: string;
}

export interface AlertMessage {
  title: string;       // e.g. "Budget WARNING"
  icon?: string;       // emoji prefix e.g. "🟡"
  lines: string[];     // code-block body lines (key: value pairs)
  buttons?: AlertButton[];
}

export type AlertPlatform = "discord" | "slack" | "telegram";

export interface AlertTokens {
  discord?: string;
  slack?: string;
  telegram?: string;
}

/** Parse a channel reference into platform + id. Bare numeric IDs default to discord. */
export function parseChannelRef(ref: string): { platform: AlertPlatform; id: string } {
  const match = ref.match(/^(discord|slack|telegram):(.+)$/);
  if (match) {
    return { platform: match[1] as AlertPlatform, id: match[2] };
  }
  // Bare value — default to discord
  return { platform: "discord", id: ref };
}

/** Check if a channel ref string is valid (has a non-empty id after parsing). */
export function isValidChannelRef(ref: string): boolean {
  const { id } = parseChannelRef(ref);
  return id.trim().length > 0;
}

/**
 * Send an alert to the appropriate platform based on channel ref prefix.
 * Silently returns if token is missing or channel is empty.
 */
export async function sendAlert(
  channelRef: string,
  msg: AlertMessage,
  tokens: AlertTokens,
  logger?: { warn: (msg: string) => void },
): Promise<void> {
  if (!channelRef) return;
  const { platform, id } = parseChannelRef(channelRef);
  if (!id) return;

  const token = tokens[platform];
  if (!token) {
    logger?.warn(`alert-dispatch: no ${platform} token available, skipping alert "${msg.title}"`);
    return;
  }

  try {
    switch (platform) {
      case "discord":
        await sendDiscordAlert(id, msg, token);
        break;
      case "slack":
        await sendSlackAlert(id, msg, token);
        break;
      case "telegram":
        await sendTelegramAlert(id, msg, token);
        break;
    }
  } catch (err) {
    logger?.warn(`alert-dispatch: ${platform} alert failed: ${String(err)}`);
  }
}

// ── Discord ────────────────────────────────────────────────────────────────

async function sendDiscordAlert(channelId: string, msg: AlertMessage, botToken: string): Promise<void> {
  const titleLine = msg.icon ? `${msg.icon} **${msg.title}**` : `**${msg.title}**`;
  const body: Record<string, unknown> = {
    content: [titleLine, "```", ...msg.lines, "```"].join("\n"),
  };
  if (msg.buttons?.length) {
    body.components = [{
      type: 1,
      components: msg.buttons.slice(0, 5).map((b) => ({
        type: 2, style: 5, label: b.label, url: b.url,
      })),
    }];
  }
  await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bot ${botToken}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
}

// ── Slack ───────────────────────────────────────────────────────────────────

async function sendSlackAlert(channelId: string, msg: AlertMessage, botToken: string): Promise<void> {
  const titleText = msg.icon ? `${msg.icon} *${msg.title}*` : `*${msg.title}*`;
  const codeBlock = "```\n" + msg.lines.join("\n") + "\n```";

  const blocks: Array<Record<string, unknown>> = [
    { type: "section", text: { type: "mrkdwn", text: `${titleText}\n${codeBlock}` } },
  ];

  if (msg.buttons?.length) {
    blocks.push({
      type: "actions",
      elements: msg.buttons.slice(0, 5).map((b) => ({
        type: "button",
        text: { type: "plain_text", text: b.label },
        url: b.url,
      })),
    });
  }

  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${botToken}` },
    body: JSON.stringify({ channel: channelId, blocks, text: `${msg.title}: ${msg.lines[0] ?? ""}` }),
    signal: AbortSignal.timeout(10_000),
  });
}

// ── Telegram ───────────────────────────────────────────────────────────────

async function sendTelegramAlert(chatId: string, msg: AlertMessage, botToken: string): Promise<void> {
  const titleText = msg.icon ? `${msg.icon} *${escTgMarkdown(msg.title)}*` : `*${escTgMarkdown(msg.title)}*`;
  const codeBlock = "```\n" + msg.lines.join("\n") + "\n```";

  const body: Record<string, unknown> = {
    chat_id: chatId,
    text: `${titleText}\n${codeBlock}`,
    parse_mode: "MarkdownV2",
  };

  if (msg.buttons?.length) {
    body.reply_markup = {
      inline_keyboard: [
        msg.buttons.slice(0, 5).map((b) => ({
          text: b.label,
          url: b.url,
        })),
      ],
    };
  }

  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
}

/** Escape special chars for Telegram MarkdownV2 (outside code blocks). */
function escTgMarkdown(s: string): string {
  return s.replace(/([_\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}
