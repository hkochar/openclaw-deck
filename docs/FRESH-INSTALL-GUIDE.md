# Deck — Fresh Install Guide

Complete setup guide for self-hosting the Deck AI agent orchestration dashboard.

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | 18+ | `node --version` |
| pnpm | 8+ | `npm i -g pnpm` (or use npm) |
| OpenClaw | Latest | Gateway must be running with at least one agent session |
| Python | 3.10+ | Only for ops-bot and sentinel (optional) |
| macOS | 13+ | LaunchAgents are macOS-only (optional) |

## Getting Started Checklist

These are the essential steps to go from `git clone` to a working dashboard:

### 0. Verify OpenClaw is installed and accessible

Before setting up Deck, confirm that OpenClaw is installed and you know where it lives:

```bash
# Check that the CLI is in your PATH
openclaw --version

# Check that the gateway is running
openclaw gateway status

# Find your agent data directory (default: ~/.openclaw/agents/)
ls ~/.openclaw/agents/
```

If `openclaw` isn't found, add it to your PATH or set `OPENCLAW_BIN=/path/to/openclaw` in your `.env` file.

Note the gateway port from `openclaw gateway status` output (look for `port=XXXX`). The default is 18789, but your setup may differ.

If your agent data lives in a non-standard location, you'll need to set `OPENCLAW_AGENTS_DIR` later (see [Environment Variables](#environment-variables)).

### 1. Clone and install

```bash
git clone https://github.com/openclaw/openclaw-deck.git
cd openclaw-deck
pnpm install
```

### 2. Configure gateway URL

First run auto-creates config files from examples. Edit `config/deck-config.json` to point at your gateway:

```json
{
  "serviceUrls": {
    "gateway": "http://127.0.0.1:18789"
  }
}
```

Change `18789` to whatever port your OpenClaw gateway is running on. You can also set this via the `OPENCLAW_GATEWAY_URL` environment variable.

### 3. Configure agents (optional but recommended)

Edit `config/deck-agents.json` to give your agents friendly display names. The `id` field must match the directory name under `~/.openclaw/agents/`:

```json
{
  "agents": [
    {
      "id": "main",
      "key": "my-agent",
      "name": "My Agent",
      "emoji": "🤖",
      "role": "General purpose"
    }
  ]
}
```

If you skip this step, the backfill script auto-discovers agents by scanning `~/.openclaw/agents/` and uses directory names as identifiers.

### 4. Start the dashboard

```bash
pnpm dev
```

Open http://localhost:3000. The top-right indicator should show "Connected" if your gateway is running.

To use a custom port: `PORT=3001 pnpm dev`

### 5. Install the gateway plugin (live data collection)

The plugin hooks into the OpenClaw gateway to capture LLM events in real-time:

```bash
openclaw plugins install --link ./plugin
openclaw gateway restart
```

Verify with: `openclaw plugins list` — you should see the deck plugin listed.

### 6. Import historical data (backfill)

The backfill script reads JSONL transcript files from `~/.openclaw/agents/*/sessions/*.jsonl` — the standard OpenClaw data directory — and imports them into Deck's SQLite database:

```bash
# Preview what would be imported (no writes)
pnpm backfill:dry

# Run the full 10-step pipeline
pnpm backfill
```

The script auto-discovers agents from `~/.openclaw/agents/`.

If you created `config/deck-agents.json` (step 3), it uses those mappings for friendly names; otherwise it falls back to directory names.

If your OpenClaw data lives in a non-standard location, set the `OPENCLAW_AGENTS_DIR` environment variable:

```bash
OPENCLAW_AGENTS_DIR=/custom/path/to/agents pnpm backfill
```

The backfill is fully idempotent — safe to run multiple times. You only need to run it once; the live plugin (step 5) handles everything going forward.

### 7. Verify

- Dashboard loads at http://localhost:3000
- Gateway shows "Connected" (top-right indicator)
- Logs page shows historical sessions (if you ran backfill)
- Costs page shows token usage and spend

### Optional: Discord alerts

1. Create a Discord bot at https://discord.com/developers/applications
2. Copy the bot token to `DISCORD_BOT_TOKEN_DECK` in your `.env`
3. Add channel IDs to `config/deck-agents.json` under `systemChannels` and per-agent `discordChannelId`
4. Test: visit the Services page in Deck and click "Test Alerts"

### Optional: Ops bot (Discord commands)

```bash
pip install discord.py
python ops-bot/ops_bot.py
```

Provides commands like `!status`, `!doctor`, `!restart-all` in Discord.

### Optional: macOS auto-start (LaunchAgents)

See [LaunchAgents section](#launchagents-macos-auto-start) below for automatic service startup on boot.

---

## Reference

The sections below provide detailed reference for each component.

## Environment Variables

Create a `.env` file (or set these in your shell):

```bash
# Required
OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789    # Your gateway URL

# Optional
# OPENCLAW_GATEWAY_TOKEN=your-gateway-token     # Authenticated gateway access
# OPENCLAW_AGENTS_DIR=~/.openclaw/agents         # Override agent data path
# DISCORD_BOT_TOKEN_DECK=your-discord-bot-token # Discord alerts
# DECK_URL=http://localhost:3000                 # Deep-link URL in notifications
# DECK_USAGE_DB=/path/to/usage.db               # Override usage DB path
# DECK_SYSTEM_LOG_DB=/path/to/deck-system.db    # Override system DB path
# DECK_ROOT=/path/to/openclaw-deck              # Override repo root
# OPENCLAW_BIN=openclaw                          # Override CLI binary path
```

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCLAW_GATEWAY_URL` | `http://127.0.0.1:18789` | URL of your running OpenClaw gateway |
| `OPENCLAW_GATEWAY_TOKEN` | — | Bearer token for authenticated gateway API access |
| `OPENCLAW_AGENTS_DIR` | `~/.openclaw/agents` | Path to OpenClaw agent session data |
| `DISCORD_BOT_TOKEN_DECK` | — | Discord bot token for system alerts |
| `DECK_URL` | `http://localhost:3000` | Dashboard URL used in Discord notification deep-links |
| `DECK_USAGE_DB` | `~/.openclaw-deck/data/usage.db` | Path to usage/cost SQLite DB |
| `DECK_SYSTEM_LOG_DB` | `./data/deck-system.db` | Path to system audit log SQLite DB |
| `DECK_ROOT` | Auto-detected | Override the Deck repo root directory |
| `OPENCLAW_BIN` | `openclaw` (PATH lookup) | Path to the openclaw CLI binary |

## Configuration Files

Created automatically from `.example.json` on first `pnpm dev`:

| File | Purpose | Edit via UI? |
|------|---------|-------------|
| `config/deck-config.json` | Service URLs, budgets, model pricing, provider keys | Yes (Deck Config) |
| `config/deck-agents.json` | Agent registry (name, key, emoji, Discord channels) | Yes (Deck Config) |
| `sentinel/deck-sentinel.json` | Health check rules and thresholds | Yes (Deck Config) |

### config/deck-config.json

Key sections:
- **`serviceUrls`** — Gateway and dashboard URLs
- **`budgets`** — Global/per-agent daily/weekly/monthly limits, alert thresholds
- **`modelPricing`** — Cost per million tokens for each model
- **`providerKeys`** — Management/admin API keys for cost reconciliation (optional)
- **`providerLimits`** — Rate limit windows per provider (optional)

### config/deck-agents.json

Maps OpenClaw agent directory names to display metadata. The `id` field must match a directory under `~/.openclaw/agents/`:

```json
{
  "agents": [
    {
      "id": "main",
      "key": "my-agent",
      "name": "My Agent",
      "emoji": "🤖",
      "role": "General purpose",
      "discordChannelId": "YOUR_CHANNEL_ID",
      "agentDir": ""
    }
  ],
  "systemChannels": {
    "systemStatus": "YOUR_CHANNEL_ID"
  }
}
```

## How Data Flows Into Deck

Deck collects data through two independent paths:

**Live plugin** — captures events in real-time via gateway hooks. This is the primary data source once installed. It captures LLM calls, tool invocations, user messages, heartbeats, model drift, and budget alerts.

**Backfill script** — recovers historical data from OpenClaw's JSONL transcript files (`~/.openclaw/agents/*/sessions/*.jsonl`). Fills in sessions from before the plugin was installed.

### What each path captures

| Data | Live Plugin | Backfill | Notes |
|------|------------|----------|-------|
| LLM calls (input/output/tokens) | Yes | Yes | Both capture full token data |
| Tool calls (name, args, result) | Yes | Yes | Both extract tool metadata |
| User messages | Yes | Yes | |
| Provider cost | Yes | Yes | Calculated from tokens + pricing table |
| Prompt text | Yes (via hook) | Yes (recovered from transcript) | Live writes `prompt` column directly; backfill recovers user text from JSONL transcripts and stores as `promptPreview` in the `detail` JSON field |
| Session channel (discord/slack/etc.) | Yes | Defaults to "main" | Transcript filenames don't encode channel |
| Heartbeats / drift alerts | Yes | No | Generated by live monitoring only |
| Display name / labels | Yes | No | User-assigned via dashboard UI |
| Full-text search index | Yes (incremental) | No | Built by plugin's background sync |

## LaunchAgents (macOS Auto-Start)

For automatic service startup on boot, create plist files in `~/Library/LaunchAgents/`:

| Label | Service | Port |
|-------|---------|------|
| `ai.openclaw.deck` | Next.js dashboard | 3000 |
| `ai.openclaw.gateway` | OpenClaw gateway | 18789 |
| `ai.openclaw.ops-bot` | Discord ops bot | — |
| `ai.openclaw.sentinel` | Health monitor | — |

Example plist for the dashboard:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>ai.openclaw.deck</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>/path/to/openclaw-deck</string>
    <key>ProgramArguments</key>
    <array>
      <!-- Use `which node` to find your Node path (may differ with nvm/brew) -->
      <string>/usr/local/bin/node</string>
      <string>node_modules/.bin/next</string>
      <string>dev</string>
      <string>--hostname</string>
      <string>0.0.0.0</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PORT</key>
      <string>3000</string>
      <key>NODE_ENV</key>
      <string>development</string>
    </dict>
    <key>StandardOutPath</key>
    <string>/tmp/deck.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/deck.err.log</string>
  </dict>
</plist>
```

Load with: `launchctl load ~/Library/LaunchAgents/ai.openclaw.deck.plist`

## Data Directories

Created automatically by the bootstrap script:

| Directory | Purpose |
|-----------|---------|
| `./data/` | System audit log DB (`deck-system.db`) |
| `~/.openclaw-deck/data/` | Usage/cost DB (`usage.db`) |
| `~/.openclaw-deck/state/` | Poller cursor state |

## Testing

```bash
pnpm test              # Unit tests (no services needed)
pnpm test:smoke        # Fresh install validation (no services needed)
pnpm test:smoke:live   # Service health checks (needs Deck + Gateway running)
pnpm test:e2e          # Playwright end-to-end tests (needs Deck running)
```

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| Gateway shows "Offline" in dashboard | `OPENCLAW_GATEWAY_URL` doesn't match actual gateway port | Check gateway port with `ss -ltnp \| grep 18789` and update `.env` |
| "SQLITE_CANTOPEN" on startup | Data directories don't exist | Run `pnpm setup` or `node scripts/bootstrap-config.mjs` |
| Discord alerts not arriving | Wrong bot token env var name | Use `DISCORD_BOT_TOKEN_DECK` (not `DISCORD_BOT_TOKEN_MC`) |
| "load failed" when restarting all services | Dashboard restarts itself mid-response | Expected — refresh the page after a few seconds |
| Plugin says "config not found" | `DECK_ROOT` not set and working dir differs from repo root | Set `DECK_ROOT=/path/to/openclaw-deck` in gateway env |
| Session lock file prevents agent start | Previous process crashed without cleanup | Delete `~/.openclaw/agents/<id>/sessions/*.lock` |
| LaunchAgent not found | Wrong label name | Labels must be `ai.openclaw.{deck,gateway,ops-bot,sentinel}` |
| Config changes not taking effect | Service running old code | Restart the affected service via Services page or `launchctl kickstart -k` |

## Debugging Common Issues

A quick reference for the issues that come up most often in day-to-day operation.

### White screen / blank page

Stale Next.js cache. This happens after config renames, major updates, or branch switches.

```bash
rm -rf .next
pnpm dev    # or: pnpm build && pnpm start
```

### "Missing required error components, refreshing..."

The dev server is still compiling after a cache clear. Wait 10-15 seconds and refresh. If it persists, kill the process and restart:

```bash
# Find and kill the stuck process
lsof -ti :3000 | xargs kill -9
pnpm dev
```

### Dashboard starts but shows no data

1. Check gateway is running: `curl http://127.0.0.1:18789/health`
2. Check plugin is installed: `openclaw plugins list`
3. Check DB exists: `ls ~/.openclaw-deck/data/usage.db`
4. Run backfill if DB is empty: `pnpm backfill`

### Port 3000 already in use

```bash
# Find what's using the port
lsof -i :3000

# Kill it
lsof -ti :3000 | xargs kill -9

# Or use a different port
PORT=3001 pnpm dev
```

### LaunchAgent won't start / keeps restarting

```bash
# Check status
launchctl print gui/$(id -u)/ai.openclaw.deck

# Check logs
tail -50 /tmp/openclaw-deck.log

# Common fix: Node path is wrong in plist
which node    # Use this path in the plist
```

### Build errors after git pull

```bash
rm -rf .next node_modules
pnpm install
pnpm build
```

### SQLite "database is locked"

Usually means two processes are writing to the same DB. Check for orphaned processes:

```bash
lsof ~/.openclaw-deck/data/usage.db
```

Kill any stale process, or restart the gateway (which restarts the plugin).

### Config bootstrap didn't run

If `config/deck-config.json` doesn't exist after `pnpm dev`:

```bash
node scripts/bootstrap-config.mjs
```

### Gateway shows "Offline" but is actually running

The dashboard URL doesn't match the gateway port. Check:

```bash
# What port is the gateway on?
ss -ltnp | grep 18789

# What does your config say?
cat config/deck-config.json | grep gateway
```

Update `serviceUrls.gateway` in `config/deck-config.json` or set `OPENCLAW_GATEWAY_URL` in `.env`.

> **Note:** This section will be expanded with more debugging scenarios over time. If you hit an issue not covered here, please [open an issue](https://github.com/openclaw/openclaw-deck/issues).
