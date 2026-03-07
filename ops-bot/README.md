# Deck Ops Bot

Discord bot for operational commands. Pure Python 3.10+ stdlib — no pip installs required.

## Setup

1. Create a Discord bot at https://discord.com/developers/applications
2. Enable the **Message Content Intent** (Settings > Bot > Privileged Gateway Intents)
3. Invite the bot to your server with message read/send permissions
4. Set environment variables:

```bash
export DISCORD_BOT_TOKEN_DECK=your-bot-token
export DECK_OPS_CHANNEL_ID=your-channel-id   # channel where bot listens for commands
```

5. Run:

```bash
python3 ops-bot/ops_bot.py
```

## Commands

| Command | Description |
|---------|-------------|
| `!status` | Show all service statuses |
| `!doctor` | Run diagnostics (gateway, services, config) |
| `!restart-all` | Restart all managed services |
| `!openclaw-gw` | Restart the OpenClaw gateway |
| `!nextjs` | Restart the Deck dashboard |
| `!ops-bot` | Restart the ops bot itself |
| `!revert-config` | Revert config to last git commit |
| `!help` | List available commands |

Commands can be enabled/disabled in `config/deck-agents.json` under `opsBotCommands`.

## Auto-Start (macOS)

Create a LaunchAgent plist at `~/Library/LaunchAgents/ai.openclaw.ops-bot.plist` to run on boot. See [docs/FRESH-INSTALL-GUIDE.md](../docs/FRESH-INSTALL-GUIDE.md) for a plist template.

## Testing

```bash
python3 -m pytest ops-bot/test_commands.py -v
```
