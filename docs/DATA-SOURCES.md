# Deck — Data Sources Inventory

All data sources available in the Deck dashboard, their locations, schemas, and searchable fields.

---

## 1. SQLite Database (`~/.openclaw-deck/data/usage.db`)

### events (Core usage logs)
- **Written by:** Gateway plugin `logEvent()` in `plugin/event-log.ts`
- **Content:** LLM calls, tool invocations, cache reads/writes, operational events
- **Columns:** id, ts, agent, session, type, model, input_tokens, output_tokens, cache_read, cache_write, cost, detail (JSON), run_id, prompt, response, thinking, resolved_model, provider_cost, billing, tool_name, tool_query, tool_target
- **Indexes:** ts, agent+ts, run_id, tool_name, tool_name+agent
- **Searchable:** agent, tool_name, tool_query, tool_target, type, model, session
- **Volume:** 1000+ per agent per day, 30-day retention

### sessions (Agent conversation tracking)
- **Written by:** Poller syncs from `~/.openclaw/agents/{agentId}/sessions/sessions.json`
- **Content:** Session metadata, token counts, status
- **Columns:** id, session_key, agent, session_id, channel, model, total_tokens, input_tokens, output_tokens, context_tokens, display_name, label, group_channel, origin, compaction_count, transcript_size_kb, created_at, updated_at, status, archived_at, archive_file, source
- **Indexes:** agent, status, updated_at, source
- **Searchable:** agent, session_key, channel, status, source (agent/cron), display_name
- **Volume:** 100s-1000s per agent

### session_analysis (LLM-generated session summaries)
- **Written by:** `/api/logs/session-analysis/run` endpoint
- **Content:** Regions, outcomes, activity summary, quality scores, critique, LLM summary
- **Columns:** id, session_key, agent, agent_type, computed_at, events_max_id, guidelines, guidelines_hash, regions (JSON), outcomes (JSON), activity_summary (JSON), quality_scores (JSON), critique (JSON), llm_summary, llm_critique, llm_model
- **Indexes:** session_key, agent, session_key+guidelines_hash
- **Searchable:** session_key, agent, llm_summary, llm_critique
- **Volume:** 1 per session (on demand)

### session_feedback (User ratings & tags)
- **Written by:** User input via `/api/logs/session-analysis/feedback`
- **Content:** Rating (1-5), outcome quality, notes, tags
- **Columns:** id, session_key, created_at, rating, outcome_quality, notes, tags, flagged
- **Indexes:** session_key
- **Searchable:** session_key, notes, tags
- **Volume:** Optional, user-initiated

### deliverables (File/code outputs)
- **Written by:** Deliverable classifier from tool_call events
- **Content:** Grouped file writes, test runs, commits, searches
- **Columns:** id, agent, session, group_key, main_type, main_label, main_target, supporting (JSON), item_count, first_ts, last_ts, events_max_id, created_at, updated_at
- **Indexes:** agent, last_ts, group_key
- **Searchable:** agent, main_type, main_label, main_target, session
- **Volume:** 10-100 per agent per day

### heartbeats (Agent health status)
- **Written by:** Agents POST to `/api/heartbeat`
- **Content:** Current model, bio, status, last heartbeat
- **Columns:** id, agent_key, status, model, configured_model, session_key, cron_model, cron_model_updated_at, bio, last_heartbeat, updated_at
- **Indexes:** agent_key (unique)
- **Searchable:** agent_key, status, model, bio
- **Volume:** 1 per agent

### drift_events (Model configuration drift)
- **Written by:** Heartbeat system when actual_model ≠ configured_model
- **Content:** Model mismatch events with resolution status
- **Columns:** id, agent_key, configured_model, actual_model, tag, timestamp, resolved, resolved_at
- **Indexes:** agent_key+timestamp, resolved+timestamp
- **Searchable:** agent_key, configured_model, actual_model, resolved
- **Volume:** Sporadic

### agent_activities (Activity feed)
- **Written by:** `logActivity()` from gateway plugin
- **Content:** Agent events (started, paused, error, status changes)
- **Columns:** id, type, agent_key, agent_name, message, timestamp
- **Indexes:** timestamp
- **Searchable:** type, agent_key, agent_name, message
- **Volume:** ~50/day

### backfill_meta (Migration tracking)
- **Content:** Completion status of one-time migrations
- **Columns:** key (PRIMARY), value, ts
- **Volume:** ~10-20 entries (internal, not user-searchable)

---

## Data Pipeline: Live Plugin vs Backfill

Data enters the SQLite database through two independent paths:

### Live Plugin (real-time)

The gateway plugin (`plugin/index.ts`) hooks into OpenClaw's event lifecycle and writes events to SQLite as they happen. This is the primary data path once installed.

- **Captures:** All LLM calls, tool invocations, user messages, heartbeats, drift alerts, agent activities
- **Sets:** `prompt` column directly, billing, provider_cost, session channel/model from gateway context
- **Populates:** heartbeats, drift_events, agent_activities, deliverables, search_idx (FTS5)
- **Start collecting:** Install the plugin and restart the gateway

### Backfill Script (historical recovery)

The backfill script (`scripts/backfill-all.ts`) parses JSONL transcript files from disk to recover events from sessions that occurred before the plugin was installed.

- **Source:** `~/.openclaw/agents/*/sessions/*.jsonl` transcript files
- **Captures:** LLM calls, tool calls, user messages (same event types as live plugin)
- **Sets:** `promptPreview` in detail JSON (not `prompt` column), billing from model family, provider_cost from token counts + pricing table
- **Does not populate:** heartbeats, drift_events, agent_activities, deliverables, search_idx
- **Session channel:** Defaults to "main" (transcript filenames don't encode channel info)
- **Run:** `pnpm backfill` (idempotent — safe to run repeatedly)

### Overlap behavior

When both paths capture the same session, the backfill skips it (events already exist). The live plugin's data takes priority because it has richer context from the gateway (exact channel, session metadata, real-time prompt capture).

---

## 2. Filesystem Data Sources

### Session Transcripts
- **Location:** `~/.openclaw/agents/{agentId}/sessions/*.jsonl`
- **Content:** Full conversation turn-by-turn transcripts with tool calls, thinking, responses
- **Format:** Line-delimited JSON (`{ type, agent, session_key, model, ts, thinking, response, ... }`)
- **Searchable:** Full text of thinking, response, tool arguments
- **Volume:** 1-5 MB per session

### Session Store Metadata
- **Location:** `~/.openclaw/agents/{agentId}/sessions/sessions.json`
- **Content:** Active sessions index with channel, model, token counts
- **Format:** JSON array of `{ sessionId, updatedAt, channel, groupChannel, displayName, model, totalTokens, ... }`
- **Volume:** 100s of entries per agent

### OpenClaw Config
- **Location:** `~/.openclaw/openclaw.json`
- **Content:** Global agent configuration, models, channels, service URLs
- **Searchable:** Agent IDs, channel names, model names
- **Volume:** ~50 KB

### Cron Jobs
- **Location:** `~/.openclaw/cron/jobs.json`
- **Content:** Scheduled jobs with agent, schedule expression, command, model
- **Searchable:** Job ID, agent, schedule expression, command text
- **Volume:** <100 KB

### Exec Approvals
- **Location:** `~/.openclaw/exec-approvals.json`
- **Content:** Approval rules for shell command execution
- **Searchable:** Socket names, approval status
- **Volume:** <50 KB

### Update Checks
- **Location:** `~/.openclaw/update-check.json`
- **Content:** Version tracking, last check timestamp
- **Volume:** <5 KB (low search value)

### Environment Secrets
- **Location:** `~/.openclaw/.env`
- **Content:** Provider tokens, API keys (REDACTED in UI)
- **Note:** Never index or expose in search results
- **Volume:** <5 KB

### Agent Documentation
- **Location:** `~/.openclaw/workspace/docs/` and agent-specific dirs
- **Content:** Agent personas, instructions, operational docs
- **Format:** Markdown files
- **Searchable:** File names, headings, full markdown content
- **Volume:** 1-50 MB per agent

### Agent Memory
- **Location:** `~/.openclaw/workspace/{agent-dir}/memory/`
- **Content:** Learned patterns, decisions, follow-ups
- **Format:** Markdown files
- **Searchable:** File names, headings, content
- **Volume:** 100 KB - 10 MB per agent

### Knowledge Bases
- **Location:** `~/.openclaw/workspace/knowledge/`
- **Content:** Reference docs, procedures, FAQs
- **Format:** Markdown files
- **Searchable:** File names, headings, content
- **Volume:** 1-50 MB total

---

## 3. Deck Config Files

### deck-agents.json
- **Location:** `config/deck-agents.json` (in Deck repo)
- **Content:** Agent roster with key, id, name, emoji, role, discordUserId, channelId
- **Searchable:** Agent name, role, key
- **Volume:** <10 KB

### deck-config.json
- **Location:** `config/deck-config.json` (in Deck repo)
- **Content:** systemChannels, pluginChannels, logChannels, serviceUrls, budgets (global limits, per-agent, provider keys, rate limits, pricing), modelPricing, throttleChain, providerKeys, providerLimits
- **Searchable:** Service names, channel names, provider names
- **Volume:** ~20-50 KB

---

## 4. Data Relationships

```
sessions.session_key ←→ events.session
sessions.session_key ←→ session_analysis.session_key
sessions.session_key ←→ session_feedback.session_key
sessions.agent       ←→ heartbeats.agent_key
events.agent+session ←→ deliverables.agent+session
drift_events.agent_key ←→ heartbeats.agent_key
events.run_id        ←→ cross-event correlation (LLM runs)
```

---

## 5. API Endpoints (grouped by data domain)

### Events & Logs
- `GET /api/logs` (stream, summary, poller-status)
- `GET /api/logs/session-analysis` / `POST run` / `POST feedback`
- `GET /api/logs/session-summary`
- `GET /api/system-log`

### Sessions & Replay
- `GET /api/agent-sessions`
- `GET /api/outcomes`
- `GET /api/deliverables` / `GET /api/deliverables/[id]` / `GET /api/deliverables/[id]/analysis`

### Costs & Budget
- `GET /api/agent-costs` (summary + timeline)
- `GET /api/provider-costs`
- `POST /api/budget-override`
- `GET /api/provider-limits`

### Agents & Health
- `GET /api/agents`
- `GET /api/activities`
- `GET /api/activity-daily` / `activity-day-sessions` / `activity-week-sessions`
- `POST /api/heartbeat`
- `GET /api/drift` / `POST drift/report` / `POST drift/resolve`

### Configuration
- `GET/POST /api/config` (openclaw.json, cron, exec-approvals)
- `GET /api/config-history`
- `GET/POST /api/deck-config`
- `GET /api/deck-config/raw` / `GET /api/deck-config/env`

### System
- `GET /api/gateway-health` / `GET /api/gateway-control`
- `POST /api/service-control`
- `GET /api/services`
- `GET /api/crons` / `POST /api/cron-manage` / `POST /api/cron-model`
- `GET /api/models-list` / `POST /api/model-swap`
- `GET /api/usage`
