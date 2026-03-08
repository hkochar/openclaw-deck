# Deliverable Report: Learnings & Automation Guide

What we discovered building the Scout OSS Launch Research report. These rules should be codified into the report system so every deliverable gets an accurate report automatically.

## 1. Event Scoping — The Hardest Problem

### Problem: Session key fragmentation
The same agent's work appears under **multiple session keys simultaneously**:
- `scout/bf810c80-...345dd4.jsonl` — JSONL transcript session
- `scout/c900cf96-...8dca92.jsonl` — different JSONL transcript
- `agent:scout:discord:channel:1472394...` — Discord channel events
- `channel:1472394...` — legacy format
- `agent:scout:cron:...` — cron-triggered events

**Rule: Never filter by `agent + session`. Always filter by `agent + time window`.**

### Problem: Work window boundaries
A deliverable may be the final write-up of research done across multiple earlier deliverables. The narrow window (previous deliverable end → current deliverable end) only captures the write-up phase, missing all the research.

**Solution: "Work batch" detection.** Walk backwards through the agent's deliverables. If the gap between consecutive deliverables is < 6 hours, they're part of the same task. The analysis window starts 1 hour before the first deliverable in the batch.

```
Deliverable timeline for Scout OSS Launch Research:
  19:55  "Got your task, reading context..."     ← batch start
  20:32  "Caught up on inbox..."
  20:44  "Day 1 candidates complete"
  21:17  "Working memory update"
  22:23  "OSS Launch Research COMPLETE"
  23:37  "Launch Plan Delivered"                  ← this deliverable
         [2.3h gap]
  01:50  "ALL LAUNCH CONTENT COMPLETE"            ← separate batch
```

**Rule: Use batch detection, not single-session scoping.**

### Problem: Full agent lifetime pollution
Without a lower bound, queries pull in the agent's entire history (days/weeks of unrelated work), inflating search counts, tool calls, and costs.

**Rule: Always scope to the work batch. Never use `ts <= X` without a lower bound.**

## 2. Error Detection — The Boolean Bug

### Problem: `isErrorEvent` false positives
The gateway plugin logs `detail: { success: true }` (boolean `true`). But `isErrorEvent` checked `d.success !== 1` (number comparison). In JavaScript, `true !== 1` evaluates to `true`, so every successful tool call was counted as a failure.

**Impact:** Tool Efficiency showed 0/100 instead of 88/100. The critique said "many errors or failed tool calls" when there were only 2 actual errors in 129 calls.

**Fix:** Check both forms: `d.success !== true && d.success !== 1`

**The bug existed in TWO files:**
- `lib/session-intelligence.ts` — used for activity summary (tool breakdown success rates)
- `lib/run-intelligence.ts` — used for run summary (errorCount, retryCount, status)

Both had to be fixed. The run-intelligence version affects `retryCount` (which penalizes tool efficiency by 5 points per retry) and `status` (which affects task completion score).

**Rule: When fixing shared logic, grep for all copies. These modules have duplicated `isErrorEvent`, `parseDetail`, and `getToolName` functions.**

## 3. What Makes a Good Research Report

### What matters (show prominently):
1. **Quality scores** — the summary grade (overall + 5 dimensions)
2. **Assessment findings** — colored boxes at top: green (strengths), red (weaknesses), blue (suggestions)
3. **Research coverage stats** — searches, unique queries, pages fetched, domains, fetch ratio, files read
4. **Search queries** — the full numbered list shows methodology and systematic thinking
5. **Sources checked** — URLs with domains show breadth and credibility of sources

### What doesn't matter (hide or remove):
- **Work regions** — at this scale (20-428 regions), they're noise. Useful for session analysis, not deliverable reports.
- **Outcomes list** — already visible in the Detail tab
- **Files produced** — already in Detail tab

### Key metrics for research agents:
- **Fetch ratio** (pages fetched / searches) — most revealing metric. Scout had 18% — she searched 38 times but only read 7 pages. A thorough researcher would be 50-70%.
- **Unique queries vs total searches** — shows refinement. Scout: 23 unique / 38 total = ~1.6x, which is normal iterative refinement.
- **Domain diversity** — 4 unique domains is low. Good research covers 10+ sources.

### Score dimension weights for research agents:
- Research Depth: highest weight (this is their job)
- Tool Efficiency: medium weight
- Task Completion: medium weight
- Error Recovery: lower weight
- Cost Efficiency: lower weight

## 4. Data Quality Issues to Watch

### Missing LLM cost data
Some sessions have zero `llm_input`/`llm_output` events — only `tool_call` events were logged. This means:
- Cost shows $0.00 (misleading — it's not free, it's untracked)
- Token counts are low/zero
- Model info is missing

**Rule: When cost is $0 and tokens are low, the report should say "cost data not available" instead of "$0.00".**

### Tool call success field inconsistency
- Gateway plugin logs: `{ success: true }` (boolean)
- Some older events log: `{ success: 1 }` (number)
- Events without a detail field: no success info (should default to success, not error)

**Rule: Treat missing `success` field as success (not error). Only count as error when explicitly `success: false` or `success: 0` or `error` field is present.**

## 5. API Design Decisions

### Detail API (`/api/deliverables/[id]`)
- Shows "Research & sources" from full agent history up to deliverable end (broad context)
- Shows "Timeline" from narrow work window (just the write-up phase)
- Shows sibling deliverables within ±24h for same agent

### Analysis API (`/api/deliverables/[id]/analysis`)
- Computes scores from the work batch window (balanced scope)
- Returns source lists from the same scoped window (consistent with scores)
- Returns `runSummary` for cost/token info

The two APIs intentionally use different scoping because they serve different purposes:
- Detail tab: "show me everything that informed this deliverable" (broad)
- Report tab: "assess the quality of work for this task" (scoped)

## 6. Automation Checklist

To make reports work automatically for any deliverable:

- [x] Cross-session event scoping (query by agent + time, not session)
- [x] Work batch detection (walk backwards through deliverables, 6h gap threshold)
- [x] Fix isErrorEvent boolean check (both modules)
- [ ] Handle missing cost data gracefully ("not tracked" vs "$0.00")
- [ ] Handle agents with no prior deliverables (first-ever deliverable)
- [ ] Tune scoring weights per agent type (research vs code vs creative)
- [ ] Add "compared to baseline" context (this agent's average vs this deliverable)
- [ ] Surface tool breakdown with actual error details (which tools failed, why)
- [ ] Detect and flag "write-up only" deliverables vs "full research" deliverables
