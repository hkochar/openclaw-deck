# Fresh Install Test Notes

Tested: 2026-03-05
Method: `git clone` from `hkochar/openclaw-deck-dev`, follow `docs/FRESH-INSTALL-GUIDE.md` exactly.

## Issues Found

### 1. ✅ `pnpm install` — native deps don't build
**Symptom:** `better-sqlite3` build scripts are ignored. Dashboard crashes with SQLite errors.
**Root cause:** pnpm 10+ requires `pnpm.onlyBuiltDependencies` in `package.json` to allow native compilation.
**Fix:** Added `pnpm.onlyBuiltDependencies` to `package.json` for `better-sqlite3`, `esbuild`, `unrs-resolver`.

### 2. ⏳ Clone URL doesn't exist yet
**Symptom:** Guide says `git clone https://github.com/openclaw/openclaw-deck.git` — that repo doesn't exist.
**Action needed:** Update once public repo is created. For now, use `hkochar/openclaw-deck-dev`.

### 3. ✅ Shared data directory `~/.openclaw-deck/` causes conflicts
**Symptom:** If user already has Deck installed, fresh install shares the same DB.
**Impact:** Low — only affects testing/development. `DECK_USAGE_DB` env var exists as escape hatch.

### 4. ✅ Demo DB works but live gateway also connects
**Symptom:** Fresh install with demo DB shows demo data + real agent data from gateway.
**Fix:** Updated demo banner to say "Run `pnpm backfill` to import your real data" with actionable instructions.

### 5. ✅ No mention of PORT env var in quick start
**Fix:** Added `PORT=3001 pnpm dev` example in the guide.

### 6. ✅ Real config files were tracked in git
**Symptom:** Fresh clone contained personal Discord IDs, Tailscale IPs, agent-specific budgets.
**Fix:** `git rm --cached` all three files. Now only `.example.json` files (e.g. `deck-config.example.json`, `deck-agents.example.json`, `deck-sentinel.example.json`) ship in git.

### 7. ✅ Must use `pnpm dev` not `npx next dev`
**Symptom:** `npx next dev` skips bootstrap, build fails with `Module not found: Can't resolve '@/config/deck-agents.json'`.
**Fix:** Added guard in `next.config.mjs` — checks if `config/deck-agents.json` exists, exits with clear "run `pnpm dev` instead" message if missing.

### 8. ✅ Demo DB not seeded (empty DB race)
**Symptom:** Fresh install shows empty dashboard — no demo data.
**Fix:** Bootstrap now also seeds if the DB exists but is ≤8KB (schema-only, no real data).

### 9. ✅ No verification that OpenClaw is installed
**Fix:** Added Step 0 to install guide. Added fail-fast error in backfill script when agents dir not found.

### 10. ✅ Backfilled agents invisible if not in agents.json
**Symptom:** Backfill imports 500+ sessions but sessions page only shows 5 example agents.
**Fix:** Auto-discover agents from DB — include any agent not in config with capitalized name and 🤖 emoji.

### 11. ✅ Gateway health check fails with SPA catch-all
**Symptom:** Dashboard shows "Gateway Offline" even when gateway is running.
**Fix:** Check `Content-Type` before parsing JSON. Fall back to root ping if HTML.

### 12. ✅ Gateway port auto-detection
**Symptom:** Example config assumes port 18789 but actual port varies.
**Fix:** Bootstrap reads `~/.openclaw/openclaw.json` for `gateway.port` and auto-patches `config/deck-config.json` if still using the default 18789.

### 13. ✅ Demo data has invalid costs
**Symptom:** 3 events with `provider_cost` of -$13K to -$30K from `openrouter/auto` model.
**Fix:** Added per-event cost guard (`cost < 0 || cost > 100`) in both `recalcLearnedModelCosts()` and `backfillMissingCosts()`. Rejects negative or absurd costs.

## Test Results Summary

| Step | Status | Notes |
|------|--------|-------|
| Clone + install | PASS | `pnpm.onlyBuiltDependencies` fix required for pnpm 10+ |
| Bootstrap + configs | PASS | Auto-creates from examples on first `pnpm dev` |
| Demo DB seed | PASS | Fixed empty-DB race condition |
| Gateway connection | PASS | After setting correct port in deck-config.json |
| Plugin install | PASS | `openclaw plugins install --link ./plugin` |
| Backfill | PASS | 52K events, 516 sessions, 1.2s, all steps completed |
| Sessions page | PASS | 19 agents visible (after auto-discovery fix) |
| Costs page | PASS | 6 agents with cost data |
| Logs page | PASS | Event stream flowing |
| Context monitoring | PASS | 475 sessions tracked |
| Gateway health | PASS | Connected indicator works (after SPA fallback fix) |

## Test Procedure for Jane

0. Verify OpenClaw: `openclaw --version` and `ls ~/.openclaw/agents/`
1. Find gateway port: `openclaw gateway status` (look for "port=XXXX")
2. `git clone git@github.com:hkochar/openclaw-deck-dev.git openclaw-deck`
3. `cd openclaw-deck`
4. `pnpm install`
5. `pnpm dev` (or `PORT=3001 pnpm dev` for custom port) — configs auto-created from examples
6. Open http://localhost:3000 — should see demo data
7. Edit `config/deck-config.json` — set `serviceUrls.gateway` to `http://127.0.0.1:YOUR_PORT`
8. Verify gateway indicator shows "Connected" (top-right)
9. Install plugin: `openclaw plugins install --link ./plugin && openclaw gateway restart`
10. Wait 10 seconds for plugin to load and register routes
11. Run backfill: `pnpm backfill`
12. Verify: agents page shows all your real agents (auto-discovered)
13. Verify: costs page shows token usage and spend
14. Verify: logs page shows historical sessions
15. Verify: sessions page shows context % for active sessions
