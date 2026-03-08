# Deck — Upgrading

How to update Deck to a new version.

## Standard Upgrade

```bash
cd /path/to/openclaw-deck
git pull
pnpm install
pnpm build
```

Then restart the dashboard:

```bash
# If running as LaunchAgent:
launchctl stop ai.openclaw.deck && launchctl start ai.openclaw.deck

# If running manually:
# Stop the running process, then:
pnpm start
```

## Database Migrations

**Migrations are automatic.** The plugin and backfill script handle schema changes on startup — no manual steps needed.

How it works:
- On every gateway restart, the plugin checks the SQLite schema and runs `ALTER TABLE ... ADD COLUMN` for any missing columns
- Migrations are additive only (new columns, new tables, new indexes) — existing data is never modified or dropped
- The backfill script (`pnpm backfill`) also applies the full schema, so running it after an upgrade ensures everything is current

You do **not** need to run any migration commands manually.

## Plugin Upgrade

If the plugin has changed (check `plugin/` in the git diff):

```bash
cd plugin
npm install --omit=dev
openclaw gateway restart
```

The gateway restart triggers the plugin's startup routine, which applies any new schema migrations.

## Config Changes

New config options are added to the `.example.json` files. After pulling:

1. Compare your config against the updated example:
   ```bash
   diff config/deck-config.json config/deck-config.example.json
   ```
2. Add any new keys you want to use

Existing config keys are never removed or renamed without a major version bump.

## What Can Go Wrong

### Build fails after upgrade

```bash
rm -rf .next node_modules
pnpm install
pnpm build
```

A stale `.next` cache or outdated `node_modules` is the most common cause.

### Dashboard shows stale UI

Clear the Next.js cache:

```bash
rm -rf .next
pnpm build
```

### Plugin won't load after upgrade

Re-install the plugin link:

```bash
openclaw plugins install --link ./plugin
openclaw gateway restart
```

### Database corruption (unlikely)

The SQLite database at `~/.openclaw-deck/data/usage.db` is the only stateful component. If something goes wrong:

1. **Backup first:** `cp ~/.openclaw-deck/data/usage.db ~/.openclaw-deck/data/usage.db.bak`
2. **Re-run backfill:** `pnpm backfill` — this is fully idempotent and rebuilds missing data from OpenClaw's JSONL transcripts
3. **Nuclear option:** Delete `usage.db` and run `pnpm backfill` to rebuild from scratch. You'll lose live plugin data (heartbeats, drift events, display names) but recover all session/event/cost data.

## Version History

See [CHANGELOG.md](../CHANGELOG.md) for what changed in each release.
