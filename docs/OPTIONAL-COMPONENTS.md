# Deck — Optional Components

Deck's core (dashboard + gateway plugin) works without these. The two optional Python components add external health monitoring and Discord-based operations.

Both require **Python 3.10+** and use **stdlib only** — no pip installs.

```
┌─────────────────────────────────────────────┐
│  Deck Dashboard (Next.js)   ← always runs   │
│  Gateway Plugin             ← always runs   │
├─────────────────────────────────────────────┤
│  Ops Bot (Discord commands) ← optional       │
│  Sentinel (health checks)   ← optional       │
└─────────────────────────────────────────────┘
```

---

## Ops Bot — Discord Operations

A Discord bot that lets you manage services from chat.

### Setup

1. **Create a Discord bot** at https://discord.com/developers/applications
2. **Enable Message Content Intent**: Settings > Bot > Privileged Gateway Intents
3. **Invite the bot** to your server with message read/send permissions
4. **Set environment variables:**

```bash
export DISCORD_BOT_TOKEN_DECK=your-bot-token
export DECK_OPS_CHANNEL_ID=your-channel-id
```

5. **Run:**

```bash
python3 ops-bot/ops_bot.py
```

### Commands

| Command | Action |
|---------|--------|
| `!status` | Show all LaunchAgent service statuses |
| `!doctor` | Run `openclaw doctor` diagnostics |
| `!restart-all` | Restart all managed services |
| `!openclaw-gw` | Restart the OpenClaw gateway |
| `!nextjs` | Restart the Deck dashboard |
| `!ops-bot` | Restart the ops bot itself |
| `!revert-config` | Revert config to last git commit |
| `!help` | List available commands |

Commands can be enabled/disabled in `config/deck-agents.json` under `opsBotCommands`.

### Testing

```bash
python3 -m pytest ops-bot/test_commands.py -v
```

### Auto-Start (macOS)

Create `~/Library/LaunchAgents/ai.openclaw.ops-bot.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.openclaw.ops-bot</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/python3</string>
    <string>ops-bot/ops_bot.py</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/path/to/openclaw-deck</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DISCORD_BOT_TOKEN_DECK</key>
    <string>your-bot-token</string>
    <key>DECK_OPS_CHANNEL_ID</key>
    <string>your-channel-id</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/ops-bot.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/ops-bot.log</string>
</dict>
</plist>
```

Load: `launchctl load ~/Library/LaunchAgents/ai.openclaw.ops-bot.plist`

---

## Sentinel — External Health Monitor

Sentinel runs independently of the gateway and checks system health from the outside. It detects problems the gateway can't see (because the gateway itself might be down).

### Important

Sentinel must **not** be added to any automated scheduler (crontab, launchd) without **explicit operator approval**. Manual and interactive runs are fine.

### Quick Start

```bash
# Copy the example config
cp sentinel/deck-sentinel.example.json sentinel/deck-sentinel.json

# Edit deck-sentinel.json with your paths and URLs

# Dry run — no writes, no HTTP calls
python3 sentinel/sentinel_loop.py --config sentinel/deck-sentinel.json --dry-run

# Run once — check all enabled monitors, then exit
python3 sentinel/sentinel_loop.py --config sentinel/deck-sentinel.json --once

# Run in loop — checks every 5 minutes (Ctrl-C to stop)
python3 sentinel/sentinel_loop.py --config sentinel/deck-sentinel.json
```

### Available Checks

| Check | What It Monitors | Config Key |
|-------|-----------------|------------|
| `gateway_health` | Gateway `/health` endpoint reachable | `gateway_url` |
| `dashboard_health` | Dashboard HTTP health | `checks.dashboard_health.url` |
| `cron_health` | Cron job consecutive error counts | `cron_status_file`, `cron_consecutive_error_threshold` |
| `working_md` | Agent WORKING.md freshness (stale = crashed?) | `working_md_path`, `working_md_max_age_hours` |
| `security_audit` | World-writable files in configured paths | `security_scan_paths` |
| `ghost_crons` | Orphaned cron processes | — |
| `port_conflicts` | Port binding conflicts | `checks.port_conflicts.ports` |

### Enabling/Disabling Checks

In `sentinel/deck-sentinel.json`:

```json
{
  "checks": {
    "gateway_health":   { "enabled": true },
    "dashboard_health": { "enabled": true },
    "cron_health":      { "enabled": true },
    "working_md":       { "enabled": true },
    "security_audit":   { "enabled": false },
    "ghost_crons":      { "enabled": false },
    "port_conflicts":   { "enabled": false }
  }
}
```

### Incident Output

Incidents are appended to `sentinel/sentinel_runs.jsonl`:

```json
{
  "incident_id": "INC-20260304-143022-A3F1",
  "check": "gateway_health",
  "severity": "critical",
  "message": "Gateway health endpoint unreachable",
  "details": { "url": "http://127.0.0.1:18789/health", "error": "Connection refused" }
}
```

### Severity Levels

| Level | Meaning |
|-------|---------|
| `critical` | Immediate action required |
| `high` | Urgent — address within 1 hour |
| `medium` | Address within 4 hours |
| `low` | Monitor; non-urgent |
| `info` | Informational only |

### Auto-Start (macOS)

Create `~/Library/LaunchAgents/ai.openclaw.sentinel.plist` (same structure as ops-bot above, with `sentinel/sentinel_loop.py` as the program argument and `--config sentinel/deck-sentinel.json` as additional arguments).

**Remember:** requires operator approval before enabling automated scheduling.

---

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| Ops bot doesn't respond | Wrong channel ID | Verify `DECK_OPS_CHANNEL_ID` matches the channel where you're sending commands |
| Ops bot connects but no commands work | Message Content Intent not enabled | Enable it in Discord Developer Portal > Bot > Privileged Gateway Intents |
| Sentinel can't reach gateway | Gateway not running or wrong URL | Check `gateway_url` in `deck-sentinel.json`, verify with `curl http://127.0.0.1:18789/health` |
| Sentinel fires false positives | Thresholds too aggressive | Increase `working_md_max_age_hours` or `cron_consecutive_error_threshold` |
| "Permission denied" on sentinel_runs.jsonl | File owned by different user | Fix ownership: `chown $(whoami) sentinel/sentinel_runs.jsonl` |

---

## Files

```
ops-bot/
├── ops_bot.py              # Main bot script
├── test_commands.py         # pytest tests
└── README.md

sentinel/
├── sentinel_loop.py         # Main check runner
├── notifier.py              # Incident formatter
├── deck-sentinel.example.json  # Template config
├── incident_template.md     # Incident report template
├── sentinel_runs.jsonl      # Auto-created incident log
└── README.md
```
