# Deck — Deployment Guide

Production deployment guide for the Deck AI agent orchestration dashboard. Deck runs on **macOS** (the same machine as the OpenClaw gateway).

## Architecture

```
┌──────────────────────────────────┐
│         OpenClaw Gateway         │
│          (port 18789)            │
├──────────┬───────────────────────┤
│  Plugin  │   SQLite (usage.db)   │
└──────────┴──────────┬────────────┘
                      │
              ┌───────┴───────┐
              │  Next.js App  │
              │  (port 3000)  │
              └───────────────┘
```

Both the gateway (with plugin) and the dashboard should run on the same machine for local SQLite access.

## Prerequisites

| Requirement | Version | Check |
|-------------|---------|-------|
| macOS | 13+ | `sw_vers` |
| Node.js | 18+ (22 recommended) | `node --version` |
| pnpm | 8+ | `pnpm --version` |
| OpenClaw | Latest | `openclaw --version` |

## Production Build

```bash
git clone https://github.com/openclaw/openclaw-deck.git
cd openclaw-deck
pnpm install
cp .env.example .env
# Edit .env — see Environment Variables below
pnpm build
pnpm start
```

The `build` step automatically runs `scripts/bootstrap-config.mjs`, which creates:
- `config/deck-config.json` from `config/deck-config.example.json`
- `config/deck-agents.json` from `config/deck-agents.example.json`
- `~/.openclaw-deck/data/` directory for the SQLite database

## Environment Variables

Set in `.env` (or `.env.local` for Next.js):

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `OPENCLAW_GATEWAY_URL` | No | `http://127.0.0.1:18789` | Gateway HTTP endpoint |
| `OPENCLAW_GATEWAY_TOKEN` | Yes | — | Bearer token for gateway API auth |
| `DECK_URL` | No | `http://localhost:3000` | Dashboard URL (used in alert deep-links) |
| `DECK_USAGE_DB` | No | `~/.openclaw-deck/data/usage.db` | Custom path for usage SQLite database |
| `DECK_SYSTEM_LOG_DB` | No | `./data/deck-system.db` | Custom path for system audit database |
| `DECK_ROOT` | No | Auto-detected | Deck repo root (plugin config lookup) |
| `OPENCLAW_BIN` | No | `openclaw` (PATH) | Path to OpenClaw CLI binary |
| `DISCORD_BOT_TOKEN_DECK` | No | — | Discord bot token for system alerts |

See `.env.example` for the full list.

## Plugin Installation

The gateway plugin collects telemetry in real time. Install it once:

```bash
cd plugin
npm install --omit=dev
openclaw plugins install --link ./plugin
openclaw gateway restart
```

Verify: `openclaw plugins list` should show `openclaw-deck-sync`.

The plugin creates the full database schema on first run (16 tables including FTS5 search index).

## Running as a LaunchAgent (macOS)

To keep Deck running across reboots, create a LaunchAgent plist:

### Dashboard LaunchAgent

Create `~/Library/LaunchAgents/ai.openclaw.deck.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.openclaw.deck</string>
  <key>ProgramArguments</key>
  <array>
    <!-- Use `which node` to find your Node path (may differ with nvm/brew) -->
    <string>/usr/local/bin/node</string>
    <string>node_modules/.bin/next</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/path/to/openclaw-deck</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>PORT</key>
    <string>3000</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/openclaw-deck.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/openclaw-deck.log</string>
</dict>
</plist>
```

Load and start:

```bash
launchctl load ~/Library/LaunchAgents/ai.openclaw.deck.plist
launchctl start ai.openclaw.deck
```

**Note:** Update `WorkingDirectory` and the `node` path for your system. Use `which node` to find the correct path.

### Management Commands

```bash
# Check status
launchctl print gui/$(id -u)/ai.openclaw.deck

# Stop
launchctl stop ai.openclaw.deck

# Restart
launchctl stop ai.openclaw.deck && launchctl start ai.openclaw.deck

# Unload (disable)
launchctl unload ~/Library/LaunchAgents/ai.openclaw.deck.plist

# View logs
tail -f /tmp/openclaw-deck.log
```

## Docker (Experimental)

> **Note:** Docker is community/experimental. The recommended deployment is macOS with LaunchAgents (above). Docker works for the dashboard but has SQLite concurrency limitations when the gateway plugin writes to the same DB file from the host.

No official Dockerfile is provided. If you want to run Deck in Docker, create a `Dockerfile`:

```dockerfile
FROM node:22-alpine
WORKDIR /app

RUN npm i -g pnpm

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

EXPOSE 3000
CMD ["pnpm", "start"]
```

**Important considerations:**
- The SQLite database (`usage.db`) must persist across restarts — mount a volume at `~/.openclaw-deck/data/`
- The gateway plugin writes to the same SQLite file, so both the plugin (running on the host) and the Docker container need access to the same DB file
- Config files in `config/` should also be mounted for persistence

Example `docker-compose.yml`:

```yaml
services:
  deck:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - deck-data:/root/.openclaw-deck/data
      - ./config:/app/config
      - ./.env:/app/.env
    environment:
      - NODE_ENV=production
    restart: unless-stopped

volumes:
  deck-data:
```

**Note:** Running Docker alongside a host-native gateway plugin requires both processes to access the same SQLite file. The simplest approach is running everything on the host with LaunchAgents.

## Reverse Proxy

If you want to expose Deck beyond localhost (e.g., on a private network), put it behind a reverse proxy.

### Caddy (recommended)

```
deck.local {
  reverse_proxy localhost:3000
}
```

### nginx

```nginx
server {
    listen 443 ssl;
    server_name deck.local;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

**Security warning:** Deck has no built-in authentication. Do not expose it to the public internet without adding auth. See **[SECURING.md](SECURING.md)** for step-by-step setup guides (Tailscale, Cloudflare Access, Caddy basicauth, nginx auth_basic, OAuth2 Proxy).

## Updating

```bash
cd openclaw-deck
git pull
pnpm install
pnpm build
# Restart the dashboard (launchctl or manual)
```

The SQLite schema is managed by the plugin and backfill script — both handle migrations automatically.

## Troubleshooting

### Dashboard won't start

1. Check Node.js version: `node --version` (need 18+)
2. Check `.env` exists with `OPENCLAW_GATEWAY_TOKEN`
3. Run `pnpm build` again to ensure config bootstrap ran
4. Check logs: `tail -f /tmp/openclaw-deck.log`

### No data in dashboard

1. Verify plugin is installed: `openclaw plugins list`
2. Check gateway is running: `curl http://127.0.0.1:18789/health`
3. Check the database exists: `ls ~/.openclaw-deck/data/usage.db`
4. Run historical backfill: `pnpm backfill`

### API routes return errors

If API routes return `{ ok: false }` with `X-Source: sqlite-fallback` header, the gateway is unreachable. The dashboard falls back to reading directly from SQLite for most queries, but some features (service control, model swaps) require a live gateway connection.

### Port conflicts

Default ports: **3000** (dashboard), **18789** (gateway). Override the dashboard port with `PORT=3001 pnpm start`.
