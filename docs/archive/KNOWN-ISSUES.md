# Known Issues — Deck Open-Source Migration

Issues discovered during the Mission Control → Deck rename and open-source preparation. All have been fixed, documented here for reference.

## Issues Found & Fixed

| # | Issue | Root Cause | Fix Applied | Prevention |
|---|-------|-----------|-------------|------------|
| 1 | Gateway shows "Offline" in dashboard | `gateway-health/route.ts` hardcoded port 18789 instead of reading env | Import `GATEWAY_URL` from shared `paths.ts` | Smoke test: no hardcoded ports in health checks |
| 2 | Plugin logs "Deck config not found" | `DECK_ROOT` defaulted to `openclaw-deck-ui` directory name that didn't exist on disk | Use `path.resolve(__dirname, "..")` for all plugin path resolution | Smoke test: no hardcoded directory names |
| 3 | Discord alerts stop firing after rename | `DISCORD_BOT_TOKEN_MC` renamed to `DISCORD_BOT_TOKEN_DECK` in code but gateway still running with old env | Restart gateway after env var changes | Documented in install guide |
| 4 | "load failed" error on restart-all | Dashboard kills itself first via `launchctl kickstart -k`, HTTP response drops | Restart Deck last using detached process with 1s delay | Self-healing: response sent before restart |
| 5 | LaunchAgent label mismatch | Old `ai.openclaw.mission-control` label still in code and plist files | Renamed all labels to `ai.openclaw.deck` | Smoke test: label consistency check |
| 6 | SQLite CANTOPEN on fresh install | `data/` and `~/.openclaw-deck/data/` directories don't exist | Bootstrap script (`scripts/bootstrap-config.mjs`) creates dirs on `pnpm dev` | Smoke test: bootstrap creates directories |
| 7 | Stale session lock files | Crashed agent process leaves `.lock` file, blocks next startup | Manual deletion of `~/.openclaw/agents/<id>/sessions/*.lock` | Documented in troubleshooting |
| 8 | `isPrimary` leak | Variable named `isJane` leaked agent-specific naming into shared code | Renamed to `isPrimary` | Smoke test: no agent-specific names in source |
| 9 | Hardcoded dashboard directory name | Multiple files assumed the repo was cloned as `openclaw-deck-ui` | Use `process.cwd()` for dashboard, `__dirname` for plugin/sentinel/ops-bot | Smoke test: no hardcoded directory names |
| 10 | Integration tests hardcode gateway port | Tests used `http://localhost:18789` directly | Use `GATEWAY_URL` from shared helpers | — |
| 11 | `.env.local` contained stale Convex credentials | Old Convex deployment URL and key left in `.env.local` | Deleted `.env.local`, documented all env vars in `.env.example` | — |
| 12 | Ops-bot `!doctor` shows wrong service name | Service label `ai.openclaw.openclaw-deck` (double prefix) in code | Fixed to `ai.openclaw.deck` everywhere | Smoke test: label format validation |

## Environment Variable Rename Map

| Old (MC era) | New (Deck) | Used In |
|-------------|-----------|---------|
| `MC_ROOT` | `DECK_ROOT` | Plugin, sentinel, ops-bot |
| `MC_USAGE_DB` | `DECK_USAGE_DB` | paths.ts |
| `MC_SYSTEM_LOG_DB` | `DECK_SYSTEM_LOG_DB` | paths.ts |
| `MC_DIR` | `DECK_DIR` | paths.ts, config-git.ts |
| `MC_URL` | `DECK_URL` | tests |
| `DISCORD_BOT_TOKEN_MC` | `DISCORD_BOT_TOKEN_DECK` | plugin, ops-bot, .env |
| `MISSION_CONTROL_SITE_URL` | `OPENCLAW_DECK_SITE_URL` | plugin |

## LaunchAgent Label Map

| Old | New |
|-----|-----|
| `ai.openclaw.mission-control` | `ai.openclaw.deck` |
| `ai.openclaw.openclaw-deck` | `ai.openclaw.deck` |

All services now use: `ai.openclaw.{deck,gateway,ops-bot,sentinel}`
