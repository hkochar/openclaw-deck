# Deck — Uninstalling

How to cleanly remove Deck from your system.

## 1. Stop Services

If running as LaunchAgents:

```bash
# Stop and unload all Deck services
launchctl unload ~/Library/LaunchAgents/ai.openclaw.deck.plist 2>/dev/null
launchctl unload ~/Library/LaunchAgents/ai.openclaw.ops-bot.plist 2>/dev/null
launchctl unload ~/Library/LaunchAgents/ai.openclaw.sentinel.plist 2>/dev/null
```

If running manually, stop the `pnpm dev` or `pnpm start` process.

**Note:** Do not unload `ai.openclaw.gateway` — that's the OpenClaw gateway, not part of Deck.

## 2. Remove LaunchAgent Plists

```bash
rm -f ~/Library/LaunchAgents/ai.openclaw.deck.plist
rm -f ~/Library/LaunchAgents/ai.openclaw.ops-bot.plist
rm -f ~/Library/LaunchAgents/ai.openclaw.sentinel.plist
```

## 3. Remove the Gateway Plugin

```bash
openclaw plugins uninstall openclaw-deck-sync
openclaw gateway restart
```

Verify removal: `openclaw plugins list` should no longer show the deck plugin.

## 4. Remove Data Directories

Deck stores data in two locations:

| Path | Contents | Size |
|------|----------|------|
| `~/.openclaw-deck/data/usage.db` | All telemetry, costs, sessions | Varies (10 MB – 1 GB+) |
| `~/.openclaw-deck/state/` | Poller cursor state | < 1 KB |

```bash
# Remove all Deck data (irreversible)
rm -rf ~/.openclaw-deck/
```

**Optional:** The system audit log is stored in the repo at `./data/deck-system.db`. This is removed when you delete the repo (step 6).

## 5. Remove Log Files

```bash
rm -f /tmp/openclaw-deck.log
rm -f /tmp/deck.log
rm -f /tmp/deck.err.log
```

## 6. Remove the Repo

```bash
rm -rf /path/to/openclaw-deck
```

## What's NOT Removed

These belong to OpenClaw, not Deck — leave them unless you're uninstalling OpenClaw itself:

- `~/.openclaw/` — OpenClaw agent data, sessions, config
- `ai.openclaw.gateway` LaunchAgent — the OpenClaw gateway
- The `openclaw` CLI binary
